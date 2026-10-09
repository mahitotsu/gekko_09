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
  let want: string
  if (r.arm === 'routed') {
    const tiers = r.routerLog.map(l => l.split(' ')[1]!)
    if (tiers.length !== 1) {
      console.log(`✖ ${r.task} routed: ${tiers.length} router decisions`)
      bad++
      continue
    }
    want = ID[tiers[0]!]!
  } else {
    want = BASELINE[r.arm]!
    auxUsd += r.modelUsage?.[ID.haiku!]?.costUSD ?? 0
  }
  // A Haiku-routed run bills Haiku only; any other run bills exactly its model besides Haiku.
  const ok = want === ID.haiku ? used.size === 0 : used.size === 1 && used.has(want)
  if (!ok) {
    console.log(`✖ ${r.task} ${r.arm}: expected ${want}, billed ${[...used].join(', ') || '(haiku only)'}`)
    bad++
  }
}
console.log(`${rows.length} runs checked, ${bad} mismatches; Haiku billed in baseline arms: $${auxUsd.toFixed(4)}`)
process.exit(bad ? 1 : 0)
