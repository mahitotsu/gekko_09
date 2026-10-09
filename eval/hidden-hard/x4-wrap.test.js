import assert from 'node:assert/strict'
import { test } from 'node:test'

import { stringWidth } from '../src/width.js'
import { wrapText } from '../src/wrap.js'

test('examples from the spec', () => {
  assert.deepEqual(wrapText('あいうえおかきくけこ', 6), ['あいう', 'えおか', 'きくけ', 'こ'])
  assert.deepEqual(wrapText('あいう。えお', 6), ['あい', 'う。え', 'お'])
  assert.deepEqual(wrapText('あい「うえ」お', 6), ['あい', '「う', 'え」お'])
  assert.deepEqual(wrapText('ab\n\ncd', 5), ['ab', '', 'cd'])
})

test('latin words', () => {
  assert.deepEqual(wrapText('hello world foo', 11), ['hello world', 'foo'])
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('  lead  trail  ', 20), ['lead  trail'])
})

test('mixed latin and wide text', () => {
  assert.deepEqual(wrapText('Claude Codeで日本語を書く', 10), ['Claude', 'Codeで日本', '語を書く'])
})

test('push-out repeats over several prohibited characters', () => {
  assert.deepEqual(wrapText('あいうえ」」お', 8), ['あいう', 'え」」お'])
})

const TEXT =
  '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。「吾輩」はここで始めて人間というものを見た。（しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。）'
const START = new Set('、。，．・：；？！ー」』）】〉》ぁぃぅぇぉっゃゅょァィゥェォッャュョ')
const END = new Set('「『（【〈《')

for (const width of [10, 12, 14, 20, 31]) {
  test(`long text at width ${width} keeps every rule`, () => {
    const lines = wrapText(TEXT, width)
    assert.equal(lines.join(''), TEXT)
    for (const line of lines) {
      assert.ok(stringWidth(line) <= width, `too wide: ${line}`)
      assert.ok(!START.has(line[0]), `starts with a prohibited char: ${line}`)
      assert.ok(!END.has(line.at(-1)), `ends with an opening bracket: ${line}`)
    }
  })
}
