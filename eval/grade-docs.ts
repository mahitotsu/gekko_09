// Blind grading of scenario documents against their rubrics (eval/scenarios/<id>/rubric).
//   npx tsx eval/grade-docs.ts eval/results/<stamp>.jsonl [--dry-run] [--at final|stage-end] [--concurrency 2]
// Each document is shown with its checklist only: no arm, task or run names,
// in shuffled order. The grader scores every item 0 or 1 with a short quote
// as evidence. The report is graded together with the run's actual `npm test`
// output, so claims about the tests can be checked.
// Spends subscription usage (Opus); --dry-run builds the prompts and counts them.
// Results: <stamp>.grades.jsonl, one line per document; a rerun skips what it has.
import { appendFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { assertNoSecret, checkHostEnv, runEnv } from './env'
import { scenarioDir, SCENARIOS } from './scenarios'
import { TASKS } from './tasks'
import type { StageId } from './scenarios/types'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    at: { type: 'string', default: 'final' },
    concurrency: { type: 'string', default: '2' },
    model: { type: 'string', default: 'claude-opus-5-5' },
  },
})

// Which rubric grades which product of which stage.
const DOCS: { stage: StageId; rubric: string; paths: string[] }[] = [
  { stage: 'requirements', rubric: 'requirements.md', paths: ['docs/requirements.md'] },
  { stage: 'design', rubric: 'design.md', paths: ['docs/design.md'] },
  { stage: 'test', rubric: 'tests.md', paths: ['test/'] },
  { stage: 'report', rubric: 'spec.md', paths: ['docs/spec.md'] },
  { stage: 'report', rubric: 'report.md', paths: ['docs/report.md'] },
]
const MAX_DOC = 60_000 // characters of one document shown to the grader

type Row = { task: string; arm: string; rep: number; artifacts: string | null }
// A rubric (file path), the products it grades, and where to read them.
type Job = { row: Row; rubric: string; paths: string[]; root: string; key: string }

const exists = (p: string) => stat(p).then(() => true, () => false)

// The text of a product: one file, or every file under a directory.
const readProduct = async (root: string, path: string): Promise<string | undefined> => {
  const p = join(root, path.replace(/\/$/, ''))
  if (!(await exists(p))) return undefined
  if (!path.endsWith('/')) return readFile(p, 'utf8')
  const parts: string[] = []
  const walk = async (dir: string, rel: string) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${rel}${e.name}/`)
      else parts.push(`--- ${path}${rel}${e.name}\n${await readFile(join(dir, e.name), 'utf8')}`)
    }
  }
  await walk(p, '')
  return parts.join('\n\n')
}

const items = (rubric: string) =>
  [...rubric.matchAll(/^- ([A-Z]\d+): (.+)$/gm)].map(m => ({ id: m[1]!, text: m[2]! }))

const SYSTEM = `あなたは文書の採点者です。渡された文書を、採点基準の各項目について、満たしていれば 1、満たしていなければ 0 で採点します。
- 文書に書かれていることだけで判断し、推測で補わない。
- 根拠として、判断の決め手になった文書の箇所を 100 字以内で引用する（0 の場合は、欠けている点を短く書く）。
- すべての項目を採点する。`

const promptFor = (rubric: string, doc: string, extra?: string) =>
  `## 採点基準\n\n${rubric}\n\n## 採点する文書\n\n${doc.length > MAX_DOC ? doc.slice(0, MAX_DOC) + '\n…（以下省略）' : doc}` +
  (extra ? `\n\n## 参考: 作業ディレクトリで実行した npm test の結果（末尾）\n\n\`\`\`\n${extra}\n\`\`\`` : '')

const schema = (ids: string[]) => ({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', enum: ids }, score: { type: 'integer', enum: [0, 1] }, evidence: { type: 'string' } },
        required: ['id', 'score', 'evidence'],
      },
    },
  },
  required: ['items'],
})

const rows: Row[] = (await Promise.all(positionals.map(f => readFile(f, 'utf8'))))
  .flatMap(t => t.split('\n').filter(Boolean))
  .map(l => JSON.parse(l))
  .filter((r: Row) => r.artifacts)
if (positionals.length !== 1) throw new Error('give one results file')
const resultsDir = dirname(positionals[0]!)
const out = positionals[0]!.replace(/\.jsonl$/, '.grades.jsonl')
const done = new Set(
  (await readFile(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l).key as string),
)

