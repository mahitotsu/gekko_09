// 受注・請求シナリオの受け入れテスト（隠し）。作業ディレクトリの test-hidden/ に
// datasets/ と一緒に置かれ、作業ディレクトリをカレントにして実行される。
// 連携仕様書どおりの CLI を、資料にないデータで実行し、出力を期待値と比べる。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const datasets = join(dirname(fileURLToPath(import.meta.url)), 'datasets')

const run = (...args) => spawnSync('node', ['src/cli.js', ...args], { encoding: 'utf8', timeout: 30_000 })

// 改行コードと末尾の空行だけは揃えて比べる
const lines = path => readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')

for (const name of readdirSync(datasets).filter(n => existsSync(join(datasets, n, 'expected'))).sort()) {
  const dir = join(datasets, name)
  const month = readFileSync(join(dir, 'month'), 'utf8').trim()
  const out = mkdtempSync(join(tmpdir(), `invoice-${name}-`))
  let result
  const runOnce = () => (result ??= run('--month', month, '--data', join(dir, 'input'), '--out', out))
  for (const file of ['invoices.csv', 'invoice_lines.csv']) {
    test(`${name}: ${file}`, () => {
      const r = runOnce()
      assert.equal(r.status, 0, `終了コード ${r.status}: ${r.stderr}`)
      assert.deepEqual(lines(join(out, file)), lines(join(dir, 'expected', file)))
    })
  }
}

// 入力の不整合: 終了コード 2、問題の行の番号（注文・返品・入金の番号、または顧客コード）を示し、何も出力しない
for (const name of readdirSync(datasets).filter(n => existsSync(join(datasets, n, 'error-id'))).sort()) {
  test(`${name}: 入力の不整合は終了コード 2、問題の行を示し、何も出力しない`, () => {
    const id = readFileSync(join(datasets, name, 'error-id'), 'utf8').trim()
    const out = join(mkdtempSync(join(tmpdir(), `invoice-${name}-`)), 'out')
    const r = run('--month', '2026-09', '--data', join(datasets, name, 'input'), '--out', out)
    assert.equal(r.status, 2, `終了コード ${r.status}: ${r.stderr}`)
    assert.match(r.stderr, new RegExp(id))
    assert.ok(!existsSync(join(out, 'invoices.csv')) && !existsSync(join(out, 'invoice_lines.csv')))
  })
}

test('引数の誤り: --month の形式が不正なら終了コード 1', () => {
  const out = mkdtempSync(join(tmpdir(), 'invoice-arg-'))
  assert.equal(run('--month', '2026-13', '--data', join(datasets, 'status', 'input'), '--out', out).status, 1)
})

test('引数の誤り: --out がなければ終了コード 1', () => {
  assert.equal(run('--month', '2026-09', '--data', join(datasets, 'status', 'input')).status, 1)
})
