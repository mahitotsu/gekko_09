// P1: what a model or effort switch did to the prompt cache, request by request.
//   npx tsx eval/p1-cache.ts eval/results/<stamp>.jsonl
// For each main-loop request: its model and effort as sent, and how much of
// the previous request on the same model it read from the cache. A request
// extends the one before it, so with the cache intact it reads about all of
// that prompt; when the cache was lost it reads only what is shared beyond
// the conversation (system prompt and tools) and writes the rest again.
import { readFile } from 'node:fs/promises'

type Step = {
  turn: string
  index: number
  agent: string | null
  model: string
  effort: string | number | null
  in: number
  cacheRead: number
  cacheWrite: number
  out: number
}
type Row = { task: string; arm: string; rep: number; steps: Step[] }

const rows: Row[] = (await Promise.all(process.argv.slice(2).map(f => readFile(f, 'utf8'))))
  .flatMap(t => t.split('\n').filter(Boolean))
  .map(l => JSON.parse(l))
  .filter((r: Row) => r.steps?.length)

const prompt = (s: Step) => s.in + s.cacheRead + s.cacheWrite

for (const r of rows) {
  console.log(`\n## ${r.task} · ${r.arm} · rep ${r.rep}\n`)
  console.log('| turn | step | model | effort | prompt | cache read | cache write | read / previous prompt on this model |')
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  const turnNo = new Map<string, number>()
  const lastOn = new Map<string, Step>()
  let prev: Step | undefined
  for (const s of r.steps.filter(s => s.agent === null)) {
    if (!turnNo.has(s.turn)) turnNo.set(s.turn, turnNo.size + 1)
    const before = lastOn.get(s.model)
    const switched = prev && (prev.model !== s.model || prev.effort !== s.effort) ? ' ←' : ''
    const reuse = before ? `${Math.round((s.cacheRead / prompt(before)) * 100)}%` : '-'
    console.log(
      `| ${turnNo.get(s.turn)} | ${s.index} | ${s.model.replace('claude-', '')} | ${s.effort ?? '-'}${switched} | ${prompt(s)} | ${s.cacheRead} | ${s.cacheWrite} | ${reuse} |`,
    )
    lastOn.set(s.model, s)
    prev = s
  }
}
