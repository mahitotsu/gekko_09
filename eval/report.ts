// Summarizes eval/results/*.jsonl into Markdown tables.
//   npx tsx eval/report.ts [results/file.jsonl ...]   (default: the newest file)
// Cost is recomputed from each request's tokens and the list prices
// (eval/cost.ts): measured, cold and warm cache. Rows recorded before
// per-request usage existed (schema 1) fall back to the SDK's estimate.
// Latency is the API time (duration_api_ms); wall time is in the per-task table.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { runCost, sharedPrefix, type RequestUsage, type RunCost } from './cost'

type Step = { agent: string | null; model: string; effort: string | number | null; answered: string | null }

type Row = {
  schema?: number
  task: string
  level: string
  arm: string
  rep: number
  pass: boolean
  costUsd?: number
  durationMs?: number
  durationApiMs?: number
  wallMs?: number
  numTurns?: number
  modelUsage?: Record<string, { costUSD: number; outputTokens: number }>
  requests?: RequestUsage[]
  steps?: Step[]
  denials?: { tool: string; input: string }[]
  concurrency?: number
  routerLog: string[]
}

const dir = fileURLToPath(new URL('./results/', import.meta.url))
const files = process.argv.slice(2)
if (files.length === 0) files.push(dir + (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().at(-1)!)

const rows: Row[] = (await Promise.all(files.map(f => readFile(f, 'utf8'))))
  .flatMap(t => t.split('\n').filter(Boolean))
  .map(l => JSON.parse(l))
  .filter((r: Row & { subtype?: string }) => r.subtype !== 'crash') // never reached the model

const prefix = sharedPrefix(rows.filter(r => r.requests).map(r => r.requests!))
const costs = new Map<Row, RunCost>()
for (const r of rows) {
  const c = r.requests ? runCost(r.requests, prefix) : undefined
  const sdk = r.costUsd ?? 0
  costs.set(r, c ?? { measured: sdk, cold: NaN, warm: NaN, byModel: {}, cacheReadFromOutside: 0 })
}

const ARMS = [...new Set(rows.map(r => r.arm))]
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const usd = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(3)}` : '-')
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '-')
const pct = (n: number) => (Number.isFinite(n) ? `${Math.round(n * 100)}%` : '-')

const table = (head: string[], body: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map(r => `| ${r.join(' | ')} |`)].join('\n')

const apiMs = (r: Row) => r.durationApiMs ?? r.durationMs ?? NaN

const summary = (subset: Row[]) =>
  ARMS.map(arm => {
    const rs = subset.filter(r => r.arm === arm)
    const pass = rs.filter(r => r.pass).length
    const c = (k: keyof RunCost) => sum(rs.map(r => costs.get(r)![k] as number))
    return [
      arm,
      `${pass}/${rs.length}`,
      usd(c('measured')),
      usd(c('cold')),
      usd(c('warm')),
      pass ? usd(c('measured') / pass) : '-',
      sec(median(rs.map(apiMs).filter(Number.isFinite))),
      sec(sum(rs.map(apiMs).filter(Number.isFinite))),
      median(rs.map(r => r.requests?.filter(q => q.agent !== 'aux').length ?? NaN).filter(Number.isFinite)) || '-',
    ]
  })

const HEAD = ['arm', 'pass', 'cost', 'cost (cold)', 'cost (warm)', 'cost / pass', 'median API time', 'total API time', 'median requests']

const concurrency = [...new Set(rows.map(r => r.concurrency).filter(Boolean))]
console.log(`## Overall (${rows.length} runs${concurrency.length ? `, concurrency ${concurrency.join('/')}` : ''})\n`)
console.log(table(HEAD, summary(rows)))
for (const level of ['easy', 'medium', 'hard', 'expert']) {
  const sub = rows.filter(r => r.level === level)
  if (!sub.length) continue
  console.log(`\n## ${level}\n`)
  console.log(table(HEAD, summary(sub)))
}

