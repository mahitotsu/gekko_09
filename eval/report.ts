// Summarizes eval/results/*.jsonl into Markdown tables.
//   npx tsx eval/report.ts [results/file.jsonl ...]   (default: the newest file)
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

type Row = {
  task: string
  level: string
  arm: string
  pass: boolean
  costUsd?: number
  durationMs?: number
  numTurns?: number
  modelUsage?: Record<string, { costUSD: number; outputTokens: number }>
  routerLog: string[]
}

const dir = fileURLToPath(new URL('./results/', import.meta.url))
const files = process.argv.slice(2)
if (files.length === 0) files.push(dir + (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().at(-1)!)

const rows: Row[] = (await Promise.all(files.map(f => readFile(f, 'utf8'))))
  .flatMap(t => t.split('\n').filter(Boolean))
  .map(l => JSON.parse(l))
  .filter((r: Row & { subtype?: string }) => r.subtype !== 'crash') // never reached the model

const ARMS = [...new Set(rows.map(r => r.arm))]
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const usd = (n: number) => `$${n.toFixed(3)}`
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const table = (head: string[], body: (string | number)[][]) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map(r => `| ${r.join(' | ')} |`)].join('\n')

const summary = (subset: Row[]) =>
  ARMS.map(arm => {
    const rs = subset.filter(r => r.arm === arm)
    const pass = rs.filter(r => r.pass).length
    const cost = sum(rs.map(r => r.costUsd ?? 0))
    return [
      arm,
      `${pass}/${rs.length}`,
      usd(cost),
      pass ? usd(cost / pass) : '-',
      sec(median(rs.map(r => r.durationMs ?? NaN).filter(Number.isFinite))),
      sec(sum(rs.map(r => r.durationMs ?? 0))),
    ]
  })

const HEAD = ['arm', 'pass', 'total cost', 'cost / pass', 'median latency', 'total latency']

console.log(`## Overall (${rows.length} runs)\n`)
console.log(table(HEAD, summary(rows)))
for (const level of ['easy', 'medium', 'hard', 'expert']) {
  console.log(`\n## ${level}\n`)
  console.log(table(HEAD, summary(rows.filter(r => r.level === level))))
}

console.log('\n## Per task (pass · cost · latency)\n')
const tasks = [...new Set(rows.map(r => r.task))]
console.log(
  table(
    ['task', ...ARMS],
    tasks.map(t => [
      t,
      ...ARMS.map(a => {
        const rs = rows.filter(r => r.task === t && r.arm === a)
        return rs.map(r => `${r.pass ? '✅' : '❌'} ${usd(r.costUsd ?? 0)} ${sec(r.durationMs ?? 0)}`).join('<br>')
      }),
    ]),
  ),
)

const routed = rows.filter(r => r.arm === 'routed')
if (routed.length) {
  console.log('\n## Router decisions\n')
  console.log(
    table(
      ['task', 'tier (why)', 'models billed'],
      routed.map(r => [
        r.task,
        r.routerLog.map(l => l.replace(/^model-router: /, '').replace(/ · turn .*$/, '')).join('<br>'),
        Object.entries(r.modelUsage ?? {})
          .map(([m, u]) => `${m.replace('claude-', '')} ${usd(u.costUSD)}`)
          .join(', '),
      ]),
    ),
  )
}
