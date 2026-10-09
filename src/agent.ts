// One routed run: `npm run agent -- "src のファイル一覧を表示して"`
import { query } from '@anthropic-ai/claude-agent-sdk'

import { routerLine, summarize, withRouter } from './router'

const prompt = process.argv.slice(2).join(' ') || 'このリポジトリの構成を説明して'

const options = withRouter(
  {
    model: 'claude-opus-5-5',
    cwd: process.cwd(),
    permissionMode: 'default',
    allowedTools: ['Read', 'Glob', 'Grep', 'Agent'],
  },
  { classifier: 'hybrid' },
)

for await (const m of query({ prompt, options })) {
  const line = routerLine(m)
  if (line) console.error(`[router] ${line}`)
  if (m.type === 'assistant') {
    for (const block of m.message.content) if (block.type === 'text') process.stdout.write(block.text)
  }
  if (m.type === 'result') {
    console.log('\n')
    console.table(m.subtype === 'success' ? summarize(m).perModel : [])
    console.log(m.subtype, `total $${m.total_cost_usd.toFixed(4)}`, `${m.duration_ms} ms`)
  }
}
