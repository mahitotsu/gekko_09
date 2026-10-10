// CSV の読み書き。連携仕様書 4 章: UTF-8、1 行目は見出し、区切りはカンマ、
// フィールドにカンマ・改行・ダブルクォートは含まれない。出力の改行は LF。
import { readFileSync, writeFileSync } from 'node:fs'

export function readCsv(path) {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l !== '')
  const [head, ...rows] = lines
  const cols = head.split(',')
  return rows.map(line => {
    const cells = line.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']))
  })
}

export function writeCsv(path, cols, rows) {
  const text = [cols.join(','), ...rows.map(r => cols.map(c => String(r[c])).join(','))].join('\n') + '\n'
  writeFileSync(path, text)
}
