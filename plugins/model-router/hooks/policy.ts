// Pure routing and pricing rules: no `$`, so tests and the hooks share them.

export type Tier = 'haiku' | 'sonnet' | 'opus'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export const MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

// Effort sent with each tier on the main loop. Lower effort on the cheaper
// tiers keeps simple turns short; Opus is only chosen for hard turns.
export const EFFORT: Record<Tier, 'low' | 'medium' | 'high'> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
}

export const rank = (t: Tier) => TIERS.indexOf(t)

export const tierOfModel = (model: string): Tier | undefined =>
  TIERS.find(t => model.includes(t))

// --- Prompt override: "[opus] ...", "[sonnet] ...", "[haiku] ..." ----------

const OVERRIDE = /^\s*\[(haiku|sonnet|opus)\]\s*/i

export const parseOverride = (text: string): { tier?: Tier; text: string } => {
  const m = OVERRIDE.exec(text)
  if (!m) return { text }
  return { tier: m[1]!.toLowerCase() as Tier, text: text.slice(m[0].length) }
}

// --- Heuristic classifier --------------------------------------------------

const HARD = [
  /設計|アーキテクチャ|architect|design/i,
  /リファクタ|refactor/i,
  /デバッグ|debug|原因|root cause|なぜ|why\b/i,
  /競合|race|deadlock|並行|concurren/i,
  /セキュリティ|security|脆弱/i,
  /レビュー|review/i,
  /移行|migrat/i,
  /最適化|性能|パフォーマンス|performance|optimi[sz]/i,
  /トレードオフ|trade-?off|比較検討/i,
  /実装して|implement|build\b|作って/i,
]

const EASY = [
  /一覧|列挙|\blist\b|\bls\b/i,
  /typo|誤字|rename|名前を変え/i,
  /整形|format|lint/i,
  /翻訳|translate/i,
  /要約|summari[sz]e/i,
  /とは[?？]?$|what is|教えて$/i,
  /探して|検索|find\b|grep|where is|どこ/i,
  /表示して|見せて|show me|print\b|\bcat\b/i,
  /コミットメッセージ|commit message/i,
]

export type Verdict = { tier: Tier; isSure: boolean; why: string }

export const classifyHeuristic = (text: string): Verdict => {
  const hard = HARD.filter(r => r.test(text)).length
  const easy = EASY.filter(r => r.test(text)).length
  const len = text.length
  const codeBlocks = (text.match(/```/g)?.length ?? 0) / 2

  if (hard >= 2 || (hard >= 1 && (len > 600 || codeBlocks >= 1)) || len > 2500)
    return { tier: 'opus', isSure: true, why: `hard signals=${hard}, ${len} chars` }
  if (easy >= 1 && hard === 0 && len < 200)
    return { tier: 'haiku', isSure: true, why: `easy signals=${easy}, ${len} chars` }
  if (hard === 0 && easy === 0 && len < 20)
    return { tier: 'haiku', isSure: false, why: `short, no signals` }
  return { tier: hard >= 1 ? 'opus' : 'sonnet', isSure: false, why: `hard=${hard} easy=${easy}` }
}

export const CLASSIFIER_PROMPT = [
  'Pick the cheapest model tier that will still do this coding-agent request well.',
  'haiku: lookups, listing, small mechanical edits, short factual answers.',
  'sonnet: ordinary feature work, bug fixes with a clear cause, tests, docs.',
  'opus: design, tricky debugging, security, large refactors, ambiguous or high-stakes work.',
  'Request:',
].join('\n')

// --- Stickiness ------------------------------------------------------------

// A model switch on the main loop forfeits its prompt cache (caches are
// per-model): the whole prompt is written again on the new model. Stepping up
// is worth that for quality; stepping down is only worth it while the prompt
// is still small, so past `stickyTokens` the main loop never steps down.
export const applySticky = (
  wanted: Tier,
  previous: Tier | undefined,
  contextTokens: number,
  stickyTokens: number,
): { tier: Tier; isHeld: boolean } => {
  if (previous && rank(wanted) < rank(previous) && contextTokens >= stickyTokens)
    return { tier: previous, isHeld: true }
  return { tier: wanted, isHeld: false }
}

// --- Subagents -------------------------------------------------------------

// Built-in agent types the router assigns a tier to; any other type (an SDK
// host's own `agents`, a plugin's) keeps the model its definition names.
const AGENT_TIER: Record<string, Tier> = {
  Explore: 'haiku',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'haiku',
  'general-purpose': 'sonnet',
  Plan: 'opus',
}

export const tierForSubagent = (
  subagentType: string,
  description: string,
  prompt: string,
): Tier | undefined => {
  const base = AGENT_TIER[subagentType]
  if (!base) return undefined
  // A read-only scout stays on Haiku; a worker asked for hard work steps up.
  if (base === 'sonnet' && classifyHeuristic(`${description}\n${prompt}`).tier === 'opus')
    return 'opus'
  return base
}

// --- Pricing (USD per million tokens, first-party API, 2026-10) ------------

type Price = { input: number; output: number; cacheRead: number }

const PRICE: Record<Tier, Price> = {
  opus: { input: 4, output: 20, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01 },
}
// Haiku 5.5 bills prompts over 100K tokens at $0.50 / $2.50.
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05 }

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const promptTokens = (u: Usage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export const costUsd = (tier: Tier, u: Usage): number => {
  const p = tier === 'haiku' && promptTokens(u) > 100_000 ? HAIKU_LONG : PRICE[tier]
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * 1.25 +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  )
}
