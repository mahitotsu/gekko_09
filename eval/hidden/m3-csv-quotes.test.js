import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCsv } from '../src/csv.js'

test('quoted fields may hold commas', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']])
})

test('doubled quotes inside a quoted field are one quote', () => {
  assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', 'x']])
})

test('plain rows still work', () => {
  assert.deepEqual(parseCsv('a,b\nc,d\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
})
