// Cost from token counts and the public list prices, per request.
//
// The SDK's total_cost_usd is an estimate; this recomputes cost from each
// request's usage, so a results file can be repriced and split into
// "cold" and "warm" cache cases:
//   measured  as billed, including cache entries an earlier run left behind
//   cold      no cache from outside the run: the first request of each
//             thread (main loop, subagents) pays a write for what it read
//   warm      the shared prefix was already cached: the first request of
//             each thread reads up to `prefix` tokens it would otherwise write
// `prefix` is per model and thread kind: the largest cache read any first
// request in the same results showed, a lower bound on the prefix that
// every run shares (system prompt and tool definitions).

// USD per million tokens, first-party API, list prices from
// platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-10).
// Cache writes cost 1.25x input for the 5-minute TTL and 2x for the 1-hour
// TTL; cache reads are 0.05x input on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku.
// (The SDK's bundled table priced Sonnet 5.5 reads at $0.20 up to 0.3.295, so
// its total_cost_usd ran high on Sonnet. 0.3.302 has the $0.10 entry; an older
// SDK still logs the old price, so recompute from tokens as this file does.)
type Price = { input: number; output: number; cacheRead: number }

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}
// Haiku 5.5 bills a request whose prompt is over 100K tokens at 5x.
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05 }
const LONG_PROMPT = 100_000

// One model request, as eval/run.ts records it from the SDK's assistant messages.
export type RequestUsage = {
  model: string
  agent: string | null // the subagent's id; null on the main loop, 'aux' for helper calls
  in: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  out: number
}

export const promptTokens = (r: RequestUsage) => r.in + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h

export const priceOf = (model: string, prompt: number): Price | undefined => {
  const key = Object.keys(PRICES).find(k => model.startsWith(k))
  if (!key) return undefined
  return key === 'claude-haiku-5-5' && prompt > LONG_PROMPT ? HAIKU_LONG : PRICES[key]
}

export const requestUsd = (r: RequestUsage): number => {
  const p = priceOf(r.model, promptTokens(r))
  if (!p) throw new Error(`no price for ${r.model}`)
  return (
    (r.in * p.input +
      r.cacheWrite5m * p.input * 1.25 +
      r.cacheWrite1h * p.input * 2 +
      r.cacheRead * p.cacheRead +
      r.out * p.output) /
    1_000_000
  )
}

const threadKind = (r: RequestUsage) => (r.agent === null ? 'main' : r.agent === 'aux' ? 'aux' : 'sub')
const prefixKey = (r: RequestUsage) => `${r.model}/${threadKind(r)}`

// Indices of the first request of each thread and model in one run.
const firstOfThread = (reqs: RequestUsage[]) => {
  const seen = new Set<string>()
  const firsts = new Set<number>()
  reqs.forEach((r, i) => {
    const k = `${r.agent ?? 'main'}/${r.model}`
    if (!seen.has(k)) {
      seen.add(k)
      firsts.add(i)
    }
  })
  return firsts
}

// The shared prefix per model and thread kind, from many runs' requests.
export const sharedPrefix = (runs: RequestUsage[][]) => {
  const prefix: Record<string, number> = {}
  for (const reqs of runs)
    for (const i of firstOfThread(reqs)) {
      const r = reqs[i]!
      prefix[prefixKey(r)] = Math.max(prefix[prefixKey(r)] ?? 0, r.cacheRead)
    }
  return prefix
}

// A first request with its outside cache read moved to writes, at the TTL
// the request wrote with (5 minutes when it wrote nothing).
const asCold = (r: RequestUsage): RequestUsage =>
  r.cacheWrite1h > r.cacheWrite5m
    ? { ...r, cacheRead: 0, cacheWrite1h: r.cacheWrite1h + r.cacheRead }
    : { ...r, cacheRead: 0, cacheWrite5m: r.cacheWrite5m + r.cacheRead }

