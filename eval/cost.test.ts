// npx tsx --test eval/cost.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRequests, requestUsd, runCost, sharedPrefix, type RequestUsage } from './cost'

const req = (over: Partial<RequestUsage>): RequestUsage => ({
  model: 'claude-opus-5-5',
  agent: null,
  in: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  out: 0,
  ...over,
})

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`)

test('list prices and cache multipliers', () => {
  close(requestUsd(req({ in: 1e6 })), 4)
  close(requestUsd(req({ out: 1e6 })), 20)
  close(requestUsd(req({ cacheRead: 1e6 })), 0.2)
  close(requestUsd(req({ cacheWrite5m: 1e6 })), 5)
  close(requestUsd(req({ cacheWrite1h: 1e6 })), 8)
  close(requestUsd(req({ model: 'claude-sonnet-5-5', in: 1e6, out: 1e6 })), 12)
  close(requestUsd(req({ model: 'claude-sonnet-5-5', cacheRead: 1e6 })), 0.1)
  close(requestUsd(req({ model: 'claude-haiku-5-5', cacheRead: 100_000 })), 0.001)
})

test('Haiku over 100K prompt tokens bills at the long-prompt rate', () => {
  close(requestUsd(req({ model: 'claude-haiku-5-5', in: 100_000, out: 1e6 })), 0.01 + 0.5)
  close(requestUsd(req({ model: 'claude-haiku-5-5', in: 100_001, out: 1e6 })), (100_001 * 0.5) / 1e6 + 2.5)
})

test('unknown models are an error, not free', () => {
  assert.throws(() => requestUsd(req({ model: 'claude-other' })))
})

test('cold moves the first request reads to writes; warm moves writes up to the shared prefix to reads', () => {
  // Run A started cold: it wrote the 10K prefix. Run B found 8K of it cached.
  const a = [req({ cacheWrite5m: 10_000, out: 100 }), req({ cacheRead: 10_000, cacheWrite5m: 500, out: 100 })]
  const b = [req({ cacheRead: 8_000, cacheWrite5m: 2_000, out: 100 })]
  const prefix = sharedPrefix([a, b])
  assert.deepEqual(prefix, { 'claude-opus-5-5/main': 8_000 })

  const ca = runCost(a, prefix)
  close(ca.cold, ca.measured) // nothing read from outside
  close(ca.warm, ca.measured - requestUsd(req({ cacheWrite5m: 8_000 })) + requestUsd(req({ cacheRead: 8_000 })))

  const cb = runCost(b, prefix)
  assert.equal(cb.cacheReadFromOutside, 8_000)
  close(cb.cold, requestUsd(req({ cacheWrite5m: 10_000, out: 100 })))
  close(cb.warm, cb.measured)
})

test('each subagent thread has its own first request', () => {
  const reqs = [
    req({ cacheRead: 5_000 }),
    req({ agent: 'tu1', model: 'claude-haiku-5-5', cacheRead: 3_000 }),
    req({ agent: 'tu1', model: 'claude-haiku-5-5', cacheRead: 4_000 }),
  ]
  assert.equal(runCost(reqs, {}).cacheReadFromOutside, 8_000)
})

test('requests take tokens from the probe, the TTL split from the SDK, and the rest of the totals as aux', () => {
  // e1-timeout on Haiku, from the first smoke run (2026-10-10).
  const step = (cacheRead: number, cacheWrite: number, out: number) => ({
    agent: null, model: 'claude-haiku-5-5', answered: 'claude-haiku-5-5', in: 2, cacheRead, cacheWrite, out,
  })
  const { requests, unmatched } = buildRequests(
    [step(0, 15841, 245), step(15841, 305, 4)],
    [
      { in: 2, cacheRead: 15841, cacheWrite5m: 0, cacheWrite1h: 305 },
      { in: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 15841 },
    ],
    { 'claude-haiku-5-5': { inputTokens: 1186, outputTokens: 277, cacheReadInputTokens: 15841, cacheCreationInputTokens: 16146 } },
  )
  assert.equal(unmatched, 0)
  assert.deepEqual(requests, [
    { model: 'claude-haiku-5-5', agent: null, in: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 15841, out: 245 },
    { model: 'claude-haiku-5-5', agent: null, in: 2, cacheRead: 15841, cacheWrite5m: 0, cacheWrite1h: 305, out: 4 },
    { model: 'claude-haiku-5-5', agent: 'aux', in: 1182, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, out: 28 },
  ])
})

test('a write with no SDK split takes the TTL of its kind of request: 1 hour on main, 5 minutes in a subagent', () => {
  const step = (agent: string | null) => ({ agent, model: 'claude-opus-5-5', answered: null, in: 1, cacheRead: 0, cacheWrite: 100, out: 1 })
  const { requests, unmatched } = buildRequests([step(null), step('a1')], [], {})
  assert.equal(unmatched, 2)
  assert.deepEqual(requests.map(r => [r.cacheWrite5m, r.cacheWrite1h]), [[0, 100], [100, 0]])
})
