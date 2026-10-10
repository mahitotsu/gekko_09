import type { TurnStepInput } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

describe('eval-probe', () => {
  test('logs the language setting once, at the first turn', async ($, on) => {
    const logged: string[] = []
    on('ui.log', (_$, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    on('settings.read', () => ({ value: { language: 'japanese' } }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    await $.turn.start({ text: 'a', turnId: 't1' } as any)
    await $.turn.start({ text: 'b', turnId: 't2' } as any)
    expect(logged).toEqual(['eval-probe-settings {"language":"japanese"}'])
  })

  test('logs what each request was sent with and what it used, and changes nothing', async ($, on) => {
    const logged: string[] = []
    const seen: TurnStepInput[] = []
    let now = 1000
    on('clock.now', () => ({ value: (now += 250) }))
    on('ui.log', (_$, e) => {
      logged.push(e.text)
      return { value: undefined }
    })
    on('turn.step', async function* (_$, e) {
      seen.push(e)
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'ok',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: {
          model: 'claude-haiku-5-5',
          input_tokens: 7,
          output_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
        },
      }
    })
    const step = { turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium' as const, messageCount: 3 }
    const s = $.turn.step(step)
    for await (const _ of s) void _
    expect(seen[0]).toEqual(step)
    expect(seen[0]!.model).toBe('claude-sonnet-5-5')
    expect(logged).toHaveLength(1)
    const rec = JSON.parse(logged[0]!.replace(/^eval-probe /, ''))
    expect(rec).toMatchObject({
      turn: 't1',
      index: 0,
      agent: null,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      messages: 3,
      answered: 'claude-haiku-5-5',
      in: 7,
      cacheRead: 900,
      cacheWrite: 100,
      out: 20,
      stop: 'end_turn',
      ms: 250,
    })
  })
})
