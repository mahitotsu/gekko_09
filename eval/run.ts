// Runs every task under every arm and appends one JSON line per run.
//   npx tsx eval/run.ts [--reps 1] [--concurrency 2] [--arms opus,routed] [--tasks e1-timeout,h1-inventory-race]
//   npx tsx eval/run.ts --resume eval/results/<stamp>.jsonl   (runs only what that file lacks)
//   npx tsx eval/run.ts --env-only [--arms ...]   (starts each arm's session, records what it loaded, stops before any request)
// Auth: CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, in the environment
// (container/run.sh passes it through). Spends subscription usage.
// Results: eval/results/<stamp>.jsonl, and <stamp>.env.json for the environment.
// A run that never completed (usage limit, auth or API failure, crash) is not
// recorded and stops the whole eval: it says nothing about the arm, so it
// must not count as a fail. --resume continues from there.
import { execFile } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import {
  query,
  type Options,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import { routerLine, withRouter, type RouterOptions } from '../src/router'
import { buildRequests, type ProbeStep, type WriteSplit } from './cost'
import {
  assertNoSecret,
  checkHostEnv,
  contamination,
  hashOf,
  hostRecord,
  initRecord,
  runEnv,
  type InitRecord,
} from './env'
import { copyPath } from './scenarios'
import { gradeScenario, runTests, snapshot } from './scenario-grade'
import { TASKS, type Task } from './tasks'

const exec = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const PROBE_DIR = here('./probe')
const PROBE_PREFIX = 'eval-probe ' // as eval/probe/hooks/register.ts writes it
const PROBE_SETTINGS = 'eval-probe-settings '

const { values: args } = parseArgs({
  options: {
    reps: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    arms: { type: 'string' },
    tasks: { type: 'string' },
    resume: { type: 'string' },
    'env-only': { type: 'boolean', default: false },
    final: { type: 'boolean', default: false },
  },
})

// Commands the agent may run without asking. With no one to ask, anything
// else is denied and lands in the run's `denials`. Pipelines are allowed when
// every command in them is.
const ALLOWED_BASH = [
  'node', 'npm test', 'npm run', 'ls', 'find', 'grep', 'cat', 'head', 'tail', 'wc',
  'sort', 'uniq', 'diff', 'cut', 'tr', 'echo', 'pwd', 'cd', 'sed -n', 'file', 'stat', 'tree',
].map(c => `Bash(${c}:*)`)

// The eval measures Japanese use: Claude is told to answer in Japanese, as a
// Japanese user's settings would (the probe logs the setting the session ran with).
const LANGUAGE = 'japanese'

const base = (cwd: string, env: Record<string, string>): Options => ({
  cwd,
  env,
  settingSources: [], // no user/project settings, CLAUDE.md or memory
  // Reads outside the run's directory are refused: the image holds every
  // scenario's reference solution and hidden tests.
  settings: { language: LANGUAGE, permissions: { blockReadsOutsideWorkingDirectories: true } },
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Agent', ...ALLOWED_BASH],
  disallowedTools: ['WebSearch', 'WebFetch'],
  maxTurns: 40,
  persistSession: false,
})

const withSchedule = (o: Options, schedule: readonly object[]): Options => {
  const settings = typeof o.settings === 'object' ? o.settings : {}
  return {
    ...o,
    plugins: [...(o.plugins ?? []), { type: 'local', path: here('./schedule') }],
    settings: {
      ...settings,
      pluginConfigs: { ...settings.pluginConfigs, 'eval-schedule': { options: { schedule: JSON.stringify(schedule) } } },
    },
  }
}

const scheduled = (name: string, model: string, schedule: readonly object[]): Arm => ({
  name,
  plugins: ['eval-schedule', 'eval-probe'],
  experiment: true,
  options: (cwd, env) => withProbe(withSchedule({ ...base(cwd, env), model }, schedule)),
})

// Every arm loads the probe, last, so it sees each request as sent.
const withProbe = (o: Options): Options => ({ ...o, plugins: [...(o.plugins ?? []), { type: 'local', path: PROBE_DIR }] })

// `experiment` arms measure one mechanism (P1) and run only when named with --arms.
type Arm = {
  name: string
  plugins: string[]
  experiment?: boolean
  options: (cwd: string, env: Record<string, string>) => Options
  // Files the arm adds to the workspace before the session starts.
  setup?: (cwd: string) => Promise<void>
}

const fixed = (name: string, model: string, extra: Partial<Options> = {}): Arm => ({
  name,
  plugins: ['eval-probe'],
  options: (cwd, env) => withProbe({ ...base(cwd, env), model, ...extra }),
})

// The router on a session that starts on Opus (the setup it replaces); the
// options differ from the hybrid, Sonnet-base, delegate-docs default.
const routed = (name: string, router: RouterOptions): Arm => ({
  name,
  plugins: ['model-router', 'eval-probe'],
  options: (cwd, env) =>
    withProbe(withRouter({ ...base(cwd, env), model: 'claude-opus-5-5' }, { classifier: 'hybrid', ...router })),
})

// Opus on the main loop, subagents on Sonnet by settings alone, and a user
// CLAUDE.md that hands research to Explore (on the Pro plan, Claude Code
// spawns subagents only when the user asks; docs/plan.md, P4).
const SUBAGENT_CLAUDE_MD = `# 作業の進め方

- 資料やコードを広く読んで要点だけが要る調べ物は、Explore サブエージェントに任せてください。生の内容をこの会話に持ち込まず、要点だけを受け取るためです。
- 1つのファイルを読むだけで済む確認は、自分で行ってください。
`

const opusSub: Arm = {
  name: 'opus-sub',
  plugins: ['eval-probe'],
  options: (cwd, env) =>
    withProbe({
      ...base(cwd, { ...env, CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }),
      model: 'claude-opus-5-5',
      settingSources: ['project'], // the workspace's CLAUDE.md; the workspaces have no .claude/
    }),
  setup: cwd => writeFile(join(cwd, 'CLAUDE.md'), SUBAGENT_CLAUDE_MD),
}

// `opusplan` as the user runs it (docs/plan.md, P4): a copy of ~/.claude/CLAUDE.md
// (keep them in step), so the agent chooses when to plan. Nobody is there to
// approve, so canUseTool answers: ExitPlanMode and the plan file are allowed,
// everything else that reaches it is denied, as in the other arms.
const PLAN_CLAUDE_MD = `# 計画モードの使い方

計画モードに入ると、計画の間は Opus が応答します（計画ファイルしか書けません）。実行は Sonnet が行います。

## 判断の基準

最初の判断（何を作るか、どう解釈するか、何を書くか）を誤ると後の作業がやり直しになる依頼は、作業の前に計画モードに入ってください。判断が要らない依頼や、後から直せる依頼は、そのまま進めてください。

## 入る

- 新しい機能の実装、複数のファイルにまたがる変更、設計の判断が絡む依頼。
- 人が読む文書（要件定義、設計書、仕様書、報告書、調査レポート）を書く依頼。資料や情報を集めてまとめる場合も含みます。

## 入らない

- 値や場所を聞く質問、1か所の小さな修正。
- 作業の途中の短い続きの指示、計画を承認した後の実行。
- すでに多くの往復をした会話での小さな依頼。

## 迷ったとき

- 文書を書く依頼なら入る。それ以外は入らない。

## 計画に書くこと

- 文書: 構成、各節で書く要点とその根拠（資料のどこか）、漏れやすい観点、資料どうしが食い違うときにどちらを採るか。
- 実装: 依頼や資料で解釈が分かれる点の決定と理由、変更するファイルと手順、確かめ方。
- 短くてかまいませんが、決める点は省かないでください。
`

const opusPlan: Arm = {
  name: 'opusplan',
  plugins: ['eval-probe'],
  options: (cwd, env) =>
    withProbe({
      ...base(cwd, env),
      model: 'opusplan',
      settingSources: ['project'], // the workspace's CLAUDE.md
      canUseTool: async (tool, input) => {
        const file = typeof input.file_path === 'string' ? input.file_path : ''
        if (tool === 'ExitPlanMode' || tool === 'EnterPlanMode') return { behavior: 'allow', updatedInput: input }
        // The plan file lives under the run's own HOME (.claude/plans/).
        if ((tool === 'Write' || tool === 'Edit') && file.includes('/.claude/plans/')) return { behavior: 'allow', updatedInput: input }
        return { behavior: 'deny', message: 'この実行には承認する人がいません。計画モードでは計画だけを書き、ExitPlanMode で計画を確定してください。' }
      },
    }),
  setup: cwd => writeFile(join(cwd, 'CLAUDE.md'), PLAN_CLAUDE_MD),
}

const ARMS: Arm[] = [
  fixed('opus', 'claude-opus-5-5'),
  opusSub,
  opusPlan,
  routed('routed', {}),
  routed('routed-switch', { docs: 'switch' }),
  routed('routed-haiku', { base: 'haiku' }),
  fixed('opus-low', 'claude-opus-5-5', { effort: 'low' }),
  fixed('sonnet', 'claude-sonnet-5-5'),
  fixed('haiku', 'claude-haiku-5-5'),
  // P1: what a model or effort switch does to the prompt cache. Haiku at its
  // default effort (medium), switched by eval/schedule at a turn or a step.
  ...(
    [
      ['p1-fixed', []],
      ['p1-effort', [{ turn: 2, effort: 'low' }, { turn: 4, effort: 'medium' }]],
      ['p1-midturn', [{ turn: 1, step: 1, effort: 'low' }]],
      ['p1-model', [{ turn: 2, model: 'claude-sonnet-5-5' }, { turn: 3, model: 'claude-haiku-5-5' }]],
    ] as const
  ).map(([name, schedule]) => scheduled(name, 'claude-haiku-5-5', schedule)),
  // Whether an effort the mod sets mid-conversation reaches the API: turn 2
  // needs thought, so low and max should differ widely in tokens.
  scheduled('p1-think-low', 'claude-haiku-5-5', [{ turn: 1, effort: 'medium' }, { turn: 2, effort: 'low' }]),
  scheduled('p1-think-max', 'claude-haiku-5-5', [{ turn: 1, effort: 'medium' }, { turn: 2, effort: 'max' }]),
  // The same effort switch on the models the router changes effort on most.
  ...(['sonnet', 'opus'] as const).map(m =>
    scheduled(`p1-effort-${m}`, `claude-${m}-5-5`, [
      { turn: 1, effort: 'medium' },
      { turn: 2, effort: 'low' },
      { turn: 4, effort: 'medium' },
    ]),
  ),
]

// Raised when a run says nothing about the arm; stops the eval.
class Infra extends Error {}

const grade = async (
  task: Task,
  cwd: string,
  reply: string,
  artifacts: string,
  snapshotTurns: { turn: number; paths: readonly string[] }[],
) => {
  if (task.grade.kind === 'answer') return { pass: task.grade.check(reply), detail: '' }
  if (task.grade.kind === 'scenario') return gradeScenario(task.grade, cwd, artifacts, snapshotTurns)
  if (task.grade.kind === 'rubric') {
    await copyPath(cwd, join(artifacts, 'final'), task.grade.doc)
    const ok = await stat(join(cwd, task.grade.doc)).then(() => true, () => false)
    return { pass: ok, detail: ok ? '' : `missing: ${task.grade.doc}` }
  }
  await mkdir(join(cwd, 'test-hidden'), { recursive: true })
  await cp(here(`./${task.grade.dir ?? 'hidden'}/${task.grade.file}`), join(cwd, 'test-hidden', task.grade.file))
  const r = await runTests(cwd, 'node', ['--test'], 60_000)
  return { pass: r.count.ok, detail: r.failed.split('\n').slice(0, 5).join('\n') }
}

// The prompts of a multi-turn task, each sent once the previous turn's
// result has arrived.
const conversation = (prompts: readonly string[]) => {
  let release: (() => void) | undefined
  const turnEnded = () => {
    release?.()
    release = undefined
  }
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (const [i, text] of prompts.entries()) {
      if (i > 0) await new Promise<void>(r => (release = r))
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage
    }
    // Keep input open until the last turn ends, or the session closes early.
    await new Promise<void>(r => (release = r))
  }
  return { messages: messages(), turnEnded }
}

