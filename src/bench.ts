// A/B: the same tasks on Opus alone vs. routed by model-router.
// `npm run bench` — spends real API money; keep TASKS small.
// Cost and latency come from the SDK's own `result` (modelUsage, duration_ms);
// quality is yours to judge from the answers written to bench-out/.
import { mkdir, writeFile } from 'node:fs/promises'

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'

import { summarize, withRouter } from './router'

const TASKS = [
  'src ディレクトリのファイル一覧を表示して',
  'plugins/model-router/hooks/policy.ts の classifyHeuristic が誤判定しそうな入力例を3つ挙げて理由を説明して',
  'plugins/model-router の設計をレビューして、キャッシュとコストの観点で改善案を出して',
]

const base: Options = {
  model: 'claude-opus-5-5',
  cwd: process.cwd(),
  allowedTools: ['Read', 'Glob', 'Grep', 'Agent'],
  permissionMode: 'default',
}

const ARMS: Record<string, Options> = {
  'opus-only': base,
  routed: withRouter(base, { classifier: 'hybrid', report: 'off' }),
}

const run = async (prompt: string, options: Options) => {
  let answer = ''
  for await (const m of query({ prompt, options })) {
    if (m.type === 'assistant')
      for (const b of m.message.content) if (b.type === 'text') answer += b.text
    if (m.type === 'result') return { answer, ...(m.subtype === 'success' ? summarize(m) : { error: m.subtype }) }
  }
  throw new Error('no result')
}

await mkdir('bench-out', { recursive: true })
const rows: Record<string, unknown>[] = []
for (const [i, task] of TASKS.entries()) {
  for (const [arm, options] of Object.entries(ARMS)) {
    const r = await run(task, options)
    await writeFile(`bench-out/${i}-${arm}.md`, `# ${task}\n\n${r.answer}\n`)
    const models = 'perModel' in r ? r.perModel?.map(p => p.model).join(',') : ''
    rows.push({ task: i, arm, usd: 'costUsd' in r ? r.costUsd : NaN, ms: 'durationMs' in r ? r.durationMs : NaN, models })
  }
}
console.table(rows)
