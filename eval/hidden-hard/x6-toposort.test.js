import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as mod from '../src/toposort.js'

const { toposort, CycleError } = mod

test('orders dependencies first, smallest ready node first', () => {
  assert.deepEqual(toposort({ b: ['a'], c: ['a'], a: [] }), ['a', 'b', 'c'])
  assert.deepEqual(toposort({ c: ['a'], b: ['a'] }), ['a', 'b', 'c'])
  assert.deepEqual(toposort({ a: ['d'], b: [], c: [], d: [] }), ['b', 'c', 'd', 'a'])
  assert.deepEqual(toposort({ x: ['y'] }), ['y', 'x'])
  assert.deepEqual(toposort({ app: ['lib', 'util'], lib: ['util'], test: ['app'], docs: [] }), [
    'docs',
    'util',
    'lib',
    'app',
    'test',
  ])
})

const cycleOf = deps => {
  try {
    toposort(deps)
  } catch (err) {
    return err
  }
  assert.fail('expected a CycleError')
}

test('reports a cycle from its smallest node', () => {
  const err = cycleOf({ a: ['b'], b: ['c'], c: ['a'] })
  assert.equal(typeof CycleError, 'function')
  assert.ok(err instanceof CycleError)
  assert.equal(err.name, 'CycleError')
  assert.deepEqual(err.cycle, ['a', 'b', 'c', 'a'])
  assert.equal(err.message, 'cycle: a -> b -> c -> a')

  assert.deepEqual(cycleOf({ c: ['b'], b: ['d'], d: ['c'], a: [] }).cycle, ['b', 'd', 'c', 'b'])
  assert.deepEqual(cycleOf({ a: ['a'] }).cycle, ['a', 'a'])
  assert.deepEqual(cycleOf({ z: ['y'], y: ['z'], a: ['z'] }).cycle, ['y', 'z', 'y'])
})

test('with several cycles, reports a real one', () => {
  const deps = { a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c', 'e'], e: [] }
  const { cycle } = cycleOf(deps)
  assert.equal(cycle[0], cycle.at(-1))
  assert.equal(cycle[0], [...cycle].sort()[0])
  for (let i = 0; i + 1 < cycle.length; i++) assert.ok(deps[cycle[i]].includes(cycle[i + 1]), `${cycle[i]} -> ${cycle[i + 1]}`)
})