// Shared across workers: the first run's skills, which every later run must match.
const firstInit: { skills?: string[] } = {}
const inits = new Map<string, InitRecord>()

const checkInit = (m: SDKMessage, arm: Arm) => {
  if (m.type !== 'system' || m.subtype !== 'init') return undefined
  const init = initRecord(m)
  const bad = contamination(init, arm.plugins, firstInit.skills)
  if (bad) throw new Infra(`${arm.name}: ${bad}; results would be contaminated`)
  firstInit.skills ??= init.skills
  const id = hashOf(init)
  inits.set(id, init)
  return id
}

// The cache-write TTL split of one response, from its first streamed frame
// (whose output count is not final; the probe's is).
const splitOf = (m: SDKMessage & { type: 'assistant' }): WriteSplit | undefined => {
  const u = m.message.usage
  const split = u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
  if (!split) return undefined
  return {
    in: u.input_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: split.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1h: split.ephemeral_1h_input_tokens ?? 0,
  }
}

const INFRA_ERRORS = new Set([
  'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
  'billing_error', 'rate_limit', 'overloaded', 'server_error', 'cloud_credential_error', 'model_not_found',
])

const runOne = async (task: Task, arm: Arm, rep: number) => {
  const cwd = await mkdtemp(join(tmpdir(), `eval-${task.id.replace(/\//g, "_")}-${arm.name}-`))
  const home = await mkdtemp(join(tmpdir(), `eval-home-`))
  if (task.prepare) await task.prepare(cwd)
  else await cp(here(`./${task.fixture ?? 'fixture'}`), cwd, { recursive: true })
  await arm.setup?.(cwd)
  const prompts = typeof task.prompt === 'string' ? [task.prompt] : task.prompt
  // Kept documents and snapshots: <results>.artifacts/<task>/<arm>/<rep>/
  const artifactsRel = join(`${basename(out, '.jsonl')}.artifacts`, task.id, arm.name, String(rep))
  const artifacts = join(dirname(out), artifactsRel)
  const snapshotTurns: { turn: number; paths: readonly string[] }[] = []
  const started = Date.now()
  let initId: string | undefined
  let rateLimit: SDKRateLimitInfo | undefined
  let settings: { language?: string; timeZone?: string } | undefined
  const routerLog: string[] = []
  const steps: (ProbeStep & Record<string, unknown>)[] = []
  const splits = new Map<string, WriteSplit>()
  const turns: Record<string, unknown>[] = []
  let last: SDKResultMessage | undefined
  try {
    const armOptions = arm.options(cwd, await runEnv(home))
    const options = task.maxTurns ? { ...armOptions, maxTurns: task.maxTurns } : armOptions
    const convo = prompts.length > 1 ? conversation(prompts) : undefined
    for await (const m of query({ prompt: convo?.messages ?? prompts[0]!, options })) {
      initId ??= checkInit(m, arm)
      if (m.type === 'rate_limit_event') {
        rateLimit = m.rate_limit_info
        if (m.rate_limit_info.status === 'rejected') throw new Infra(`usage limit reached (${JSON.stringify(m.rate_limit_info)})`)
      }
      if (m.type === 'assistant') {
        if (m.error && INFRA_ERRORS.has(m.error)) throw new Infra(`API error: ${m.error}`)
        // Streamed frames of one response share its id; take the first.
        const split = splits.has(m.message.id) ? undefined : splitOf(m)
        if (split) splits.set(m.message.id, split)
      }
      const line = routerLine(m)
      if (line?.startsWith(PROBE_SETTINGS)) {
        settings = JSON.parse(line.slice(PROBE_SETTINGS.length))
        if (settings?.language !== LANGUAGE) throw new Infra(`${arm.name}: language is ${settings?.language}, expected ${LANGUAGE}`)
      } else if (line?.startsWith(PROBE_PREFIX)) steps.push(JSON.parse(line.slice(PROBE_PREFIX.length)))
      else if (line) routerLog.push(line)
      if (m.type === 'result') {
        last = m
        turns.push({
          subtype: m.subtype,
          isError: m.is_error,
          durationMs: m.duration_ms,
          durationApiMs: m.duration_api_ms,
          numTurns: m.num_turns,
          stopReason: m.stop_reason,
          errors: m.subtype === 'success' ? [] : m.errors,
        })
        // opusplan: the plan file may be rewritten each turn, so keep a copy per turn.
        await cp(join(home, '.claude', 'plans'), join(artifacts, 'plans', `turn-${turns.length}`), { recursive: true }).catch(() => undefined)
        const paths = task.snapshots?.[turns.length - 1]
        if (paths) {
          await snapshot(cwd, artifacts, turns.length, paths)
          snapshotTurns.push({ turn: turns.length, paths })
        }
        // After the last turn the input closes and the session ends by
        // itself; lines logged after the result (the router's) still arrive.
        convo?.turnEnded()
      }
    }
  } catch (err) {
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    if (err instanceof Infra) throw err
    throw new Infra(`${task.id} ${arm.name}: crashed: ${String(err)}`)
  }
  await rm(home, { recursive: true, force: true })
  if (!settings) {
    await rm(cwd, { recursive: true, force: true })
    throw new Infra(`${task.id} ${arm.name}: the probe did not report the session's settings`)
  }
  if (!last || turns.length < prompts.length) {
    await rm(cwd, { recursive: true, force: true })
    throw new Infra(`${task.id} ${arm.name}: ${turns.length}/${prompts.length} turns completed`)
  }
  // An error result with no model response at all is the API's failure, not the arm's.
  if (last.is_error && steps.length === 0) {
    await rm(cwd, { recursive: true, force: true })
    throw new Infra(`${task.id} ${arm.name}: no model response: ${last.subtype === 'success' ? last.result : last.errors.join('; ')}`)
  }
  const reply = last.subtype === 'success' ? last.result : ''
  const graded = await grade(task, cwd, reply, artifacts, snapshotTurns)
  await rm(cwd, { recursive: true, force: true })
  const { requests, unmatched } = buildRequests(steps, [...splits.values()], last.modelUsage)
  const main = requests.filter(r => r.agent === null)
  return {
    schema: 2,
    task: task.id,
    level: task.level,
    arm: arm.name,
    rep,
    wallMs: Date.now() - started,
    ...graded,
    subtype: last.subtype,
    // Cumulative over the conversation, as of its last result.
    costUsd: last.total_cost_usd, // the SDK's estimate; eval/cost.ts reprices from `requests`
    modelUsage: last.modelUsage,
    durationMs: turns.reduce((s, t) => s + Number(t.durationMs), 0),
    durationApiMs: last.duration_api_ms, // cumulative across turns, unlike durationMs
    numTurns: turns.reduce((s, t) => s + Number(t.numTurns), 0),
    turns,
    initId,
    settings,
    firstRequestInputTokens: main[0] ? main[0].in + main[0].cacheRead + main[0].cacheWrite5m + main[0].cacheWrite1h : null,
    requests,
    unmatchedWriteSplits: unmatched,
    steps,
    denials: last.permission_denials.map(d => ({
      tool: d.tool_name,
      input: JSON.stringify(d.tool_input).slice(0, 300),
    })),
    rateLimit: rateLimit ?? null,
    artifacts: task.grade.kind === 'scenario' || task.grade.kind === 'rubric' ? artifactsRel : null,
    routerLog,
    reply: reply.slice(0, 2000),
  }
}

