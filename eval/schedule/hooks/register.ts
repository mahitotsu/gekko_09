import type { Register } from 'claude-code'

// A switch the schedule makes: from main-loop turn `turn` (1-based) and its
// step `step` (0-based, default 0) on, requests carry these. Later entries
// override earlier ones field by field, so a model set once stays set.
type Entry = { turn: number; step?: number; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }

export const register: Register = (on, options) => {
  const entries = (JSON.parse(String(options.schedule ?? '[]')) as Entry[]).sort(
    (a, b) => a.turn - b.turn || (a.step ?? 0) - (b.step ?? 0),
  )
  // Main-loop turns, numbered by their first request (turn.start does not
  // say whether a turn is a subagent's).
  const turnNo = new Map<string, number>()

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    if (!turnNo.has(e.turnId)) turnNo.set(e.turnId, turnNo.size + 1)
    const turn = turnNo.get(e.turnId)!
    let model: string | undefined
    let effort: Entry['effort']
    for (const x of entries) {
      if (x.turn > turn || (x.turn === turn && (x.step ?? 0) > e.index)) break
      model = x.model ?? model
      effort = x.effort ?? effort
    }
    return yield* next({ ...e, ...(model && { model }), ...(effort && { effort }) })
  })
}
