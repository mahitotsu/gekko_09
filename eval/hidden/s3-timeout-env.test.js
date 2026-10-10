import assert from 'node:assert/strict'
import { test } from 'node:test'

// config.js reads the environment when it loads: import a fresh copy each time.
let n = 0
const load = async value => {
  if (value === undefined) delete process.env.SHOP_TIMEOUT_MS
  else process.env.SHOP_TIMEOUT_MS = value
  return (await import(`../src/config.js?fresh=${n++}`)).DEFAULT_TIMEOUT_MS
}

test('SHOP_TIMEOUT_MS overrides the default timeout', async () => {
  assert.equal(await load('8000'), 8000)
})

test('an unset or non-numeric SHOP_TIMEOUT_MS keeps 3500', async () => {
  assert.equal(await load(undefined), 3500)
  assert.equal(await load(''), 3500)
  assert.equal(await load('abc'), 3500)
})
