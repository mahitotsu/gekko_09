// Grading for scenario tasks (eval/scenarios): the hidden acceptance tests,
// the agent's own tests, and the documents kept for blind grading
// (eval/grade-docs.ts).
//
// What is graded depends on what the run produced:
//   whole run (script, auto)  acceptance on the final src/, the agent's tests,
//                             and, for script runs, acceptance on src/ as it
//                             stood when the implement stage ended
//   stage implement           acceptance on src/
//   stage test                the agent's tests, run against the model src/
//   document stages           the documents exist (their content is graded later)
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { copyPath, SCENARIOS, scenarioDir } from './scenarios'
import type { StageId } from './scenarios/types'

const exec = promisify(execFile)

// Commands the grader runs execute code the agent wrote: give them nothing
// from this process's environment (the OAuth token above all).
export const gradeEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  LANG: 'C.UTF-8',
  TZ: 'Asia/Tokyo',
})

export type TestCount = { ok: boolean; pass: number; tests: number }

// Runs a node:test command and reads its summary lines (ℹ tests N / ℹ pass N).
export const runTests = async (cwd: string, cmd: string, args: string[], timeout = 120_000) => {
  const home = await mkdtemp(join(tmpdir(), 'grade-home-'))
  let out: string
  let ok = true
  try {
    const r = await exec(cmd, args, { cwd, timeout, env: gradeEnv(home), maxBuffer: 16 * 1024 * 1024 })
    out = r.stdout + r.stderr
  } catch (err) {
    ok = false
    const e = err as { stdout?: string; stderr?: string }
    out = `${e.stdout ?? ''}${e.stderr ?? ''}` || String(err)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const num = (k: string) => Number(out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm'))?.[1] ?? 0)
  const count: TestCount = { ok, pass: num('pass'), tests: num('tests') }
  const failed = out.split('\n').filter(l => /^\s*✖|^not ok/.test(l)).slice(0, 8).join('\n')
  return { count, out, failed }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

// The hidden datasets are not in git: make-datasets.mjs regenerates them
// (fixed seed, expected output from the reference implementation).
const ensureDatasets = async (hidden: string) => {
  if (await exists(join(hidden, 'datasets'))) return
  const home = await mkdtemp(join(tmpdir(), 'grade-home-'))
  try {
    await exec('node', [join(hidden, 'make-datasets.mjs')], { env: gradeEnv(home) })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

// The hidden acceptance tests, run in a workspace that has src/ (and package.json).
export const acceptance = async (scenario: string, cwd: string) => {
  const hidden = join(scenarioDir(scenario), 'hidden')
  await ensureDatasets(hidden)
  await cp(join(hidden, 'acceptance.test.js'), join(cwd, 'test-hidden', 'acceptance.test.js'))
  await cp(join(hidden, 'datasets'), join(cwd, 'test-hidden', 'datasets'), { recursive: true })
  const r = await runTests(cwd, 'node', ['--test', 'test-hidden/acceptance.test.js'])
  await rm(join(cwd, 'test-hidden'), { recursive: true, force: true })
  return r
}

// Acceptance on a snapshot of src/ (a checkpoint), in a scratch workspace.
export const acceptanceOn = async (scenario: string, srcDir: string) => {
  if (!(await exists(srcDir))) return undefined
  const ws = await mkdtemp(join(tmpdir(), 'grade-checkpoint-'))
  try {
    await cp(join(scenarioDir(scenario), 'workspace'), ws, { recursive: true })
    await cp(srcDir, join(ws, 'src'), { recursive: true })
    return (await acceptance(scenario, ws)).count
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
}

export const gradeScenario = async (
  grade: { scenario: string; stage?: StageId },
  cwd: string,
  artifacts: string,
  snapshotTurns: { turn: number; paths: readonly string[] }[],
) => {
  const s = SCENARIOS.find(x => x.id === grade.scenario)!
  const stages = grade.stage ? s.stages.filter(x => x.id === grade.stage) : s.stages
  const final = join(artifacts, 'final')

  // Keep what the stages produced, before anything else touches the workspace.
  for (const stage of stages) for (const p of stage.produces) await copyPath(cwd, final, p)
  const docs = stages.flatMap(x => x.produces).filter(p => p.endsWith('.md'))
  const missing = []
  for (const p of docs) if (!(await exists(join(cwd, p)))) missing.push(p)

  // The agent's own tests, before the hidden ones are copied in.
  let agentTests: TestCount | undefined
  if (!grade.stage || grade.stage === 'test' || grade.stage === 'report') {
    const r = await runTests(cwd, 'npm', ['test', '--silent'])
    agentTests = r.count
    await mkdir(final, { recursive: true })
    await writeFile(join(final, 'npm-test.txt'), r.out.slice(-20_000))
  }

  let accept: TestCount | undefined
  let failed = ''
  if (!grade.stage || grade.stage === 'implement') {
    const r = await acceptance(s.id, cwd)
    accept = r.count
    failed = r.failed
  }

  // Script runs: acceptance on src/ as the implement stage left it.
  const implementTurn = snapshotTurns.find(t => t.paths.includes('src/'))
  const checkpoint =
    !grade.stage && implementTurn
      ? await acceptanceOn(s.id, join(artifacts, `turn-${implementTurn.turn}`, 'src'))
      : undefined

  const score = accept && accept.tests ? accept.pass / accept.tests : null
  const pass =
    missing.length === 0 &&
    (accept ? accept.tests > 0 && accept.pass === accept.tests : true) &&
    (grade.stage === 'test' ? !!agentTests?.ok && agentTests.tests > 0 : true)
  return {
    pass,
    score,
    detail: [missing.length ? `missing: ${missing.join(', ')}` : '', failed].filter(Boolean).join('\n'),
    acceptance: accept ?? null,
    checkpoint: checkpoint ? { implement: checkpoint } : null,
    agentTests: agentTests ?? null,
  }
}

// Copies the paths a turn produced into <artifacts>/turn-<n>/.
export const snapshot = async (cwd: string, artifacts: string, turn: number, paths: readonly string[]) => {
  for (const p of paths) await copyPath(cwd, join(artifacts, `turn-${turn}`), p)
}
