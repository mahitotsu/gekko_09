import type { EngineInterface, On, TurnStepInput } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

// The engine's bottom for the events the router touches: every request
// "answers" with fixed usage, and records which model and effort it was sent with.
const bottom = (on: On, seen: TurnStepInput[], promptTokens = 1000, logs: string[] = []) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.log', (_$, e) => {
    logs.push(e.text)
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
        model: e.model,
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: promptTokens - 10,
        cache_creation_input_tokens: 0,
      },
    }
  })
}

const step = async ($: EngineInterface | any, turnId: string, index: number) => {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of s) void _
  await s.result
}

// One turn: the steps, with `between(i)` run after step i (tool calls).
const runTurn = async (
  $: EngineInterface | any,
  turnId: string,
  text: string,
  steps = 1,
  between?: (i: number) => Promise<unknown>,
) => {
  await $.turn.start({ text, turnId })
  for (let i = 0; i < steps; i++) {
    await step($, turnId, i)
    if (between) await between(i)
  }
  await $.turn.complete({ turnId, reason: 'answer', answer: 'ok' })
}

// The engine's bottom for tool calls: Bash answers with the given output.
const tools = (on: On, out: { text: string; isError?: boolean }) =>
  on('tool.call', () => ({ result: { stdout: out.text, stderr: '' }, text: out.text, isError: out.isError }) as any)

const bash = ($: EngineInterface | any) => $.tool.call({ tool: 'Bash', command: 'npm test' })


