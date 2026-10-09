import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parse } from '../src/semver.js'
import { charWidth, stringWidth } from '../src/width.js'

test('semver parse', () => {
  assert.deepEqual(parse('1.2.3-beta.1'), { major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'] })
  assert.equal(parse('1.2'), null)
})

test('display width', () => {
  assert.equal(charWidth('a'), 1)
  assert.equal(charWidth('あ'), 2)
  assert.equal(stringWidth('Claude日本'), 10)
})
