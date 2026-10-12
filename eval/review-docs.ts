// Has a stronger model review and correct the documents of finished runs, to
// measure whether "Sonnet writes, Opus reviews" reaches Opus's documents
// (the router's planned `docs: review`) before building it into the mod.
//   npx tsx eval/review-docs.ts eval/results/<stamp>.jsonl --arm sonnet
//     [--model claude-opus-5-5] [--docs requirements.md,design.md,spec.md,report.md] [--dry-run]
// Each run's final products are copied with the scenario's materials into a
// fresh workspace (docs/資料, as the agent saw them). The reviewer gets one
// document per session, in the order the stages write them, with Read, Glob,
// Grep and Edit only, and may edit nothing but that document: the cold start
// a review subagent would have. The corrected products land in
// <stamp>-review.artifacts/ and one row per run in <stamp>-review.jsonl, with
// arm `<arm>-reviewed`, so compare-docs can pair them:
//   npx tsx eval/compare-docs.ts eval/results/<stamp>-review.jsonl eval/results/<opus>.jsonl --pairs sonnet-reviewed:opus
// Spends subscription usage; a rerun skips the runs it has.
import { appendFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { query } from '@anthropic-ai/claude-agent-sdk'

import { DOCS, exists } from './docs'
import { assertNoSecret, checkHostEnv, runEnv } from './env'
import { scenarioDir, SCENARIOS } from './scenarios'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arm: { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    docs: { type: 'string', default: 'requirements.md,design.md,spec.md,report.md' },
    'dry-run': { type: 'boolean', default: false },
  },
})
if (positionals.length !== 1 || !args.arm) throw new Error('give one results file and --arm')
const file = positionals[0]!
const docTypes = args.docs.split(',')
const stamp = file.replace(/^.*\//, '').replace(/\.jsonl$/, '')
const out = join(dirname(file), `${stamp}-review.jsonl`)
const arm = `${args.arm}-reviewed`

const TYPE_NAMES: Record<string, string> = {
  'requirements.md': '要件定義',
  'design.md': '設計書',
  'spec.md': '最終の仕様書',
  'report.md': '作業の報告書',
}

const SYSTEM = `あなたは、別の担当者が書いた文書を見直して直す担当です。
docs/資料/ にある元の資料（議事録・規程・連携仕様書・サンプルデータ）を正とします。

- 資料と食い違う記述を直す。議事録の途中で決定が変わった点は、最終の決定が正しい。見送りになった要望を決定として書いていれば直す。
- その種類の文書に欠かせないのに書かれていない重要な点を書き足す。
- 正しく書けている部分は書き直さない。文体や構成の好みで変えない。長くすること自体を目的にしない。
- 直すのは指定された文書だけ。src/ と test/ は確認のために読んでよいが、変えない。
- 最後に、直した点を短い箇条書きで返す（直す必要がなければ、そう書く）。`

const promptFor = (type: string, path: string) =>
  `${path}（${TYPE_NAMES[type] ?? type}）を見直して、必要なところを Edit で直してください。` +
  (type === 'report.md' ? '\n報告書のテストの結果は、npm-test.txt（実際に npm test を実行した出力）と照らしてください。' : '')

type Row = { task: string; arm: string; rep: number; artifacts: string | null }
const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
  .filter(r => r.arm === args.arm && r.artifacts)
const done = new Set(
  (await readFile(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => {
    const r = JSON.parse(l) as Row
    return `${r.task}/${r.rep}`
  }),
)
const todo = rows.filter(r => !done.has(`${r.task}/${r.rep}`))
console.log(`${todo.length} runs to review (${rows.length} of arm ${args.arm}) -> ${out}`)

const reviewRun = async (row: Row) => {
  const scenario = row.task.split('/')[0]!
  if (!SCENARIOS.some(s => s.id === scenario)) throw new Error(`unknown scenario ${scenario}`)
  const src = join(dirname(file), row.artifacts!, 'final')
  const artifacts = `${stamp}-review.artifacts/${row.task}/${arm}/${row.rep}`
  const dest = join(dirname(file), artifacts, 'final')
  const work = await mkdtemp(join(tmpdir(), 'review-docs-'))
  const home = await mkdtemp(join(tmpdir(), 'review-docs-home-'))
  try {
    await cp(src, work, { recursive: true })
    await cp(join(scenarioDir(scenario), 'materials'), join(work, 'docs', '資料'), { recursive: true })
    const reviews = []
    for (const type of docTypes) {
      const path = DOCS.find(d => d.rubric === type)?.paths[0]
      if (!path || !(await exists(join(work, path)))) {
        reviews.push({ doc: type, missing: true })
        continue
      }
      if (args['dry-run']) {
        reviews.push({ doc: type, dryRun: true })
        continue
      }
      const target = resolve(work, path)
      const before = await readFile(target, 'utf8')
      let result: Record<string, unknown> | undefined
      for await (const m of query({
        prompt: promptFor(type, path),
        options: {
          model: args.model,
          systemPrompt: SYSTEM,
          tools: ['Read', 'Glob', 'Grep', 'Edit'],
          allowedTools: ['Read', 'Glob', 'Grep'],
          settingSources: [],
          settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
          persistSession: false,
          cwd: work,
          env: await runEnv(home),
          // Only the document under review may change.
          canUseTool: async (tool, input) =>
            tool === 'Edit' && resolve(work, String(input.file_path ?? '')) === target
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: `${path} 以外は変更できません` },
        },
      })) {
        if (m.type === 'result') {
          if (m.subtype !== 'success') throw new Error(`review failed: ${m.subtype} ${m.errors.join('; ')}`)
          result = {
            costUsd: m.total_cost_usd, durationApiMs: m.duration_api_ms, numTurns: m.num_turns,
            modelUsage: m.modelUsage, summary: m.result, denials: m.permission_denials,
          }
        }
      }
      const after = await readFile(target, 'utf8')
      reviews.push({ doc: type, changed: after !== before, chars: [before.length, after.length], ...result })
      console.log(`${row.task}/${row.rep} ${type}: ${after !== before ? 'edited' : 'unchanged'} $${Number(result?.costUsd ?? 0).toFixed(3)}`)
    }
    if (args['dry-run']) return console.log(`${row.task}/${row.rep}: ${JSON.stringify(reviews)}`)
    await rm(join(work, 'docs', '資料'), { recursive: true, force: true })
    await mkdir(dirname(dest), { recursive: true })
    await cp(work, dest, { recursive: true })
    const line = JSON.stringify({ task: row.task, arm, rep: row.rep, source: relative(dirname(file), src), artifacts, model: args.model, reviews })
    assertNoSecret(line)
    await appendFile(out, line + '\n')
  } finally {
    await rm(work, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}

checkHostEnv({ needToken: !args['dry-run'] })
// One run at a time: each run's reviews are sequential anyway (a later
// document may build on an earlier corrected one).
for (const row of todo) await reviewRun(row)