// Starts the arm's session and stops it at init, before any model request.
const envOnly = async (arm: Arm) => {
  const cwd = await mkdtemp(join(tmpdir(), `eval-env-${arm.name}-`))
  const home = await mkdtemp(join(tmpdir(), `eval-home-`))
  await arm.setup?.(cwd)
  const q = query({ prompt: 'hi', options: arm.options(cwd, await runEnv(home)) })
  try {
    for await (const m of q) {
      const id = checkInit(m, arm)
      if (id) return id
    }
    throw new Infra(`${arm.name}: session ended without init`)
  } finally {
    await q.interrupt().catch(() => {})
    q.close?.()
    await rm(cwd, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

// A resume repeats the arms, tasks and reps of the invocation it continues
// unless they are given again.
const resumed = args.resume
  ? ((await readFile(args.resume.replace(/\.jsonl$/, '.env.json'), 'utf8').then(JSON.parse, () => undefined))?.invocations?.[0]
      ?.args as { reps: number; arms: string[]; tasks: string[] } | undefined)
  : undefined
const armNames = args.arms?.split(',') ?? resumed?.arms
const taskIds = args.tasks?.split(',') ?? resumed?.tasks
const arms = armNames ? ARMS.filter(a => armNames.includes(a.name)) : ARMS.filter(a => !a.experiment)
// --tasks takes ids, or a prefix ending in * (invoice/*). With no --tasks:
// the small dev tasks (and the final ones too with --final). Naming a
// final-split task needs --final.
const named = (id: string) => taskIds!.some(t => (t.endsWith('*') ? id.startsWith(t.slice(0, -1)) : id === t))
const tasks = taskIds
  ? TASKS.filter(t => named(t.id))
  : TASKS.filter(t => !t.smoke && t.level !== 'scenario' && (args.final || t.split !== 'final'))
const finals = tasks.filter(t => t.split === 'final')
if (finals.length && !args.final) {
  console.error(`final-split tasks need --final (they stay untouched while the router is tuned): ${finals.map(t => t.id).join(', ')}`)
  process.exit(1)
}
const reps = process.argv.includes('--reps') || !resumed ? Number(args.reps) : resumed.reps
const concurrency = Number(args.concurrency)

checkHostEnv({ needToken: !args['env-only'] })
await mkdir(here('./results'), { recursive: true })
const out = args.resume ?? here(`./results/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
const envFile = out.replace(/\.jsonl$/, '.env.json')

// The environment file holds one entry per invocation (a resume adds one),
// and every distinct init the runs saw, by the id each row carries.
const writeEnv = async (stopped?: unknown) => {
  const prev = await readFile(envFile, 'utf8').then(JSON.parse, () => ({ invocations: [], inits: {} }))
  prev.invocations.push(
    hostRecord({ startedAt, args: { reps, concurrency, arms: arms.map(a => a.name), tasks: tasks.map(t => t.id) }, stopped: stopped ? String(stopped) : null }),
  )
  Object.assign(prev.inits, Object.fromEntries(inits))
  const text = JSON.stringify(prev, null, 1)
  assertNoSecret(text)
  await writeFile(envFile, text + '\n')
}
const startedAt = new Date().toISOString()

if (args['env-only']) {
  for (const arm of arms) console.log(`${arm.name.padEnd(8)} init ${await envOnly(arm)}`)
  await writeEnv()
  console.log(`-> ${envFile}`)
  process.exit(0)
}

// Interleave arms within each task so drift in API latency hits every arm alike.
let jobs = Array.from({ length: reps }, (_, rep) => tasks.flatMap(t => arms.map(a => ({ t, a, rep })))).flat()
if (args.resume) {
  const rows = (await readFile(args.resume, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  const have = new Set(rows.map(r => `${r.task}/${r.arm}/${r.rep}`))
  jobs = jobs.filter(j => !have.has(`${j.t.id}/${j.a.name}/${j.rep}`))
  // Later runs must load the same skills as the ones already recorded.
  const prevEnv = await readFile(envFile, 'utf8').then(JSON.parse, () => undefined)
  const anyInit = prevEnv && (Object.values(prevEnv.inits)[0] as InitRecord | undefined)
  if (anyInit) firstInit.skills = anyInit.skills
}
console.log(`${jobs.length} runs, concurrency ${concurrency} -> ${out}`)

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
    const line = JSON.stringify({ ...r, concurrency })
    assertNoSecret(line)
    await appendFile(out, line + '\n')
    done++
    const answered = r.steps as { agent: string | null; model: string; answered: string | null }[]
    const misordered = answered.filter(s => s.answered && s.answered !== s.model).length
    console.log(
      `[${done}] ${r.task} ${r.arm.padEnd(8)} ${r.pass ? 'PASS' : 'FAIL'} $${Number(r.costUsd ?? 0).toFixed(4)} ${r.durationMs}ms` +
        `${r.denials.length ? ` denied=${r.denials.length}` : ''}${misordered ? ` probe-mismatch=${misordered}` : ''} ${r.routerLog.join(' | ')}`,
    )
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
await writeEnv(stopped)
if (stopped) {
  console.error(`stopped: ${String(stopped)}\nresume with: npx tsx eval/run.ts --resume ${out}`)
  process.exit(1)
}
