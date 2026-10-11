// Grades the agent's tests by the bugs they catch: each test stage run's
// test/ is run against the reference src/ and against every mutant of it
// (eval/scenarios/<id>/hidden/mutants.mjs); a mutant is caught when npm test
// fails. Only stage runs (<id>/stage-N of the test stage) qualify: their src/
// is the reference, so the tests fit the mutants' modules.
//   npx tsx eval/mutation.ts eval/results/<stamp>.jsonl
//   npx tsx eval/mutation.ts --check   (every mutant fails the hidden acceptance tests)
// Runs code the agent wrote: run it in the container (container/run.sh); no
// model requests, so no token is needed.
// Results: <stamp>.mutation.jsonl, one line per run; a rerun skips what it has.
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { acceptance, runTests } from './scenario-grade'
import { copyPath, prepare, scenarioDir, SCENARIOS } from './scenarios'
import type { Scenario } from './scenarios/types'

type Mutant = { id: string; file: string; note: string; from: string; to: string }
type Row = { task: string; arm: string; rep: number; artifacts: string | null }

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { check: { type: 'boolean', default: false } },
})

const mutantsOf = async (s: Scenario): Promise<Mutant[]> =>
  (await import(pathToFileURL(join(scenarioDir(s.id), 'hidden', 'mutants.mjs')).href).catch(() => ({ mutants: [] })))
    .mutants

// A workspace as the test stage starts it (reference output of the stages before).
const workspace = async (s: Scenario) => {
  const ws = await mkdtemp(join(tmpdir(), 'mutation-'))
  await prepare(s, s.stages.slice(0, s.stages.findIndex(x => x.id === 'test')))(ws)
  return ws
}

// Runs `check` on src/ with each mutant applied in turn, restoring it after.
const eachMutant = async <T>(ws: string, mutants: Mutant[], check: () => Promise<T>) => {
  const out: { mutant: Mutant; result: T }[] = []
  for (const m of mutants) {
    const path = join(ws, 'src', m.file)
    const orig = await readFile(path, 'utf8')
    if (orig.split(m.from).length !== 2) throw new Error(`${m.id}: "${m.from}" must occur exactly once in src/${m.file}`)
    await writeFile(path, orig.replace(m.from, () => m.to))
    try {
      out.push({ mutant: m, result: await check() })
    } finally {
      await writeFile(path, orig)
    }
  }
  return out
}

const npmTest = (ws: string) => runTests(ws, 'npm', ['test', '--silent'])

if (args.check) {
  for (const s of SCENARIOS) {
    const mutants = await mutantsOf(s)
    if (!mutants.length) continue
    const ws = await workspace(s)
    try {
      await copyPath(join(scenarioDir(s.id), 'reference'), ws, 'test/')
      const ref = await acceptance(s.id, ws)
      console.log(`${s.id}: reference acceptance ${ref.count.pass}/${ref.count.tests}`)
      if (!ref.count.ok) throw new Error(`${s.id}: the reference fails its acceptance tests`)
      const results = await eachMutant(ws, mutants, async () => ({ acc: (await acceptance(s.id, ws)).count, own: (await npmTest(ws)).count }))
      for (const { mutant: m, result: r } of results)
        console.log(`  ${m.id} ${r.acc.ok ? 'NOT CAUGHT' : 'caught'} by acceptance (${r.acc.pass}/${r.acc.tests})` +
          `, reference tests ${r.own.ok ? 'pass' : 'fail'}  ${m.note}`)
      const missed = results.filter(r => r.result.acc.ok)
      if (missed.length) throw new Error(`acceptance misses ${missed.map(r => r.mutant.id).join(', ')}`)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  }
  process.exit(0)
}

if (positionals.length !== 1) throw new Error('give one results file')
const file = positionals[0]!
const out = file.replace(/\.jsonl$/, '.mutation.jsonl')
const done = new Set(
  (await readFile(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l).key as string),
)
const rows: Row[] = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))

for (const row of rows) {
  const [scenario, part] = row.task.split('/') as [string, string]
  const s = SCENARIOS.find(x => x.id === scenario)
  if (!s || !row.artifacts || !part?.startsWith('stage-') || s.stages[Number(part.slice(6)) - 1]?.id !== 'test') continue
  const key = `${row.task}/${row.arm}/${row.rep}`
  if (done.has(key)) continue
  const mutants = await mutantsOf(s)
  const ws = await workspace(s)
  try {
    await copyPath(join(dirname(file), row.artifacts, 'final'), ws, 'test/')
    const baseRun = await npmTest(ws)
    const base = baseRun.count
    if (!base.ok) console.log(baseRun.failed || baseRun.out.slice(-1500))
    const results = base.ok ? await eachMutant(ws, mutants, async () => (await npmTest(ws)).count) : []
    const caught = results.filter(r => !r.result.ok).map(r => r.mutant.id)
    const missed = results.filter(r => r.result.ok).map(r => r.mutant.id)
    const line = { key, task: row.task, arm: row.arm, rep: row.rep, base, caught, missed, score: base.ok ? caught.length / mutants.length : 0 }
    await appendFile(out, JSON.stringify(line) + '\n')
    console.log(`${key}: ${base.ok ? `${caught.length}/${mutants.length} caught; missed ${missed.join(' ') || '-'}` : 'tests fail on the reference'}`)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}
