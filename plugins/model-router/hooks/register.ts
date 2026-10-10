import type { EngineInterface, Register } from 'claude-code'

import {
  applySticky,
  CLASSIFIER_PROMPT,
  classifyHeuristic,
  costUsd,
  EFFORT,
  MODEL_ID,
  parseOverride,
  promptTokens,
  resolveTtls,
  tierForSubagent,
  tierOfModel,
  TIERS,
  type CacheTtl,
  type Tier,
  type Usage,
  type Verdict,
} from './policy'

type Decision = { tier: Tier; why: string }

type Ledger = Record<Tier, { steps: number; usage: Usage; usd: number }> & {
  allOpusUsd: number
}

const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const newLedger = (): Ledger => ({
  haiku: { steps: 0, usage: emptyUsage(), usd: 0 },
  sonnet: { steps: 0, usage: emptyUsage(), usd: 0 },
  opus: { steps: 0, usage: emptyUsage(), usd: 0 },
  allOpusUsd: 0,
})

const usd = (n: number) => `$${n.toFixed(4)}`

const cfg = {
  mainRouting: 'route',
  classifier: 'hybrid',
  stickyTokens: 40000,
  subagentRouting: true,
  report: 'turn',
}

// Module state: starts over on a reload, which is fine for a ledger.
let pendingOverride: Tier | undefined
let lastMainTier: Tier | undefined
let lastMainContext = 0
const decisions = new Map<string, Promise<Decision>>()
const turnUsd = new Map<string, number>()
let ledger = newLedger()
// Cache-write TTLs, read from the environment at session start.
let ttl: { main: CacheTtl; other: CacheTtl } = { main: '1h', other: '5m' }

async function askHaiku($: EngineInterface, text: string): Promise<Tier | undefined> {
  const r = await $.model.complete({
    model: MODEL_ID.haiku,
    system: CLASSIFIER_PROMPT,
    prompt: `${text.slice(0, 4000)}\n\nAnswer with one word: haiku, sonnet or opus.`,
    maxTokens: 200,
    effort: 'low',
    timeoutMs: 5000,
  })
  if (!r.isAnswered) return undefined
  record(MODEL_ID.haiku, r.usage, ttl.other)
  return TIERS.find(t => r.text.toLowerCase().includes(t))
}

async function decide($: EngineInterface, text: string): Promise<Decision> {
  if (pendingOverride) {
    const tier = pendingOverride
    pendingOverride = undefined
    return { tier, why: 'override' }
  }
  // A continuation (no typed text) stays where the conversation is.
  if (text.trim() === '' && lastMainTier) return { tier: lastMainTier, why: 'continuation' }

  let verdict: Verdict = classifyHeuristic(text)
  if (cfg.classifier === 'haiku' || (cfg.classifier === 'hybrid' && !verdict.isSure)) {
    const asked = await askHaiku($, text).catch(() => undefined)
    if (asked) verdict = { tier: asked, isSure: true, why: `haiku said ${asked}` }
  }
  const held = applySticky(verdict.tier, lastMainTier, lastMainContext, cfg.stickyTokens)
  return held.isHeld
    ? { tier: held.tier, why: `${verdict.why}; held at ${held.tier} (${lastMainContext} tok cached)` }
    : { tier: held.tier, why: verdict.why }
}

function record(model: string, u: Usage, writeTtl: CacheTtl, turnId?: string) {
  const tier = tierOfModel(model)
  if (!tier) return
  const cost = costUsd(tier, u, writeTtl)
  const row = ledger[tier]
  row.steps += 1
  row.usd += cost
  for (const k of Object.keys(row.usage) as (keyof Usage)[]) row.usage[k] += u[k]
  ledger.allOpusUsd += costUsd('opus', u, writeTtl)
  if (turnId) turnUsd.set(turnId, (turnUsd.get(turnId) ?? 0) + cost)
}

export const register: Register = (on, options) => {
  cfg.mainRouting = String(options.mainRouting ?? 'route')
  cfg.classifier = String(options.classifier ?? 'hybrid')
  cfg.stickyTokens = Number(options.stickyContextTokens ?? 40000)
  cfg.subagentRouting = options.subagentRouting !== false
  cfg.report = String(options.report ?? 'turn')

  on('session.start', async ($, e, next) => {
    ttl = resolveTtls({
      FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
      ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
      ANTHROPIC_API_KEY: await $.env.get('ANTHROPIC_API_KEY'),
    })
    await $.command.register({
      name: 'router-stats',
      description: 'Show model-router tiers, tokens and estimated cost for this session',
    })
    return next(e)
  })

  on('command.run', { command: 'router-stats' }, async () => {
    const lines = TIERS.map(t => {
      const r = ledger[t]
      return `${t.padEnd(6)} steps=${r.steps} in=${r.usage.input_tokens} cacheRead=${r.usage.cache_read_input_tokens} cacheWrite=${r.usage.cache_creation_input_tokens} out=${r.usage.output_tokens} ${usd(r.usd)}`
    })
    const total = TIERS.reduce((s, t) => s + ledger[t].usd, 0)
    lines.push(
      `total ${usd(total)} vs same tokens on Opus ${usd(ledger.allOpusUsd)} (estimate; list prices)`,
    )
    lines.push(`config ${JSON.stringify(cfg)} cacheTtl ${JSON.stringify(ttl)}`)
    return { text: lines.join('\n') }
  })

  // "[opus] fix this" forces a tier for one turn; the tag never reaches the model.
  on('prompt.submit', ($, e, next) => {
    const { tier, text } = parseOverride(e.text)
    if (!tier) return next(e)
    pendingOverride = tier
    return next({ ...e, text })
  })

  on('turn.start', ($, e, next) => {
    if (cfg.mainRouting === 'route') decisions.set(e.turnId, decide($, e.text))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagent steps: their model was settled at agent.spawn; just account.
    if (e.agentId || cfg.mainRouting !== 'route') {
      const r = yield* next(e)
      if (r.usage) record(r.usage.model, r.usage, e.agentId ? ttl.other : ttl.main, e.turnId)
      return r
    }

    const pending = decisions.get(e.turnId)
    const d = pending ? await pending.catch(() => undefined) : undefined
    const tier = d?.tier ?? lastMainTier
    let step = e
    if (tier) {
      const model = MODEL_ID[tier]
      // Keep the session's effort on its own model; set ours on the others.
      const effort = tierOfModel(e.model) === tier ? e.effort : EFFORT[tier]
      step = { ...e, model, effort }
    }

    const r = yield* next(step)
    if (r.usage) {
      record(r.usage.model, r.usage, ttl.main, e.turnId)
      lastMainContext = promptTokens(r.usage)
    }
    if (tier) lastMainTier = tier
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && cfg.mainRouting === 'route') {
      const d = await decisions.get(e.turnId)?.catch(() => undefined)
      decisions.delete(e.turnId)
      if (cfg.report === 'turn' && d) {
        const spent = turnUsd.get(e.turnId) ?? 0
        $.ui.log(`model-router: ${d.tier} (${d.why}) · turn ${usd(spent)}`)
      }
      turnUsd.delete(e.turnId)
    }
    return next(e)
  })

  on('agent.spawn', ($, e, next) => {
    // The caller (or the SDK host's agent definition) named a model: respect it.
    if (!cfg.subagentRouting || e.model || e.workflow) return next(e)
    const tier = tierForSubagent(e.subagentType, e.description, e.prompt)
    return tier ? next({ ...e, model: MODEL_ID[tier] }) : next(e)
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') {
      ledger = newLedger()
      lastMainTier = undefined
      lastMainContext = 0
    }
    return next(e)
  })
}