console.log('\n## Pass rate per task\n')
const tasks = [...new Set(rows.map(r => r.task))]
console.log(
  table(
    ['task', ...ARMS],
    tasks.map(t => [
      t,
      ...ARMS.map(a => {
        const rs = rows.filter(r => r.task === t && r.arm === a)
        return rs.length ? `${rs.filter(r => r.pass).length}/${rs.length}` : '-'
      }),
    ]),
  ),
)

console.log('\n## Per run (pass · cost · API time · wall time)\n')
console.log(
  table(
    ['task', ...ARMS],
    tasks.map(t => [
      t,
      ...ARMS.map(a =>
        rows
          .filter(r => r.task === t && r.arm === a)
          .map(r => `${r.pass ? '✅' : '❌'} ${usd(costs.get(r)!.measured)} ${sec(apiMs(r))} ${sec(r.wallMs ?? NaN)}`)
          .join('<br>'),
      ),
    ]),
  ),
)

// Which model and effort the requests went out with, from the probe.
const withSteps = rows.filter(r => r.steps?.length)
if (withSteps.length) {
  console.log('\n## Requests by model and effort (main loop · subagents)\n')
  const mix = (rs: Row[], isSub: boolean) => {
    const n = new Map<string, number>()
    for (const s of rs.flatMap(r => r.steps!).filter(s => (s.agent !== null) === isSub)) {
      const k = `${(s.answered ?? s.model).replace('claude-', '')}/${s.effort ?? '-'}`
      n.set(k, (n.get(k) ?? 0) + 1)
    }
    return [...n].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-'
  }
  console.log(table(['arm', 'main', 'subagents'], ARMS.map(a => {
    const rs = withSteps.filter(r => r.arm === a)
    return [a, mix(rs, false), mix(rs, true)]
  })))
  const misordered = withSteps.flatMap(r => r.steps!).filter(s => s.answered && s.answered !== s.model).length
  if (misordered) console.log(`\n⚠ ${misordered} requests answered by a model other than the one the probe saw: the probe did not run last, or the API fell back.`)
}

// Haiku's share, by turns the router gave it and by tokens it processed.
const withReqs = rows.filter(r => r.requests?.length)
if (withReqs.length) {
  console.log('\n## Haiku share (main-loop turns · all tokens)\n')
  console.log(table(['arm', 'turns on Haiku', 'tokens on Haiku'], ARMS.map(a => {
    const rs = withReqs.filter(r => r.arm === a)
    const tierLines = rs.flatMap(r => r.routerLog.filter(l => l.startsWith('model-router: ')))
    const haikuTurns = tierLines.filter(l => l.startsWith('model-router: haiku')).length
    const tok = (x: RequestUsage) => x.in + x.cacheRead + x.cacheWrite5m + x.cacheWrite1h + x.out
    const reqs = rs.flatMap(r => r.requests!)
    return [
      a,
      tierLines.length ? `${haikuTurns}/${tierLines.length}` : '-',
      pct(sum(reqs.filter(x => x.model.startsWith('claude-haiku')).map(tok)) / sum(reqs.map(tok))),
    ]
  })))
}

const denied = rows.filter(r => r.denials?.length)
if (denied.length) {
  console.log('\n## Denied tool calls\n')
  console.log(table(['task', 'arm', 'rep', 'tool', 'input'], denied.flatMap(r =>
    r.denials!.map(d => [r.task, r.arm, r.rep, d.tool, '`' + d.input.replace(/\|/g, '\\|').replace(/`/g, "'") + '`']))))
}

const routed = rows.filter(r => r.arm === 'routed')
if (routed.length) {
  console.log('\n## Router decisions\n')
  console.log(
    table(
      ['task', 'tier (why)', 'models billed'],
      routed.map(r => [
        r.task,
        r.routerLog.map(l => l.replace(/^model-router: /, '').replace(/ · turn .*$/, '')).join('<br>'),
        Object.entries(costs.get(r)!.byModel).length
          ? Object.entries(costs.get(r)!.byModel).map(([m, u]) => `${m.replace('claude-', '')} ${usd(u)}`).join(', ')
          : Object.entries(r.modelUsage ?? {}).map(([m, u]) => `${m.replace('claude-', '')} ${usd(u.costUSD)}`).join(', '),
      ]),
    ),
  )
}
