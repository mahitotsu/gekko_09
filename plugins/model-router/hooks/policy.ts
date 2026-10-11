// Pure routing and pricing rules: no `$`, so tests and the hooks share them.
//
// v2 (docs/plan.md, P3): Sonnet carries long work; Haiku takes short,
// standalone jobs (lookups, the router's own judgment, subagent scouting),
// since on long agentic work it is slower than Sonnet; Opus takes planning,
// documents for people, and turns that keep failing.

export type Tier = 'haiku' | 'sonnet' | 'opus'

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']

export const MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

export type Effort = 'low' | 'medium' | 'high'

export type Route = { tier: Tier; effort: Effort }

export const rank = (t: Tier) => TIERS.indexOf(t)

export const tierOfModel = (model: string): Tier | undefined =>
  TIERS.find(t => model.includes(t))

// --- Turn kinds and the tier table (P1) --------------------------------------

// lookup: answer a value or a place; work: implement or change code;
// fix: a bug fix where verification matters; plan: planning or design
// thinking; docs: a document for people (requirements, design, spec, report);
// hard: complex reasoning (concurrency, security, a cause nobody has found).
export type Kind = 'lookup' | 'work' | 'fix' | 'plan' | 'docs' | 'hard'

export const KINDS: readonly Kind[] = ['lookup', 'work', 'fix', 'plan', 'docs', 'hard']

// base: the tier long work runs on. sonnet is the default; haiku is the
// comparison arm that starts low and escalates.
export type Base = 'sonnet' | 'haiku'

export const ROUTES: Record<Base, Record<Kind, Route>> = {
  sonnet: {
    lookup: { tier: 'haiku', effort: 'low' },
    work: { tier: 'sonnet', effort: 'medium' },
    fix: { tier: 'sonnet', effort: 'high' },
    plan: { tier: 'opus', effort: 'medium' },
    docs: { tier: 'opus', effort: 'medium' },
    hard: { tier: 'opus', effort: 'high' },
  },
  haiku: {
    lookup: { tier: 'haiku', effort: 'low' },
    work: { tier: 'haiku', effort: 'medium' },
    fix: { tier: 'sonnet', effort: 'high' },
    plan: { tier: 'opus', effort: 'medium' },
    docs: { tier: 'opus', effort: 'medium' },
    hard: { tier: 'opus', effort: 'high' },
  },
}

// docs: switch moves the main loop to Opus for a document turn; delegate
// keeps the main loop on its work tier and asks it to hand the writing to
// the Opus doc-writer subagent, so the main cache survives and a one-turn
// job (plan, build, report in one request) still gets its documents on Opus.
export type DocsMode = 'switch' | 'delegate'

export const routeFor = (kind: Kind, base: Base, docs: DocsMode): Route =>
  kind === 'docs' && docs === 'delegate' ? ROUTES[base].work : ROUTES[base][kind]

// Stepping down to Haiku for one short turn costs more than staying: Haiku
// writes the whole conversation (2x input on the 1-hour TTL, and 5x prices
// past 100K) where the current tier reads it from cache at 0.05x. So a
// lookup goes to Haiku only on a small conversation or when Haiku already
// holds it; otherwise it stays on the current tier at low effort.
export const HAIKU_SWITCH_MAX_TOKENS = 20_000

export const keepCacheForLookup = (route: Route, previous: Tier | undefined, contextTokens: number): Route =>
  route.tier === 'haiku' && previous && previous !== 'haiku' && contextTokens >= HAIKU_SWITCH_MAX_TOKENS
    ? { tier: previous, effort: 'low' }
    : route

// --- Prompt override: "[opus] ...", "[sonnet] ...", "[haiku] ..." ----------

const OVERRIDE = /^\s*\[(haiku|sonnet|opus)\]\s*/i

export const parseOverride = (text: string): { tier?: Tier; text: string } => {
  const m = OVERRIDE.exec(text)
  if (!m) return { text }
  return { tier: m[1]!.toLowerCase() as Tier, text: text.slice(m[0].length) }
}

