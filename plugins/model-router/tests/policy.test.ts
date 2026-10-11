import { describe, expect, test } from 'claude-code/testing'

import {
  classifyHeuristic,
  costUsd,
  delegationSection,
  escalate,
  isDocPath,
  keepCacheForLookup,
  parseKind,
  parseOverride,
  resolveTtls,
  routeFor,
  switchCostUsd,
  testOutcome,
  tierForSubagent,
} from '../hooks/policy'

describe('classifier', () => {
  const kind = (text: string) => classifyHeuristic(text).kind

  test('the invoice script prompts', () => {
    // The prompts of eval/scenarios/invoice (dev split), shortened.
    expect(kind('docs/資料 にある議事録・請求業務規程・連携仕様書を読んで、請求書発行システムの要件を docs/requirements.md にまとめてください。')).toBe('docs')
    expect(kind('docs/requirements.md をもとに、設計を docs/design.md に書いてください。まだ実装はしないでください。')).toBe('docs')
    expect(kind('docs/design.md に沿って実装してください。コマンドは連携仕様書のとおりにしてください。')).toBe('work')
    expect(kind('サンプルデータ（docs/資料/data）で 2026-09 分を実行して、連携仕様書の例と一致するか確かめてください。違っていたら直してください。')).toBe('fix')
    expect(kind('テストを test/ に書いて、npm test が通るようにしてください。請求期間の境界、返品、入力の不整合を含めてください。')).toBe('work')
    expect(kind('最終の仕様書を docs/spec.md に、作業の報告書を docs/report.md にまとめてください。')).toBe('docs')
    expect(kind('報告書の要点を3行で教えてください。')).toBe('lookup')
  })

  test('the other kinds', () => {
    expect(kind('src のファイル一覧を表示して')).toBe('lookup')
    expect(kind('締め日の計算はどこにありますか？')).toBe('lookup')
    expect(kind('決済処理の競合の原因が分からないので調べて')).toBe('hard')
    expect(kind('テストが落ちるので直して')).toBe('fix')
    expect(kind('キャッシュの持ち方を3案出して、トレードオフを比較検討して')).toBe('plan')
    expect(kind('CSV の出力に合計の列を追加して')).toBe('work')
  })

  test('unsure verdicts leave room for Haiku', () => {
    expect(classifyHeuristic('いい感じにしておいて').isSure).toBe(false)
    expect(classifyHeuristic('CSV の出力に合計の列を追加して').isSure).toBe(true)
  })

  test('Haiku answers are read by word', () => {
    expect(parseKind('docs')).toBe('docs')
    expect(parseKind('Kind: fix.')).toBe('fix')
    expect(parseKind('documentation')).toBeUndefined()
  })

  test('override tag is stripped', () => {
    expect(parseOverride('[Opus] なおして')).toEqual({ tier: 'opus', text: 'なおして' })
    expect(parseOverride('なおして')).toEqual({ text: 'なおして' })
  })
})

describe('routes', () => {
  test('sonnet base follows the tier table', () => {
    expect(routeFor('lookup', 'sonnet', 'switch')).toEqual({ tier: 'haiku', effort: 'low' })
    expect(routeFor('work', 'sonnet', 'switch')).toEqual({ tier: 'sonnet', effort: 'medium' })
    expect(routeFor('fix', 'sonnet', 'switch')).toEqual({ tier: 'sonnet', effort: 'high' })
    expect(routeFor('docs', 'sonnet', 'switch')).toEqual({ tier: 'opus', effort: 'medium' })
    expect(routeFor('hard', 'sonnet', 'switch')).toEqual({ tier: 'opus', effort: 'high' })
  })

  test('delegated docs stay on the work tier', () => {
    expect(routeFor('docs', 'sonnet', 'delegate')).toEqual({ tier: 'sonnet', effort: 'medium' })
    expect(routeFor('docs', 'haiku', 'delegate')).toEqual({ tier: 'haiku', effort: 'medium' })
  })

  test('haiku base does the work on Haiku', () => {
    expect(routeFor('work', 'haiku', 'switch')).toEqual({ tier: 'haiku', effort: 'medium' })
    expect(routeFor('plan', 'haiku', 'switch')).toEqual({ tier: 'opus', effort: 'medium' })
  })

  test('escalation goes one tier up at high effort', () => {
    expect(escalate({ tier: 'haiku', effort: 'medium' })).toEqual({ tier: 'sonnet', effort: 'high' })
    expect(escalate({ tier: 'sonnet', effort: 'medium' })).toEqual({ tier: 'opus', effort: 'high' })
    expect(escalate({ tier: 'opus', effort: 'medium' })).toEqual({ tier: 'opus', effort: 'high' })
  })
})

