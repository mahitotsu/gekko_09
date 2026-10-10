import type { TurnStepInput } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

const schedule = JSON.stringify([
  { turn: 1, model: 'claude-haiku-5-5', effort: 'medium' },
  { turn: 1, step: 1, effort: 'low' },
  { turn: 3, model: 'claude-sonnet-5-5' },
])

describe('eval-schedule', () => {
  test('switches model and effort at the scheduled turn and step, and leaves subagents alone', { options: { schedule } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    on('turn.step', async function* (_$, e) {
      seen.push(e)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
    const step = async (turnId: string, index: number, agentId?: string) => {
      const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, ...(agentId && { agentId }) })
      for await (const _ of s) void _
    }
    await step('a', 0)
    await step('a', 1)
    await step('sub', 0, 'agent-1')
    await step('b', 0)
    await step('c', 0)
    expect(seen.map(s => `${s.model}/${s.effort}`)).toEqual([
      'claude-haiku-5-5/medium',
      'claude-haiku-5-5/low',
      'claude-opus-5-5/high',
      'claude-haiku-5-5/low',
      'claude-sonnet-5-5/low',
    ])
  })
})
