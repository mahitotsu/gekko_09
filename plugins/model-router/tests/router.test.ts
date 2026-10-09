import type { EngineInterface, On, TurnStepInput } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { applySticky, classifyHeuristic, costUsd, parseOverride } from '../hooks/policy'

// The engine's bottom for the events the router touches: every request
// "answers" with fixed usage, and records which model and effort it was sent with.
const bottom = (on: On, seen: TurnStepInput[], promptTokens = 1000) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.step', async function* (_$, e) {
    seen.push(e)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: e.model,
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: promptTokens - 10,
        cache_creation_input_tokens: 0,
      },
    }
  })
}

const runTurn = async ($: EngineInterface | any, turnId: string, text: string) => {
  await $.turn.start({ text, turnId })
  const s = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok' })
}

describe('policy', () => {
  test('heuristic tiers', () => {
    expect(classifyHeuristic('このディレクトリのファイル一覧を表示して').tier).toBe('haiku')
    expect(classifyHeuristic('認証モジュールを設計し直してリファクタして').tier).toBe('opus')
    expect(classifyHeuristic('ログイン画面にパスワード表示トグルを付けたい。既存のフォームに合わせて。').tier).toBe(
      'sonnet',
    )
  })

  test('override tag is stripped', () => {
    expect(parseOverride('[Opus] なおして')).toEqual({ tier: 'opus', text: 'なおして' })
    expect(parseOverride('なおして')).toEqual({ text: 'なおして' })
  })

  test('sticky holds a step down once the cache is large', () => {
    expect(applySticky('haiku', 'opus', 50_000, 40_000)).toEqual({ tier: 'opus', isHeld: true })
    expect(applySticky('haiku', 'opus', 5_000, 40_000)).toEqual({ tier: 'haiku', isHeld: false })
    expect(applySticky('opus', 'haiku', 90_000, 40_000)).toEqual({ tier: 'opus', isHeld: false })
  })

  test('cost uses per-tier prices', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(costUsd('opus', u)).toBe(4)
    expect(costUsd('haiku', u)).toBe(0.5) // > 100K prompt: long-context rate
  })
})

describe('main loop', () => {
  test('routes each turn by difficulty', { options: { classifier: 'heuristic' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', 'src のファイル一覧を表示して')
    await runTurn($, 't2', '決済処理の競合バグの原因をデバッグして直して')
    expect(seen.map(s => s.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
    expect(seen[0]!.effort).toBe('low')
  })

  test('[sonnet] forces a tier for one turn', { options: { classifier: 'heuristic' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent = await $.prompt.submit({ text: '[sonnet] 一覧を表示して', wait: false } as any)
    expect((sent as any).text).toBe('一覧を表示して')
    await runTurn($, 't1', '一覧を表示して')
    expect(seen[0]!.model).toBe('claude-sonnet-5-5')
  })

  test('does not step down once the prompt cache is big', { options: { classifier: 'heuristic' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen, 60_000)
    await runTurn($, 't1', '認証まわりを設計し直してリファクタして')
    await runTurn($, 't2', '一覧を表示して')
    expect(seen.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('hybrid asks Haiku when unsure', async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    const asked: string[] = []
    on('model.complete', (_$, e) => {
      asked.push(e.model)
      return {
        value: {
          isAnswered: true as const,
          text: 'opus',
          usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })
    await runTurn($, 't1', 'ログイン画面にパスワード表示トグルを付けたい。既存のフォームに合わせて。')
    expect(asked).toEqual(['claude-haiku-5-5'])
    expect(seen[0]!.model).toBe('claude-opus-5-5')
  })

  test('fixed leaves the main loop alone', { options: { mainRouting: 'fixed' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', '一覧を表示して')
    expect(seen[0]!.model).toBe('claude-opus-5-5')
  })
})

describe('subagents', () => {
  const spawn = (subagentType: string, model?: string) => ({
    tool_use_id: 'tu1',
    prompt: 'find where auth tokens are parsed',
    description: 'find token parsing',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    model,
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  test('maps built-in types and respects an explicit model', async ($, on) => {
    on('agent.spawn', (_$, e) => ({ model: e.model ?? e.parentModel, agentId: 'a1' }))
    expect((await $.agent.spawn(spawn('Explore') as any)).model).toBe('claude-haiku-5-5')
    expect((await $.agent.spawn(spawn('general-purpose') as any)).model).toBe('claude-sonnet-5-5')
    expect((await $.agent.spawn(spawn('Plan') as any)).model).toBe('claude-opus-5-5')
    expect((await $.agent.spawn(spawn('Explore', 'opus') as any)).model).toBe('opus')
    expect((await $.agent.spawn(spawn('my-sdk-agent') as any)).model).toBe('claude-opus-5-5')
  })
})
