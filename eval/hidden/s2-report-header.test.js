import assert from 'node:assert/strict'
import { test } from 'node:test'

import { salesReport } from '../src/report.js'

test('the report starts with a heading line and is otherwise unchanged', () => {
  assert.equal(
    salesReport([{ name: 'ペン', amount: 1200 }, { name: 'ノート', amount: 300 }]),
    ['売上レポート', 'ペン: ¥1,200', 'ノート: ¥300', 'TOTAL: ¥1,500'].join('\n'),
  )
  assert.equal(salesReport([]), ['売上レポート', 'TOTAL: ¥0'].join('\n'))
})