// --- Heuristic classifier --------------------------------------------------

// A document turn names a document (or a .md path) and asks for it to be
// written: "docs/design.md に沿って実装して" names one but builds code.
const DOC_NOUN = [
  /要件定義|要件を|仕様書|設計書|報告書|手順書|説明書|議事録|README|ドキュメント|文書/i,
  /\b(spec|report|requirements|write-?up)\b/i,
  /[\w./-]+\.md\b/i,
]
const DOC_WRITE = /(に|を|へ)(まとめ|書い|書き|書く|作成|記述|追記|更新|起こ)|\b(write|draft|document)\b/i

const SIGNALS: Record<Exclude<Kind, 'work' | 'docs'>, RegExp[]> = {
  plan: [
    /設計|アーキテクチャ|architect|\bdesign\b/i,
    /計画|方針|進め方|段取り|\bplan\b/i,
    /トレードオフ|trade-?off|比較検討|案を(出|比べ)/i,
  ],
  hard: [
    /競合|race|deadlock|並行|concurren/i,
    /セキュリティ|security|脆弱/i,
    /原因(が|は)?(分から|わから|不明)|root cause|再現しない|flaky/i,
    /移行|migrat/i,
  ],
  fix: [
    /不具合|バグ|\bbug\b|直して|修正して|fix\b/i,
    /失敗(する|して)|落ちる|エラーが出|壊れ/,
  ],
  lookup: [
    /一覧|列挙|\blist\b|\bls\b/i,
    /どこ|where is|探して|検索|grep|find\b/i,
    /とは[?？]?$|what is|教えて(ください)?[。.]?$|ですか[?？]?$/i,
    /表示して|見せて|show me|print\b|\bcat\b/i,
  ],
}

const WORK = [/実装|追加|変更|作って|書き換え|リファクタ|refactor|implement|build\b|テストを(書|足)/i]

export type Verdict = { kind: Kind; isSure: boolean; why: string }

const hits = (rs: RegExp[], text: string) => rs.filter(r => r.test(text)).length

export const classifyHeuristic = (text: string): Verdict => {
  const n = {
    docs: hits(DOC_NOUN, text) > 0 && DOC_WRITE.test(text) ? 1 : 0,
    plan: hits(SIGNALS.plan, text),
    hard: hits(SIGNALS.hard, text),
    fix: hits(SIGNALS.fix, text),
    lookup: hits(SIGNALS.lookup, text),
    work: hits(WORK, text),
  }
  const len = text.length
  const why = `docs=${n.docs} plan=${n.plan} hard=${n.hard} fix=${n.fix} lookup=${n.lookup} work=${n.work}, ${len} chars`

  // A document to write wins over the rest: it is where Opus showed a
  // difference (P3, compare-docs). Writing a design document is docs too.
  if (n.docs >= 1 && n.lookup === 0) return { kind: 'docs', isSure: true, why }
  if (n.hard >= 1) return { kind: 'hard', isSure: n.hard >= 2 || len > 400, why }
  if (n.plan >= 1 && n.work === 0 && n.fix === 0) return { kind: 'plan', isSure: n.plan >= 2, why }
  if (n.fix >= 1) return { kind: 'fix', isSure: n.plan === 0, why }
  if (n.lookup >= 1 && n.work === 0 && n.plan === 0 && len < 200) return { kind: 'lookup', isSure: true, why }
  if (n.work >= 1 && n.plan === 0) return { kind: 'work', isSure: len < 1500, why }
  return { kind: 'work', isSure: false, why }
}

export const CLASSIFIER_PROMPT = [
  'Classify one request to a coding agent by the kind of work it asks for.',
  'lookup: answer a value, a name or a place; list or show something. Nothing to build.',
  'work: implement, change or extend code with a clear goal.',
  'fix: a bug or failing test to fix, where checking the fix matters.',
  'plan: planning, design decisions, comparing approaches; no document to hand over.',
  'docs: write or update a document for people (requirements, design document, specification, report, README).',
  'hard: complex reasoning: concurrency, security, a cause nobody has found yet, a risky migration.',
  'Request:',
].join('\n')

