import type { EngineInterface, Register } from 'claude-code'

import {
  CLASSIFIER_PROMPT,
  classifyHeuristic,
  costUsd,
  delegationSection,
  DOC_WRITER,
  DOC_WRITER_PROMPT,
  escalate,
  FAILURES_TO_ESCALATE,
  isFailure,
  MODEL_ID,
  parseKind,
  parseOverride,
  PLUGIN,
  promptTokens,
  resolveTtls,
  routeFor,
  ROUTES,
  TEST_RUNNER,
  TEST_RUNNER_PROMPT,
  tierForSubagent,
  tierOfModel,
  TIERS,
  type Base,
  type CacheTtl,
  type DocsMode,
  type Kind,
  type Route,
  type Tier,
  type Usage,
  type Verdict,
} from './policy'

type Decision = { route: Route; kind?: Kind; why: string }

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
  base: 'sonnet' as Base,
  docs: 'delegate' as DocsMode,
  subagentRouting: true,
  delegate: true,
  report: 'turn',
}

// Module state: starts over on a reload, which is fine for a ledger.
let pendingOverride: Tier | undefined
let lastMainRoute: Route | undefined
let isPlanning = false
// The main loop's turn in progress: tool calls carry no turn id, and main turns run one at a time.
let mainTurn: string | undefined
const decisions = new Map<string, Promise<Decision>>()
// Failures seen in a turn's tool results, and the route the turn escalated to.
const failures = new Map<string, number>()
const escalated = new Map<string, Route>()
const turnUsd = new Map<string, number>()
let ledger = newLedger()
// Cache-write TTLs, read from the environment at session start.
let ttl: { main: CacheTtl; other: CacheTtl } = { main: '1h', other: '5m' }

async function askHaiku($: EngineInterface, text: string): Promise<Kind | undefined> {
  const r = await $.model.complete({
    model: MODEL_ID.haiku,
    system: CLASSIFIER_PROMPT,
    prompt: `${text.slice(0, 4000)}\n\nAnswer with one word: lookup, work, fix, plan, docs or hard.`,
    maxTokens: 200,
    effort: 'low',
    timeoutMs: 5000,
  })
  if (!r.isAnswered) return undefined
  record(MODEL_ID.haiku, r.usage, ttl.other)
  return parseKind(r.text)
}

async function decide($: EngineInterface, text: string): Promise<Decision> {
  if (pendingOverride) {
    const tier = pendingOverride
    pendingOverride = undefined
    return { route: { tier, effort: 'medium' }, why: 'override' }
  }
  // A continuation (no typed text) stays where the conversation is.
  if (text.trim() === '' && lastMainRoute) return { route: lastMainRoute, why: 'continuation' }

  let verdict: Verdict = classifyHeuristic(text)
  if (cfg.classifier === 'haiku' || (cfg.classifier === 'hybrid' && !verdict.isSure)) {
    const asked = await askHaiku($, text).catch(() => undefined)
    if (asked) verdict = { kind: asked, isSure: true, why: `haiku said ${asked}` }
  }
  return { route: routeFor(verdict.kind, cfg.base, cfg.docs), kind: verdict.kind, why: verdict.why }
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
  cfg.base = options.base === 'haiku' ? 'haiku' : 'sonnet'
  cfg.docs = options.docs === 'switch' ? 'switch' : 'delegate'
  cfg.subagentRouting = options.subagentRouting !== false
  cfg.delegate = options.delegate !== false
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
    if (cfg.delegate) {
      if (cfg.docs === 'delegate')
        await $.agent.register({
          name: DOC_WRITER,
          description: 'Writes or updates one document for people (requirements, design, specification, report, README) from the sources it is given.',
          prompt: DOC_WRITER_PROMPT,
          tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
          model: MODEL_ID.opus,
          effort: 'medium',
        })
      await $.agent.register({
        name: TEST_RUNNER,
        description: 'Runs a test suite or command and reports pass and fail counts and the failing tests. Changes no file.',
        prompt: TEST_RUNNER_PROMPT,
        tools: ['Bash', 'Read', 'Glob', 'Grep'],
        model: MODEL_ID.haiku,
        effort: 'low',
      })
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!cfg.delegate || cfg.mainRouting !== 'route') return r
    return { sections: [...r.sections, { id: `${PLUGIN}:delegation`, text: delegationSection(cfg.docs), scope: 'session' as const }] }
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

    mainTurn = e.turnId
    const pending = decisions.get(e.turnId)
    const d = pending ? await pending.catch(() => undefined) : undefined
    // Planning mode is Opus until ExitPlanMode; failures escalate the rest of the turn.
    const route = escalated.get(e.turnId) ?? (isPlanning ? ROUTES[cfg.base].plan : undefined) ?? d?.route ?? lastMainRoute
    const step = route ? { ...e, model: MODEL_ID[route.tier], effort: route.effort } : e

    const r = yield* next(step)
    if (r.usage) record(r.usage.model, r.usage, ttl.main, e.turnId)
    if (route) lastMainRoute = route
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || cfg.mainRouting !== 'route') return r
    if (e.tool === 'EnterPlanMode') isPlanning = true
    if (e.tool === 'ExitPlanMode' && !r.deny) isPlanning = false
    const turnId = mainTurn
    if (turnId && !r.deny && isFailure(r.isError, r.text)) {
      const n = (failures.get(turnId) ?? 0) + 1
      failures.set(turnId, n)
      if (n >= FAILURES_TO_ESCALATE && !escalated.has(turnId)) {
        const base = (await decisions.get(turnId)?.catch(() => undefined))?.route ?? lastMainRoute ?? ROUTES[cfg.base].work
        escalated.set(turnId, escalate(base))
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && cfg.mainRouting === 'route') {
      const d = await decisions.get(e.turnId)?.catch(() => undefined)
      const up = escalated.get(e.turnId)
      if (cfg.report === 'turn' && d) {
        const spent = turnUsd.get(e.turnId) ?? 0
        const what = d.kind ? `${d.kind} → ${d.route.tier}/${d.route.effort}` : `${d.route.tier}/${d.route.effort}`
        $.ui.log(`model-router: ${what} (${d.why})${up ? `; escalated to ${up.tier}/${up.effort}` : ''} · turn ${usd(spent)}`)
      }
      if (mainTurn === e.turnId) mainTurn = undefined
      decisions.delete(e.turnId)
      failures.delete(e.turnId)
      escalated.delete(e.turnId)
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
      lastMainRoute = undefined
      isPlanning = false
    }
    return next(e)
  })
}