const asWarm = (r: RequestUsage, prefix: number): RequestUsage => {
  let move = Math.max(0, prefix - r.cacheRead)
  const from5m = Math.min(move, r.cacheWrite5m)
  move -= from5m
  const from1h = Math.min(move, r.cacheWrite1h)
  return {
    ...r,
    cacheRead: r.cacheRead + from5m + from1h,
    cacheWrite5m: r.cacheWrite5m - from5m,
    cacheWrite1h: r.cacheWrite1h - from1h,
  }
}

export type RunCost = {
  measured: number
  cold: number
  warm: number
  byModel: Record<string, number> // measured
  cacheReadFromOutside: number // tokens the first request of each thread read: cached before the thread began
}

export const runCost = (reqs: RequestUsage[], prefix: Record<string, number>): RunCost => {
  const firsts = firstOfThread(reqs)
  const out: RunCost = { measured: 0, cold: 0, warm: 0, byModel: {}, cacheReadFromOutside: 0 }
  reqs.forEach((r, i) => {
    const usd = requestUsd(r)
    out.measured += usd
    out.byModel[r.model] = (out.byModel[r.model] ?? 0) + usd
    if (firsts.has(i)) {
      out.cacheReadFromOutside += r.cacheRead
      out.cold += requestUsd(asCold(r))
      out.warm += requestUsd(asWarm(r, prefix[prefixKey(r)] ?? 0))
    } else {
      out.cold += usd
      out.warm += usd
    }
  })
  return out
}

// --- Building a run's requests --------------------------------------------

// One request as the probe mod logged it (eval/probe): exact token counts,
// but one cache-write total with no TTL split.
export type ProbeStep = {
  agent: string | null
  model: string
  answered: string | null
  in: number
  cacheRead: number
  cacheWrite: number
  out: number
}

// The TTL split of one request's cache write, from the SDK's assistant message
// (whose other counts are taken when the response starts, so out is too low).
export type WriteSplit = { in: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

type ModelTotals = Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>

// The run's requests: one per probe step, its cache write split by the SDK
// message with the same input and cache counts. A write with no matching
// message is counted at the TTL Claude Code gives that kind of request
// (docs: prompt-caching, "Which TTL each request gets"; pinned by
// eval/env.ts): 1 hour on the main loop, 5 minutes in a subagent. Then one `aux` request per model for what the SDK's
// per-model totals hold beyond the steps: Claude Code's own helper calls,
// such as the session title, which no step covers.
export const buildRequests = (steps: ProbeStep[], splits: WriteSplit[], totals: ModelTotals) => {
  const unused = [...splits]
  let unmatched = 0
  const reqs: RequestUsage[] = steps.map(s => {
    const i = unused.findIndex(
      w => w.in === s.in && w.cacheRead === s.cacheRead && w.cacheWrite5m + w.cacheWrite1h === s.cacheWrite,
    )
    const w = i >= 0 ? unused.splice(i, 1)[0]! : undefined
    if (!w && s.cacheWrite > 0) unmatched++
    return {
      model: s.answered ?? s.model,
      agent: s.agent,
      in: s.in,
      cacheRead: s.cacheRead,
      cacheWrite5m: w ? w.cacheWrite5m : s.agent === null ? 0 : s.cacheWrite,
      cacheWrite1h: w ? w.cacheWrite1h : s.agent === null ? s.cacheWrite : 0,
      out: s.out,
    }
  })
  const aux: RequestUsage[] = []
  for (const [model, t] of Object.entries(totals)) {
    const mine = reqs.filter(r => r.model === model)
    const rest = (total: number, f: (r: RequestUsage) => number) => Math.max(0, total - mine.reduce((s, r) => s + f(r), 0))
    const a: RequestUsage = {
      model,
      agent: 'aux',
      in: rest(t.inputTokens, r => r.in),
      cacheRead: rest(t.cacheReadInputTokens, r => r.cacheRead),
      cacheWrite5m: rest(t.cacheCreationInputTokens, r => r.cacheWrite5m + r.cacheWrite1h),
      cacheWrite1h: 0,
      out: rest(t.outputTokens, r => r.out),
    }
    if (a.in + a.cacheRead + a.cacheWrite5m + a.out > 0) aux.push(a)
  }
  return { requests: [...reqs, ...aux], unmatched }
}