describe('failures', () => {
  test('test output, not exit codes', () => {
    expect(testOutcome('ℹ tests 35\nℹ pass 34\nℹ fail 1')).toBe('fail')
    expect(testOutcome('✖ nonLeapMar: invoices.csv (39.9ms)')).toBe('fail')
    expect(testOutcome('3 failing')).toBe('fail')
    expect(testOutcome('ℹ tests 35\nℹ pass 35\nℹ fail 0')).toBe('pass')
    expect(testOutcome('exit=2\n入力データの不整合: O9 の商品コード')).toBeUndefined()
    expect(testOutcome(undefined)).toBeUndefined()
  })
})

describe('cache', () => {
  test('a lookup goes to Haiku only while that is cheap', () => {
    const haiku = { tier: 'haiku' as const, effort: 'low' as const }
    expect(keepCacheForLookup(haiku, 'sonnet', 150_000)).toEqual({ tier: 'sonnet', effort: 'low' })
    expect(keepCacheForLookup(haiku, 'sonnet', 10_000)).toEqual(haiku)
    expect(keepCacheForLookup(haiku, 'haiku', 150_000)).toEqual(haiku)
    expect(keepCacheForLookup(haiku, undefined, 0)).toEqual(haiku)
  })

  test('documents are Markdown files', () => {
    expect(isDocPath('docs/report.md')).toBe(true)
    expect(isDocPath('/tmp/x/README.MD')).toBe(true)
    expect(isDocPath('src/cli.js')).toBe(false)
    expect(isDocPath('node_modules/a/README.md')).toBe(false)
    expect(isDocPath(undefined)).toBe(false)
  })
})

describe('subagents', () => {
  test('tiers by type', () => {
    expect(tierForSubagent('Explore', 'find', 'where is x')).toBe('haiku')
    expect(tierForSubagent('model-router:doc-writer', 'write', 'report')).toBe('opus')
    expect(tierForSubagent('model-router:test-runner', 'run', 'npm test')).toBe('haiku')
    expect(tierForSubagent('general-purpose', 'add a column', 'CSV に列を追加して')).toBe('sonnet')
    expect(tierForSubagent('general-purpose', 'write report', '報告書を docs/report.md にまとめて')).toBe('opus')
    expect(tierForSubagent('my-sdk-agent', 'x', 'y')).toBeUndefined()
  })

  test('the delegation section names doc-writer only when delegating', () => {
    expect(delegationSection('delegate')).toContain('model-router:doc-writer')
    expect(delegationSection('switch')).not.toContain('model-router:doc-writer')
    expect(delegationSection('switch')).toContain('model-router:test-runner')
  })
})

describe('pricing', () => {
  test('cost uses per-tier prices', () => {
    const u = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(costUsd('opus', u)).toBe(4)
    expect(costUsd('haiku', u)).toBe(0.5) // > 100K prompt: long-context rate
    const w = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }
    const round = (n: number) => Math.round(n * 1e6) / 1e6
    expect(round(costUsd('sonnet', w, '5m'))).toBe(2.6) // reads 0.05x ($0.10), 5-minute writes 1.25x ($2.50)
    expect(round(costUsd('sonnet', w, '1h'))).toBe(4.1) // 1-hour writes 2x ($4)
  })

  test('a switch costs the write of what the new tier has not cached', () => {
    const round = (n: number) => Math.round(n * 1e6) / 1e6
    expect(round(switchCostUsd('opus', 100_000, '1h'))).toBe(0.78) // 100K x ($8 - $0.20) / M
    expect(round(switchCostUsd('haiku', 100_000, '1h'))).toBe(0.019)
  })

  test('cache TTLs follow the documented precedence', () => {
    expect(resolveTtls({})).toEqual({ main: '1h', other: '5m' }) // subscription default
    expect(resolveTtls({ ANTHROPIC_API_KEY: 'x' })).toEqual({ main: '5m', other: '5m' })
    expect(resolveTtls({ ENABLE_PROMPT_CACHING_1H: '1', ANTHROPIC_API_KEY: 'x' })).toEqual({ main: '1h', other: '1h' })
    expect(resolveTtls({ ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' })).toEqual({ main: '1h', other: '5m' })
    expect(resolveTtls({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })).toEqual({ main: '5m', other: '5m' })
    expect(resolveTtls({ CLAUDE_CODE_PROMPT_CACHE_TTL: 'bogus' })).toEqual({ main: '1h', other: '5m' })
    expect(resolveTtls({ FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' })).toEqual({ main: '5m', other: '5m' })
  })
})
