import assert from 'node:assert/strict'
import { test } from 'node:test'

import { evaluate } from '../src/expr.js'

test('precedence and associativity', () => {
  const cases = [
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 4 - 3', 3],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['(-2)^2', 4],
    ['2^-1', 0.5],
    ['2^-2^2', 0.0625],
    ['2*-3', -6],
    ['1--1', 2],
    ['--3', 3],
    ['10 % 4 * 3', 6],
    ['2 ^ 3 * 2', 16],
    ['.5 + 1.25', 1.75],
    ['-abs(-2)^2', -4],
  ]
  for (const [src, want] of cases) assert.equal(evaluate(src), want, src)
})

test('variables and functions', () => {
  assert.equal(evaluate('x * y + 1', { x: 2, y: 5 }), 11)
  assert.equal(evaluate('max(1, abs(-7), min(3, 4))'), 7)
  assert.equal(evaluate('max (2, 3)'), 3)
  assert.equal(evaluate('\tmin(4,\n2)\n'), 2)
})

test('name errors', () => {
  assert.throws(() => evaluate('y + 1'), { name: 'ReferenceError', message: /unknown variable: y/ })
  assert.throws(() => evaluate('foo(1)'), { name: 'ReferenceError', message: /unknown function: foo/ })
})

test('arity errors', () => {
  assert.throws(() => evaluate('max()'), TypeError)
  assert.throws(() => evaluate('abs(1, 2)'), TypeError)
})

test('division by zero', () => {
  assert.throws(() => evaluate('1 / 0'), { name: 'RangeError', message: /division by zero/ })
  assert.throws(() => evaluate('5 % (2-2)'), { name: 'RangeError', message: /division by zero/ })
})

test('syntax errors report the position', () => {
  const cases = [
    ['1 +', 3],
    ['2 * (3', 6],
    ['1 $ 2', 2],
    ['1 2', 2],
    ['()', 1],
    ['max(1,)', 6],
  ]
  for (const [src, at] of cases)
    assert.throws(() => evaluate(src), { name: 'SyntaxError', message: new RegExp(`at ${at}\\b`) }, src)
})