describe('main loop', () => {
  const H = { options: { classifier: 'heuristic' } }

  test('routes each turn by its kind', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', 'src のファイル一覧を表示して')
    await runTurn($, 't2', '決済処理の競合の原因が分からないので調べて')
    await runTurn($, 't3', 'CSV の出力に合計の列を追加して')
    expect(seen.map(s => [s.model, s.effort])).toEqual([
      ['claude-haiku-5-5', 'low'],
      ['claude-opus-5-5', 'high'],
      ['claude-sonnet-5-5', 'medium'],
    ])
  })

  test('a document turn stays on Sonnet when delegating', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', '報告書を docs/report.md にまとめてください。')
    expect(seen[0]!.model).toBe('claude-sonnet-5-5')
  })

  test('a document turn moves to Opus with docs: switch', { options: { classifier: 'heuristic', docs: 'switch' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', '報告書を docs/report.md にまとめてください。')
    expect([seen[0]!.model, seen[0]!.effort]).toEqual(['claude-opus-5-5', 'medium'])
  })

  test('haiku base does the work on Haiku', { options: { classifier: 'heuristic', base: 'haiku' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して')
    expect([seen[0]!.model, seen[0]!.effort]).toEqual(['claude-haiku-5-5', 'medium'])
  })

  test('[sonnet] forces a tier for one turn', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const sent = await $.prompt.submit({ text: '[sonnet] 一覧を表示して', wait: false } as any)
    expect((sent as any).text).toBe('一覧を表示して')
    await runTurn($, 't1', '一覧を表示して')
    expect(seen[0]!.model).toBe('claude-sonnet-5-5')
  })

  const E = { options: { classifier: 'heuristic', escalation: 'on' } }

  test('three failing test runs in a row escalate the rest of the turn', E, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    tools(on, { text: 'ℹ tests 10\nℹ pass 8\nℹ fail 2' })
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して', 5, () => bash($))
    expect(seen.map(s => [s.model, s.effort])).toEqual([
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'medium'],
      ['claude-opus-5-5', 'high'],
      ['claude-opus-5-5', 'high'],
    ])
    // The next turn starts over from its own kind.
    await runTurn($, 't2', 'CSV の出力に合計の列を追加して')
    expect(seen[5]!.model).toBe('claude-sonnet-5-5')
  })

  test('errors that are not failing tests do not count', E, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    tools(on, { text: 'exit=2\n入力データの不整合', isError: true })
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して', 5, () => bash($))
    expect(seen.every(s => s.model === 'claude-sonnet-5-5')).toBe(true)
  })

  test('a passing run resets the streak', E, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    const outputs = ['ℹ fail 1', 'ℹ fail 1', 'ℹ fail 0', 'ℹ fail 1', 'ℹ fail 1']
    let i = 0
    on('tool.call', () => ({ result: {}, text: outputs[i++] }) as any)
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して', 6, () => bash($))
    expect(seen.every(s => s.model === 'claude-sonnet-5-5')).toBe(true)
  })

  test('by default escalation is only logged', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    const logs: string[] = []
    bottom(on, seen, 1000, logs)
    tools(on, { text: 'ℹ fail 2' })
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して', 5, () => bash($))
    expect(seen.every(s => s.model === 'claude-sonnet-5-5')).toBe(true)
    expect(logs.join('\n')).toContain('would escalate to opus/high')
  })

  test('the main loop may not write documents itself', H, async ($, on) => {
    const written: string[] = []
    on('tool.call', (_$, e: any) => {
      written.push(e.file_path)
      return { result: {} } as any
    })
    const r = await $.tool.call({ tool: 'Write', file_path: 'docs/report.md', content: 'x' } as any)
    expect((r as any).deny).toContain('model-router:doc-writer')
    await $.tool.call({ tool: 'Write', file_path: 'src/cli.js', content: 'x' } as any)
    expect(written).toEqual(['src/cli.js'])
  })

  test('a lookup late in a long conversation stays on the cached tier', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen, 150_000)
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して')
    await runTurn($, 't2', 'src のファイル一覧を表示して')
    expect(seen.map(s => [s.model, s.effort])).toEqual([
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'low'],
    ])
  })

  test('planning mode is Opus until ExitPlanMode', H, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    on('tool.call', () => ({ result: {} }) as any)
    await runTurn($, 't1', 'CSV の出力に合計の列を追加して', 2, i => (i === 0 ? $.tool.call({ tool: 'EnterPlanMode' } as any) : Promise.resolve()))
    await runTurn($, 't2', 'CSV の出力に合計の列を追加して', 2, i => (i === 0 ? $.tool.call({ tool: 'ExitPlanMode', plan: 'x' } as any) : Promise.resolve()))
    expect(seen.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('hybrid asks Haiku when unsure', { options: { docs: 'switch' } }, async ($, on) => {
    const seen: TurnStepInput[] = []
    bottom(on, seen)
    const asked: string[] = []
    on('model.complete', (_$, e) => {
      asked.push(e.model)
      return {
        value: {
          isAnswered: true as const,
          text: 'docs',
          usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }
    })
    await runTurn($, 't1', 'いい感じにしておいて')
    expect(asked).toEqual(['claude-haiku-5-5'])
    expect(seen[0]!.model).toBe('claude-opus-5-5')
  })

  test('the system prompt asks to delegate', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' as const }] }))
    const r = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
    expect(r.sections.map((s: any) => s.id)).toEqual(['intro', 'model-router:delegation'])
    expect(r.sections[1]!.text).toContain('model-router:doc-writer')
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

  test('maps types and respects an explicit model', async ($, on) => {
    on('agent.spawn', (_$, e) => ({ model: e.model ?? e.parentModel, agentId: 'a1' }))
    expect((await $.agent.spawn(spawn('Explore') as any)).model).toBe('claude-haiku-5-5')
    expect((await $.agent.spawn(spawn('general-purpose') as any)).model).toBe('claude-sonnet-5-5')
    expect((await $.agent.spawn(spawn('model-router:doc-writer') as any)).model).toBe('claude-opus-5-5')
    expect((await $.agent.spawn(spawn('Explore', 'opus') as any)).model).toBe('opus')
    expect((await $.agent.spawn(spawn('my-sdk-agent') as any)).model).toBe('claude-opus-5-5')
  })

  test('the doc-writer runs in the foreground', async ($, on) => {
    const seen: boolean[] = []
    on('agent.spawn', (_$, e) => {
      seen.push(e.background)
      return { model: e.model ?? e.parentModel, agentId: 'a1' }
    })
    await $.agent.spawn({ ...spawn('model-router:doc-writer'), background: true } as any)
    await $.agent.spawn({ ...spawn('Explore'), background: true } as any)
    expect(seen).toEqual([false, true])
  })
})
