// Reruns the hidden acceptance tests on the src/ each run kept, for when the
// acceptance tests change after the runs (e.g. a case added). Covers the
// implement stage runs (<id>/stage-N) and whole runs (script, auto).
//   npx tsx eval/regrade.ts eval/results/<stamp>.jsonl
// Runs code the agent wrote: run it in the container (container/run.sh); no
// model requests, so no token is needed.
// Results: <stamp>.regrade.jsonl, one line per run, with the old count for comparison.
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { acceptanceOn, type TestCount } from './scenario-grade'
import { SCENARIOS } from './scenarios'

type Row = { task: string; arm: string; rep: number; artifacts: string | null; acceptance: TestCount | null }

const file = process.argv[2]
if (!file) throw new Error('give one results file')
const rows: Row[] = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
const out = file.replace(/\.jsonl$/, '.regrade.jsonl')

for (const row of rows) {
  if (!row.artifacts || !row.acceptance) continue
  const scenario = row.task.split('/')[0]!
  if (!SCENARIOS.some(s => s.id === scenario)) continue
  const now = await acceptanceOn(scenario, join(dirname(file), row.artifacts, 'final', 'src'))
  if (!now) continue
  const key = `${row.task}/${row.arm}/${row.rep}`
  await appendFile(out, JSON.stringify({ key, task: row.task, arm: row.arm, rep: row.rep, before: row.acceptance, after: now }) + '\n')
  console.log(`${key}: ${row.acceptance.pass}/${row.acceptance.tests} -> ${now.pass}/${now.tests}`)
}
