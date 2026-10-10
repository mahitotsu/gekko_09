// Checks, from the billed models the SDK reported (result.modelUsage), that
// routing did what the router logged, and that the baseline arms ran only
// their own model.
//   npx tsx eval/check-routing.ts eval/results/*.jsonl
import { readFile } from 'node:fs/promises'

const ID: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}
const BASELINE: Record<string, string> = {
  opus: ID.opus!,
  'opus-low': ID.opus!,
  sonnet: ID.sonnet!,
  haiku: ID.haiku!,
}

type Row = { task: string; arm: string; routerLog: string[]; modelUsage?: Record<string, { costUSD: number }> }

const rows: Row[] = (await Promise.all(process.argv.slice(2).map(f => readFile(f, 'utf8'))))
  .flatMap(t => t.split('\n').filter(Boolean))
  .map(l => JSON.parse(l))

let bad = 0
let auxUsd = 0
for (const r of rows) {
  const used = new Set(Object.keys(r.modelUsage ?? {}))
  // Claude Code itself makes small Haiku calls in every session, routed or not.
  used.delete(ID.haiku!)
  // The models this run should have billed besides Haiku: the router's tier
  // for each turn, or the baseline arm's one model.
  let want: Set<string>
  if (r.arm === 'routed') {
    const tiers = r.routerLog.filter(l => l.startsWith('model-router: ')).map(l => l.split(' ')[1]!)
    if (tiers.length === 0) {
      console.log(`✖ ${r.task} routed: no router decisions`)
      bad++
      continue
    }
    want = new Set(tiers.map(t => ID[t]!))
  } else {
    want = new Set([BASELINE[r.arm]!])
    auxUsd += r.modelUsage?.[ID.haiku!]?.costUSD ?? 0
  }
  want.delete(ID.haiku!)
  // Exactly the expected models besides Haiku, which every session bills a little of.
  const ok = used.size === want.size && [...want].every(m => used.has(m))
  if (!ok) {
    console.log(`✖ ${r.task} ${r.arm}: expected ${[...want].join(', ') || '(haiku only)'}, billed ${[...used].join(', ') || '(haiku only)'}`)
    bad++
  }
}
console.log(`${rows.length} runs checked, ${bad} mismatches; Haiku billed in baseline arms: $${auxUsd.toFixed(4)}`)
process.exit(bad ? 1 : 0)
