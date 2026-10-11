// Blind pairwise comparison of scenario documents by an independent model.
//   npx tsx eval/compare-docs.ts eval/results/<stamp>.jsonl [...more] --pairs haiku:opus[,sonnet:opus]
//     [--docs requirements.md,design.md,spec.md,report.md] [--dry-run] [--concurrency 2]
// For each document type and each pair of arms, every document of one arm is
// compared with every document of the other from the same task (script with
// script, auto with auto), twice with the order swapped.
// The judge gets the scenario's materials (the source of truth), the two
// documents as 文書1 and 文書2 (no arm, task or run names), and, for the
// report, each run's actual `npm test` output. It lists each document's
// statements that contradict the materials and the important omissions,
// then picks the better one or a tie. A side wins only when both orders agree.
// Spends subscription usage (Opus); --dry-run builds the prompts and counts them.
// Results: <first file>.compare.jsonl (.compare.<model>.jsonl for a judge other than
// the default), one line per comparison; a rerun skips what it has.
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { DOCS, readProduct } from './docs'
import { assertNoSecret, checkHostEnv, runEnv } from './env'
import { scenarioDir, SCENARIOS } from './scenarios'

const DEFAULT_JUDGE = 'claude-opus-5-5'
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pairs: { type: 'string' },
    docs: { type: 'string', default: 'requirements.md,design.md,spec.md,report.md' },
    'dry-run': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '2' },
    model: { type: 'string', default: DEFAULT_JUDGE },
  },
})
if (!positionals.length || !args.pairs) throw new Error('give results files and --pairs a:b[,c:d]')
const pairs = args.pairs.split(',').map(p => p.split(':') as [string, string])
const docTypes = args.docs.split(',')

const MAX_DOC = 60_000 // characters of one document shown to the judge

// One document a run produced.
type Doc = { scenario: string; task: string; type: string; arm: string; file: string; rep: number; root: string; id: string }
const docs: Doc[] = []
for (const file of positionals) {
  const stamp = file.replace(/^.*\//, '').replace(/\.jsonl$/, '')
  for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { task: string; arm: string; rep: number; artifacts: string | null }
    const [scenario, part] = row.task.split('/') as [string, string]
    const s = SCENARIOS.find(x => x.id === scenario)
    if (!s || !row.artifacts) continue
    const stage = part.startsWith('stage-') ? s.stages[Number(part.slice(6)) - 1]!.id : undefined
    for (const d of DOCS.filter(d => docTypes.includes(d.rubric) && (!stage || d.stage === stage)))
      docs.push({ scenario, task: row.task, type: d.rubric, arm: row.arm, file: stamp, rep: row.rep, root: join(dirname(file), row.artifacts, 'final'),
        id: `${row.task}/${row.arm}/${stamp}/${row.rep}` })
  }
}

// Every pairing, in both orders.
type Job = { key: string; scenario: string; type: string; first: Doc; second: Doc; order: 'ab' | 'ba' }
const jobs: Job[] = []
for (const [a, b] of pairs)
  for (const type of docTypes)
    for (const x of docs.filter(d => d.type === type && d.arm === a))
      for (const y of docs.filter(d => d.type === type && d.arm === b && d.task === x.task))
        for (const order of ['ab', 'ba'] as const) {
          const [first, second] = order === 'ab' ? [x, y] : [y, x]
          jobs.push({ key: `${type}|${x.id}|${y.id}|${order}`, scenario: x.scenario, type, first, second, order })
        }

const out = positionals[0]!.replace(/\.jsonl$/, args.model === DEFAULT_JUDGE ? '.compare.jsonl' : `.compare.${args.model}.jsonl`)
const done = new Set(
  (await readFile(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l).key as string),
)
const todo = jobs.filter(j => !done.has(j.key))
// Shuffle so neither arm nor order reaches the judge in a pattern.
for (let i = todo.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1))
  ;[todo[i], todo[j]] = [todo[j]!, todo[i]!]
}
console.log(`${todo.length} comparisons (${docs.length} documents) -> ${out}`)

// The materials (Markdown only; the sample data is quoted in the spec) go in
// the system prompt, so every comparison of a scenario reads them from cache.
const materials = async (scenario: string) => {
  const dir = join(scenarioDir(scenario), 'materials')
  const names = (await readdir(dir)).filter(n => n.endsWith('.md')).sort()
  return (await Promise.all(names.map(async n => `### ${n}\n\n${await readFile(join(dir, n), 'utf8')}`))).join('\n\n')
}

const TYPE_NAMES: Record<string, string> = {
  'requirements.md': '要件定義（docs/requirements.md）',
  'design.md': '設計書（docs/design.md）',
  'spec.md': '最終の仕様書（docs/spec.md）',
  'report.md': '作業の報告書（docs/report.md）',
}