export const parseKind = (answer: string): Kind | undefined => {
  const words: string[] = answer.toLowerCase().match(/[a-z]+/g) ?? []
  return KINDS.find(k => words.includes(k))
}

// --- Escalation on failure -------------------------------------------------

// What a test run's output says: failing tests, all passing, or neither (not
// a test run). Exit codes are not read: a CLI that exits 2 on bad input is
// doing its job, and a denied command never ran (P4 check, 2026-10-12).
const FAILING_TESTS = [
  /^\s*[✖✗×]\s/m,
  /^# fail [1-9]/m,
  /^ℹ fail [1-9]/m,
  /\b[1-9]\d* (failing|failed)\b/i,
  /^FAIL\b/m,
  /Tests?:\s+[1-9]\d* failed/i,
]
const PASSING_TESTS = [/^[ℹ#] fail 0\b/m, /\b\d+ passing\b/, /^PASS\b/m, /Tests?:\s+\d+ passed/i]

export type TestOutcome = 'fail' | 'pass' | undefined

export const testOutcome = (text: string | undefined): TestOutcome => {
  if (text === undefined) return undefined
  if (FAILING_TESTS.some(r => r.test(text))) return 'fail'
  if (PASSING_TESTS.some(r => r.test(text))) return 'pass'
  return undefined
}

// Test runs that fail this many times in a row, with no passing run between,
// step the rest of the turn up. Failing tests are normal while code is being
// written, so a short streak is not enough.
export const FAILURES_TO_ESCALATE = 3

// on: escalate; log: only note in the turn's log line that it would have, to
// learn from runs whether escalating would help before it acts.
export type EscalationMode = 'on' | 'log'

// One tier up, effort high; Opus stays Opus.
export const escalate = (r: Route): Route => ({
  tier: TIERS[Math.min(rank(r.tier) + 1, TIERS.length - 1)]!,
  effort: 'high',
})

// --- Subagents -------------------------------------------------------------

// Agent types the router registers. Names are the plugin's, so the full type
// is `model-router:<name>`.
export const PLUGIN = 'model-router'

export const DOC_WRITER = 'doc-writer'
export const TEST_RUNNER = 'test-runner'

export const DOC_WRITER_PROMPT = [
  'You write one document for people: requirements, a design document, a specification, a report, a README.',
  'Read the sources the request names (meeting notes, rules, specifications, code, test output) before writing.',
  'Every statement must agree with the sources; when sources disagree, the later decision wins, and say which one replaced which.',
  'Cite where each rule comes from (document and section) only when you have checked the section exists.',
  'Keep rejected or postponed proposals apart from adopted decisions.',
  'Check edge cases against the rules themselves (dates, month ends, leap years, rounding, boundaries) instead of assuming.',
  'When the document reports on tests or behaviour, run the commands and report what they print.',
  'Write in the language of the request. Save the document to the path given, then reply with a short summary of what it covers and anything you could not confirm.',
].join('\n')

export const TEST_RUNNER_PROMPT = [
  'You run the tests or commands the request names and report the outcome.',
  'Reply with: the command, pass and fail counts, and for each failure the test name and the key lines of the message.',
  'Do not change any file.',
].join('\n')

// With docs: delegate, the main loop's writes of Markdown files are refused
// with this, so the document is written by the doc-writer: asking in the
// system prompt alone was ignored (P4 check: no delegation in two runs).
export const isDocPath = (path: unknown): boolean =>
  typeof path === 'string' && /\.md$/i.test(path) && !/(^|\/)node_modules\//.test(path)

export const DOC_DENY = [
  `Documents for people are written by the \`${PLUGIN}:${DOC_WRITER}\` agent, not on the main loop.`,
  'Delegate this file to it: give the path, the sources to read, the decisions made in this conversation that are not in a file, and what to check.',
].join(' ')

// The system prompt section that asks the main loop to delegate.
export const delegationSection = (docs: DocsMode): string =>
  [
    '# Delegating to subagents',
    ...(docs === 'delegate'
      ? [
          `- When a request needs a document for people (requirements, design document, specification, report, README), do not write it yourself: give it to the \`${PLUGIN}:${DOC_WRITER}\` agent.`,
          '  Tell it the file path, the sources to read, every decision made in this conversation that is not in a file, and what to check (for a report: the test command to run).',
          '  Then read the document it wrote and fix only clear mistakes.',
        ]
      : []),
    `- To run a test suite and learn which tests fail, use the \`${PLUGIN}:${TEST_RUNNER}\` agent instead of reading long output yourself.`,
    '- For read-only searches across many files, use the Explore agent.',
  ].join('\n')

// Built-in agent types the router assigns a tier to; any other type (an SDK
// host's own `agents`, another plugin's) keeps the model its definition names.
const AGENT_TIER: Record<string, Tier> = {
  Explore: 'haiku',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'haiku',
  'general-purpose': 'sonnet',
  Plan: 'opus',
  [`${PLUGIN}:${DOC_WRITER}`]: 'opus',
  [`${PLUGIN}:${TEST_RUNNER}`]: 'haiku',
}

export const tierForSubagent = (
  subagentType: string,
  description: string,
  prompt: string,
): Tier | undefined => {
  const base = AGENT_TIER[subagentType]
  if (!base) return undefined
  // A general worker asked for hard or document work steps up.
  if (base === 'sonnet') {
    const kind = classifyHeuristic(`${description}\n${prompt}`).kind
    if (kind === 'hard' || kind === 'docs') return 'opus'
  }
  return base
}

// --- Pricing (USD per million tokens, first-party API, 2026-10) ------------

type Price = { input: number; output: number; cacheRead: number }

const PRICE: Record<Tier, Price> = {
  opus: { input: 4, output: 20, cacheRead: 0.2 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1 },
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

// Cache writes cost 1.25x input on the 5-minute TTL and 2x on the 1-hour TTL.
export type CacheTtl = '5m' | '1h'

export const costUsd = (tier: Tier, u: Usage, ttl: CacheTtl = '5m'): number => {
  const p = tier === 'haiku' && promptTokens(u) > 100_000 ? HAIKU_LONG : PRICE[tier]
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * (ttl === '1h' ? 2 : 1.25) +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000
  )
}

// What a switch of the main loop to `tier` costs on top of staying: the
// conversation it has not cached is written at the write price instead of
// read. A switch back within the TTL finds its old prefix still cached.
export const switchCostUsd = (tier: Tier, uncachedTokens: number, ttl: CacheTtl): number => {
  const p = PRICE[tier]
  return (uncachedTokens * (p.input * (ttl === '1h' ? 2 : 1.25) - p.cacheRead)) / 1_000_000
}

// The TTL Claude Code writes the cache with, for the main conversation and
// for everything else (subagents, helper calls), in the order the docs give
// (code.claude.com/docs/en/prompt-caching, "Choose the TTL yourself"). The
// default assumes a subscription unless an API key is set; a subscription
// that has gone over its plan's usage gets 5 minutes, which this cannot see.
export type TtlEnv = {
  FORCE_PROMPT_CACHING_5M?: string
  CLAUDE_CODE_PROMPT_CACHE_TTL?: string
  CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL?: string
  ENABLE_PROMPT_CACHING_1H?: string
  ANTHROPIC_API_KEY?: string
}

export const resolveTtls = (env: TtlEnv): { main: CacheTtl; other: CacheTtl } => {
  const pick = (v: string | undefined): CacheTtl | undefined => (v === '5m' || v === '1h' ? v : undefined)
  if (env.FORCE_PROMPT_CACHING_5M === '1') return { main: '5m', other: '5m' }
  const all1h = env.ENABLE_PROMPT_CACHING_1H === '1' ? '1h' : undefined
  return {
    main: pick(env.CLAUDE_CODE_PROMPT_CACHE_TTL) ?? all1h ?? (env.ANTHROPIC_API_KEY ? '5m' : '1h'),
    other: pick(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) ?? all1h ?? '5m',
  }
}