// One job per document a run produced: a small design task's document, or
// every document of the scenario stages the task covered.
const jobs: Job[] = []
const evalDir = fileURLToPath(new URL('./', import.meta.url))
for (const row of rows) {
  const task = TASKS.find(t => t.id === row.task)
  if (task?.grade.kind === 'rubric') {
    const key = `${row.task}/${row.arm}/${row.rep}/${basename(task.grade.rubric)}/final`
    if (!done.has(key))
      jobs.push({ row, rubric: join(evalDir, task.grade.rubric), paths: [task.grade.doc], root: join(resultsDir, row.artifacts!, 'final'), key })
    continue
  }
  const [scenario, part] = row.task.split('/') as [string, string]
  const s = SCENARIOS.find(x => x.id === scenario)
  if (!s) continue
  const stage = part.startsWith('stage-') ? s.stages[Number(part.slice(6)) - 1]!.id : undefined
  for (const doc of DOCS.filter(d => !stage || d.stage === stage)) {
    // At stage-end, grade the snapshot taken when the document's stage ended.
    let root = join(resultsDir, row.artifacts!, 'final')
    if (args.at === 'stage-end' && !stage) {
      const turn = s.stages.slice(0, s.stages.findIndex(x => x.id === doc.stage) + 1).flatMap(x => [x.prompt, ...(x.followUps ?? [])]).length
      root = join(resultsDir, row.artifacts!, `turn-${turn}`)
    }
    const key = `${row.task}/${row.arm}/${row.rep}/${doc.rubric}/${args.at}`
    if (!done.has(key)) jobs.push({ row, rubric: join(scenarioDir(scenario), 'rubric', doc.rubric), paths: doc.paths, root, key })
  }
}
// Shuffle so neither arm nor task order reaches the grader.
for (let i = jobs.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  ;[jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]
}
console.log(`${jobs.length} documents to grade -> ${out}`)

const gradeOne = async (job: Job) => {
  const rubric = await readFile(job.rubric, 'utf8')
  const ids = items(rubric).map(i => i.id)
  const texts = await Promise.all(job.paths.map(p => readProduct(job.root, p)))
  const name = basename(job.rubric)
  const base = { key: job.key, task: job.row.task, arm: job.row.arm, rep: job.row.rep, rubric: name, at: args.at }
  if (texts.every(t => t === undefined)) return { ...base, missing: true, score: 0, max: ids.length, items: [] }
  const extra =
    name === 'report.md'
      ? (await readFile(join(job.root, '..', 'final', 'npm-test.txt'), 'utf8').catch(() => '（結果なし）')).split('\n').slice(-40).join('\n')
      : undefined
  const prompt = promptFor(rubric, texts.filter(Boolean).join('\n\n'), extra)
  if (args['dry-run']) return { ...base, dryRun: true, promptChars: prompt.length, max: ids.length }

  const home = await mkdtemp(join(tmpdir(), 'grade-docs-'))
  try {
    let result: { items: { id: string; score: number; evidence: string }[] } | undefined
    let usage: unknown
    for await (const m of query({
      prompt,
      options: {
        model: args.model,
        systemPrompt: SYSTEM,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        cwd: home,
        env: await runEnv(home),
        outputFormat: { type: 'json_schema', schema: schema(ids) },
      },
    })) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error(`grader failed: ${m.subtype} ${m.errors.join('; ')}`)
        result = m.structured_output as typeof result
        usage = m.modelUsage
      }
    }
    if (!result) throw new Error('grader returned no structured output')
    const byId = new Map(result.items.map(i => [i.id, i]))
    const scored = ids.map(id => ({ id, score: byId.get(id)?.score ?? 0, evidence: byId.get(id)?.evidence ?? '（採点なし）' }))
    return { ...base, model: args.model, score: scored.reduce((s, i) => s + i.score, 0), max: ids.length, items: scored, usage }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

checkHostEnv({ needToken: !args['dry-run'] })
let stopped: unknown
const worker = async () => {
  for (let job = jobs.shift(); job && !stopped; job = jobs.shift()) {
    try {
      const r = await gradeOne(job)
      if (args['dry-run']) {
        console.log(`${r.key}: ${'promptChars' in r ? `${r.promptChars} chars` : 'missing'}, ${r.max} items`)
        continue
      }
      const line = JSON.stringify(r)
      assertNoSecret(line)
      await appendFile(out, line + '\n')
      console.log(`${r.key}: ${'score' in r ? r.score : '-'}/${r.max}`)
    } catch (err) {
      stopped ??= err
    }
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker))
if (stopped) {
  console.error(`stopped: ${String(stopped)}\nrerun the same command to continue`)
  process.exit(1)
}