const system = (mats: string) => `あなたは、同じ依頼に対して別々に作られた2つの文書を比べる評価者です。
元の資料（議事録・規程・連携仕様書）を正として、2つの文書の正しさと有用さを比べます。

- 議事録の途中で決定が変わった点は、最終の決定が正しい。見送りになった要望を、決定として書いていれば誤り。
- 各文書について、資料と食い違う記述（誤り）を、文書からの短い引用と、資料のどこと食い違うかを添えてすべて挙げる。
- 各文書について、その種類の文書に欠かせないのに書かれていない重要な点（漏れ）を挙げる。
- 長さや書式の好みで判断しない。長いことは利点ではない。正しさ、要件の網羅、読み手（実装者・利用者）にとっての有用さで判断する。
- 文書が作られた順番や、文書1・文書2という並びは判断に使わない。
- 最後に、どちらが良いか（1、2、または同等）と、その決め手を書く。差が小さければ同等とする。

## 元の資料

${mats}`

const promptFor = (job: Job, texts: string[], tests: (string | undefined)[]) => {
  const part = (n: number, text: string, test?: string) =>
    `## 文書${n}\n\n${text.length > MAX_DOC ? text.slice(0, MAX_DOC) + '\n…（以下省略）' : text}` +
    (test !== undefined ? `\n\n### 参考: 文書${n}の作業ディレクトリで実行した npm test の結果（末尾）\n\n\`\`\`\n${test}\n\`\`\`` : '')
  return `比べる文書の種類: ${TYPE_NAMES[job.type] ?? job.type}\n\n${part(1, texts[0]!, tests[0])}\n\n${part(2, texts[1]!, tests[1])}`
}

const finding = { type: 'object', properties: { quote: { type: 'string' }, reason: { type: 'string' } }, required: ['quote', 'reason'] }
const side = {
  type: 'object',
  properties: { errors: { type: 'array', items: finding }, omissions: { type: 'array', items: { type: 'string' } } },
  required: ['errors', 'omissions'],
}
const schema = {
  type: 'object',
  properties: { doc1: side, doc2: side, better: { type: 'string', enum: ['1', '2', '同等'] }, reason: { type: 'string' } },
  required: ['doc1', 'doc2', 'better', 'reason'],
}
type Side = { errors: { quote: string; reason: string }[]; omissions: string[] }
type Verdict = { doc1: Side; doc2: Side; better: '1' | '2' | '同等'; reason: string }

const npmTest = (d: Doc) =>
  readFile(join(d.root, 'npm-test.txt'), 'utf8').then(t => t.split('\n').slice(-40).join('\n'), () => '（結果なし）')

const compareOne = async (job: Job) => {
  const docsOf = [job.first, job.second]
  const texts = await Promise.all(docsOf.map(d => readProduct(d.root, DOCS.find(x => x.rubric === job.type)!.paths[0]!)))
  const tests = job.type === 'report.md' ? await Promise.all(docsOf.map(npmTest)) : [undefined, undefined]
  const base = {
    key: job.key, scenario: job.scenario, type: job.type, order: job.order,
    first: { arm: job.first.arm, id: job.first.id }, second: { arm: job.second.arm, id: job.second.id },
  }
  if (texts.some(t => t === undefined)) return { ...base, missing: texts.map(t => t === undefined) }
  const sys = system(await materials(job.scenario))
  const prompt = promptFor(job, texts as string[], tests)
  if (args['dry-run']) return { ...base, dryRun: true, systemChars: sys.length, promptChars: prompt.length }

  const home = await mkdtemp(join(tmpdir(), 'compare-docs-'))
  try {
    let result: Verdict | undefined
    let usage: unknown
    for await (const m of query({
      prompt,
      options: {
        model: args.model,
        systemPrompt: sys,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 6, // Sonnet sometimes needs several tries to match the schema
        cwd: home,
        // Each pair of documents is read once: a 5-minute cache write costs
        // 1.25x input instead of 2x, and the materials are reread well within it.
        env: { ...(await runEnv(home)), CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' },
        outputFormat: { type: 'json_schema', schema },
      },
    })) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error(`judge failed: ${m.subtype} ${m.errors.join('; ')}`)
        result = m.structured_output as Verdict
        usage = m.modelUsage
      }
    }
    if (!result) throw new Error('judge returned no structured output')
    const winner = result.better === '同等' ? null : (result.better === '1' ? job.first : job.second).arm
    return { ...base, model: args.model, winner, verdict: result, usage }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

checkHostEnv({ needToken: !args['dry-run'] })
let stopped: unknown
let chars = 0
const worker = async () => {
  for (let job = todo.shift(); job && !stopped; job = todo.shift()) {
    try {
      const r = await compareOne(job)
      if ('dryRun' in r) {
        chars += r.systemChars + r.promptChars
        console.log(`${r.key}: system ${r.systemChars} + prompt ${r.promptChars} chars`)
        continue
      }
      if ('missing' in r) {
        console.log(`${r.key}: missing document, skipped`)
        continue
      }
      const line = JSON.stringify(r)
      assertNoSecret(line)
      await appendFile(out, line + '\n')
      const v = r.verdict
      console.log(`${r.key}: ${r.winner ?? 'tie'} (errors ${v.doc1.errors.length}/${v.doc2.errors.length})`)
    } catch (err) {
      stopped ??= err
    }
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker))
if (args['dry-run']) console.log(`total ${chars} chars`)
if (stopped) {
  console.error(`stopped: ${String(stopped)}\nrerun the same command to continue`)
  process.exit(1)
}
