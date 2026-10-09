import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AutoSaver } from '../src/autosave.js'

const setup = t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const saved = []
  return { saved, saver: new AutoSaver(c => saved.push(c), 1000) }
}

test('saves once, with the last edit, after typing stops', t => {
  const { saved, saver } = setup(t)
  saver.edit('a')
  t.mock.timers.tick(500)
  saver.edit('ab')
  t.mock.timers.tick(500)
  saver.edit('abc')
  t.mock.timers.tick(999)
  assert.deepEqual(saved, [])
  t.mock.timers.tick(1)
  assert.deepEqual(saved, ['abc'])
  t.mock.timers.tick(5000)
  assert.deepEqual(saved, ['abc'])
})

test('close saves the pending edit once', t => {
  const { saved, saver } = setup(t)
  saver.edit('x')
  saver.close()
  assert.deepEqual(saved, ['x'])
  t.mock.timers.tick(2000)
  saver.close()
  assert.deepEqual(saved, ['x'])
})

test('close after the save already ran does not save again', t => {
  const { saved, saver } = setup(t)
  saver.edit('a')
  t.mock.timers.tick(1000)
  saver.close()
  assert.deepEqual(saved, ['a'])
})

test('close with nothing pending saves nothing', t => {
  const { saved, saver } = setup(t)
  saver.close()
  assert.deepEqual(saved, [])
})

test('discard drops the pending edit', t => {
  const { saved, saver } = setup(t)
  saver.edit('a')
  saver.discard()
  saver.close()
  t.mock.timers.tick(2000)
  assert.deepEqual(saved, [])
})

test('edits after close are saved later', t => {
  const { saved, saver } = setup(t)
  saver.edit('a')
  saver.close()
  saver.edit('b')
  t.mock.timers.tick(1000)
  assert.deepEqual(saved, ['a', 'b'])
})
