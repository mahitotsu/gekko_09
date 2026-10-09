// Runs every task under every arm and appends one JSON line per run.
//   npx tsx eval/run.ts [--reps 1] [--concurrency 2] [--arms opus,routed] [--tasks e1-timeout,h1-inventory-race]
//   npx tsx eval/run.ts --resume eval/results/<stamp>.jsonl   (runs only what that file lacks)
// Spends real API usage. Results: eval/results/<stamp>.jsonl
// A run that never reached the model (usage limit, crash) is not recorded and
// stops the whole eval: it says nothing about the arm, so it must not count as a fail.
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'

import { routerLine, withRouter } from '../src/router'
import { TASKS, type Task } from './tasks'

const exec = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const { values: args } = parseArgs({
  options: {
    reps: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    arms: { type: 'string' },
    tasks: { type: 'string' },
    resume: { type: 'string' },
  },
})

// The process env without anything that would load plugins behind our back
// (~/.claude/settings.json loads model-router everywhere via this variable).
const { CLAUDE_CODE_PLUGIN_DIRS: _drop, ...cleanEnv } = process.env

const base = (cwd: string): Options => ({
  cwd,
  settingSources: [], // no user/project settings, CLAUDE.md or memory
  env: cleanEnv as Record<string, string>,
  permissionMode: 'acceptEdits',
  allowedTools: [
    'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent',
    'Bash(node:*)', 'Bash(npm test:*)', 'Bash(ls:*)', 'Bash(find:*)', 'Bash(grep:*)', 'Bash(cat:*)',
  ],
  disallowedTools: ['WebSearch', 'WebFetch'],
  maxTurns: 40,
  persistSession: false,
})

type Arm = { name: string; withRouter: boolean; options: (cwd: string) => Options }

const ARMS: Arm[] = [
  { name: 'opus', withRouter: false, options: cwd => ({ ...base(cwd), model: 'claude-opus-5-5' }) },
  {
    name: 'routed',
    withRouter: true,
    options: cwd => withRouter({ ...base(cwd), model: 'claude-opus-5-5' }, { classifier: 'hybrid' }),
  },
  { name: 'opus-low', withRouter: false, options: cwd => ({ ...base(cwd), model: 'claude-opus-5-5', effort: 'low' }) },
  { name: 'sonnet', withRouter: false, options: cwd => ({ ...base(cwd), model: 'claude-sonnet-5-5' }) },
]

const grade = async (task: Task, cwd: string, reply: string) => {
  if (task.grade.kind === 'answer') return { pass: task.grade.check(reply), detail: '' }
  await mkdir(join(cwd, 'test-hidden'), { recursive: true })
  await cp(here(`./${task.grade.dir ?? 'hidden'}/${task.grade.file}`), join(cwd, 'test-hidden', task.grade.file))
  try {
    await exec('node', ['--test'], { cwd, timeout: 60_000 })
    return { pass: true, detail: '' }
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? err)
    return { pass: false, detail: out.split('\n').filter(l => /^not ok|✖/.test(l)).slice(0, 5).join('\n') }
  }
}

const runOne = async (task: Task, arm: Arm, rep: number) => {
  const cwd = await mkdtemp(join(tmpdir(), `eval-${task.id}-${arm.name}-`))
  await cp(here(`./${task.fixture ?? 'fixture'}`), cwd, { recursive: true })
  const started = Date.now()
  let reply = ''
  let routerLoaded: boolean | undefined
  const routerLog: string[] = []
  let result: { costUsd?: number; durationMs?: number; [k: string]: unknown } = {}
  try {
    for await (const m of query({ prompt: task.prompt, options: arm.options(cwd) })) {
      if (m.type === 'system' && m.subtype === 'init')
        routerLoaded = m.plugins.some(p => p.name === 'model-router')
      const line = routerLine(m)
      if (line) routerLog.push(line)
      if (m.type === 'result') {
        if (m.subtype === 'success') reply = m.result
        result = {
          subtype: m.subtype,
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          durationApiMs: m.duration_api_ms,
          numTurns: m.num_turns,
          modelUsage: m.modelUsage,
        }
      }
    }
  } catch (err) {
    result = { subtype: 'crash', error: String(err) }
  }
  if (result.subtype === 'crash' || result.subtype === undefined) {
    await rm(cwd, { recursive: true, force: true })
    throw new Error(`${task.id} ${arm.name}: run did not complete: ${String(result.error ?? 'no result')}`)
  }
  if (routerLoaded !== arm.withRouter)
    throw new Error(`${arm.name}: model-router loaded=${routerLoaded}, expected ${arm.withRouter}; results would be contaminated`)
  const graded = await grade(task, cwd, reply)
  await rm(cwd, { recursive: true, force: true })
  return {
    task: task.id,
    level: task.level,
    arm: arm.name,
    rep,
    wallMs: Date.now() - started,
    ...graded,
    ...result,
    routerLog,
    reply: reply.slice(0, 2000),
  }
}

const arms = args.arms ? ARMS.filter(a => args.arms!.split(',').includes(a.name)) : ARMS
const tasks = args.tasks ? TASKS.filter(t => args.tasks!.split(',').includes(t.id)) : TASKS
const reps = Number(args.reps)

// Interleave arms within each task so drift in API latency hits every arm alike.
let jobs = Array.from({ length: reps }, (_, rep) => tasks.flatMap(t => arms.map(a => ({ t, a, rep })))).flat()

await mkdir(here('./results'), { recursive: true })
const out = args.resume ?? here(`./results/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
if (args.resume) {
  const have = new Set(
    (await readFile(args.resume, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .map(r => `${r.task}/${r.arm}/${r.rep}`),
  )
  jobs = jobs.filter(j => !have.has(`${j.t.id}/${j.a.name}/${j.rep}`))
}
console.log(`${jobs.length} runs -> ${out}`)

let done = 0
let stopped: unknown
const worker = async () => {
  for (let job = jobs.shift(); job && !stopped; job = jobs.shift()) {
    let r
    try {
      r = await runOne(job.t, job.a, job.rep)
    } catch (err) {
      stopped ??= err
      break
    }
    await appendFile(out, JSON.stringify(r) + '\n')
    done++
    console.log(
      `[${done}] ${r.task} ${r.arm.padEnd(8)} ${r.pass ? 'PASS' : 'FAIL'} $${Number(r.costUsd ?? 0).toFixed(4)} ${r.durationMs ?? '-'}ms ${r.routerLog.join(' | ')}`,
    )
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker))
if (stopped) {
  console.error(`stopped: ${String(stopped)}\nresume with: npx tsx eval/run.ts --resume ${out}`)
  process.exit(1)
}
