// 隠しテストのデータセットと期待値を作る（作業ディレクトリには持ち込まない）。
//   node eval/scenarios/expense/hidden/make-datasets.mjs
// 期待値は reference/src/cli.js の出力。要所の手計算は reference/test にある。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '../reference/src/cli.js')
const out = join(here, 'datasets')

const csv = (cols, rows) => [cols.join(','), ...rows.map(r => r.join(','))].join('\n') + '\n'
const FILES = {
  employees: ['employee_id', 'name', 'grade', 'manager_id', 'department'],
  claims: ['claim_id', 'employee_id', 'submit_date'],
  items: ['claim_id', 'item_no', 'date', 'category', 'amount', 'receipt', 'count', 'kind'],
}

// 組織: 役員 X1 ─ 部長 X2 ─ 課長 X3 ─ 主任 X4 ─ 一般 X5、役員 X1 ─ 部長 X6 ─ 一般 X7（課長・主任を飛ばす）
const ORG = [
  ['X1', '役員一', '役員', '', '経営'], ['X2', '部長二', '部長', 'X1', '技術'], ['X3', '課長三', '課長', 'X2', '技術'],
  ['X4', '主任四', '主任', 'X3', '技術'], ['X5', '一般五', '一般', 'X4', '技術'], ['X6', '部長六', '部長', 'X1', '総務'],
  ['X7', '一般七', '一般', 'X6', '総務'],
]
const it = (claim, no, date, category, amount, receipt = '有', count = '', kind = '') => [claim, no, date, category, amount, receipt, count, kind]

const DATASETS = {
  // 期限（60日はよく、61日は却下）、提出日より後の日付、提出日当日
  deadline: {
    month: '2026-10',
    claims: [['D1', 'X5', '2026-10-31']],
    items: [it('D1', 1, '2026-09-01', '交通費', 500), it('D1', 2, '2026-08-31', '交通費', 600), it('D1', 3, '2026-10-31', '交通費', 700), it('D1', 4, '2026-11-01', '交通費', 800)],
  },
  // 領収書: 999円は不要、1,000円から必要。日当は不要。宿泊費・会議費も必要
  receipt: {
    month: '2026-10',
    claims: [['R1', 'X5', '2026-10-10']],
    items: [
      it('R1', 1, '2026-10-01', '交通費', 999, '無'), it('R1', 2, '2026-10-01', '交通費', 1000, '無'),
      it('R1', 3, '2026-10-02', '日当', 2000, '無', 1, '宿泊'), it('R1', 4, '2026-10-02', '宿泊費', 5000, '無', 1, '大阪'),
      it('R1', 5, '2026-10-03', '会議費', 3000, '無', 2), it('R1', 6, '2026-10-03', '物品', 998, '無'),
    ],
  },
  // 宿泊費: 役職と地域の上限、泊数、上限ちょうど、10月1日の改定（東京の一般・主任のみ）の前日と当日
  lodging: {
    month: '2026-10',
    claims: [['L1', 'X5', '2026-10-15'], ['L2', 'X4', '2026-10-15'], ['L3', 'X3', '2026-10-15'], ['L4', 'X2', '2026-10-15'], ['L5', 'X1', '2026-10-15']],
    items: [
      it('L1', 1, '2026-09-30', '宿泊費', 11000, '有', 1, '東京'), it('L1', 2, '2026-10-01', '宿泊費', 11000, '有', 1, '東京'),
      it('L1', 3, '2026-10-01', '宿泊費', 20000, '有', 2, '大阪'), it('L1', 4, '2026-10-02', '宿泊費', 24000, '有', 3, 'その他'),
      it('L2', 1, '2026-09-30', '宿泊費', 13000, '有', 1, '東京'), it('L2', 2, '2026-10-01', '宿泊費', 13000, '有', 1, '東京'),
      it('L2', 3, '2026-10-03', '宿泊費', 30000, '有', 3, '大阪'),
      it('L3', 1, '2026-10-01', '宿泊費', 13000, '有', 1, '東京'), it('L3', 2, '2026-10-02', '宿泊費', 10001, '有', 1, 'その他'),
      it('L4', 1, '2026-10-01', '宿泊費', 30000, '有', 2, '東京'), it('L4', 2, '2026-10-05', '宿泊費', 13000, '有', 1, '大阪'),
      it('L5', 1, '2026-10-01', '宿泊費', 40000, '有', 2, '東京'), it('L5', 2, '2026-10-06', '宿泊費', 15000, '有', 1, 'その他'),
    ],
  },
  // 日当: 役職ごとの日額、日帰りは半額、申請額が規程額より少なければ申請額
  daily: {
    month: '2026-10',
    claims: [['A1', 'X4', '2026-10-20'], ['A2', 'X3', '2026-10-20'], ['A3', 'X1', '2026-10-20']],
    items: [
      it('A1', 1, '2026-10-01', '日当', 5000, '無', 3, '日帰り'), it('A1', 2, '2026-10-05', '日当', 7500, '無', 3, '宿泊'),
      it('A1', 3, '2026-10-09', '日当', 1000, '無', 1, '日帰り'),
      it('A2', 1, '2026-10-02', '日当', 9000, '無', 3, '宿泊'), it('A2', 2, '2026-10-06', '日当', 1600, '無', 1, '日帰り'),
      it('A3', 1, '2026-10-03', '日当', 12500, '無', 5, '日帰り'),
    ],
  },
  // 会議費: 1人5,000円ちょうどは会議費、超えると接待費（部長の承認が必要になる）。却下された会議費は経路に影響しない
  meeting: {
    month: '2026-10',
    claims: [['M1', 'X5', '2026-10-20'], ['M2', 'X5', '2026-10-21'], ['M3', 'X7', '2026-10-22']],
    items: [
      it('M1', 1, '2026-10-01', '会議費', 15000, '有', 3), it('M1', 2, '2026-10-02', '会議費', 4000, '有', 1),
      it('M2', 1, '2026-10-03', '会議費', 15001, '有', 3),
      it('M3', 1, '2026-10-04', '会議費', 20000, '無', 2), it('M3', 2, '2026-10-04', '交通費', 600, '有'),
    ],
  },
  // 承認経路: 5万円・30万円の境界、接待費、上長が課長の場合の部長までの上り、部長の申請、役員の申請、全部却下
  route: {
    month: '2026-10',
    claims: [
      ['P1', 'X5', '2026-10-05'], ['P2', 'X5', '2026-10-06'], ['P3', 'X4', '2026-10-07'], ['P4', 'X3', '2026-10-08'],
      ['P5', 'X3', '2026-10-09'], ['P6', 'X2', '2026-10-10'], ['P7', 'X1', '2026-10-11'], ['P8', 'X7', '2026-10-12'],
      ['P9', 'X7', '2026-10-13'], ['PA', 'X5', '2026-10-14'],
    ],
    items: [
      it('P1', 1, '2026-10-01', '交通費', 49999), it('P2', 1, '2026-10-01', '交通費', 50000),
      it('P3', 1, '2026-10-01', '接待費', 3000, '有', 2), it('P4', 1, '2026-10-01', '交通費', 299999),
      it('P5', 1, '2026-10-01', '交通費', 300000), it('P6', 1, '2026-10-01', '交通費', 40000),
      it('P7', 1, '2026-10-01', '交通費', 800), it('P8', 1, '2026-10-01', '交通費', 300000),
      it('P9', 1, '2026-10-01', '交通費', 5000, '無'),
      it('PA', 1, '2026-10-01', '交通費', 30000), it('PA', 2, '2026-10-01', '交通費', 30000, '無'),
    ],
  },
  // 支払日: 翌月25日が日曜（2027-04-25）なら金曜の23日。対象月以外の申請は含めない。社員ごとに合計
  payday: {
    month: '2027-03',
    claims: [['Q1', 'X5', '2027-03-01'], ['Q2', 'X5', '2027-03-31'], ['Q3', 'X5', '2027-02-28'], ['Q4', 'X4', '2027-04-01'], ['Q5', 'X7', '2027-03-15']],
    items: [it('Q1', 1, '2027-02-20', '交通費', 700), it('Q2', 1, '2027-03-30', '交通費', 900), it('Q3', 1, '2027-02-20', '交通費', 500), it('Q4', 1, '2027-03-31', '交通費', 400), it('Q5', 1, '2027-03-01', '交通費', 2000, '無')],
  },
  // 支払日: 翌月25日が土曜（2027-09-25）なら24日
  paySat: {
    month: '2027-08',
    claims: [['S1', 'X5', '2027-08-20']],
    items: [it('S1', 1, '2027-08-19', '交通費', 300)],
  },
  // 支払日: 12月分は翌年1月25日。物品の 99,999円と 100,000円
  yearEnd: {
    month: '2026-12',
    claims: [['Y1', 'X7', '2026-12-10']],
    items: [it('Y1', 1, '2026-12-01', '物品', 99999), it('Y1', 2, '2026-12-02', '物品', 100000)],
  },
}

// 乱数で作る大きめのデータ（シード固定）
const rand = (seed => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648))(20261011)
const pick = xs => xs[Math.floor(rand() * xs.length)]
const employees = [['Z00', '乱数役員', '役員', '', '経営']]
for (let d = 1; d <= 3; d++) {
  employees.push([`Z${d}0`, `乱数部長${d}`, '部長', 'Z00', `部${d}`])
  employees.push([`Z${d}1`, `乱数課長${d}`, '課長', `Z${d}0`, `部${d}`])
  employees.push([`Z${d}2`, `乱数主任${d}`, '主任', `Z${d}1`, `部${d}`])
  for (let k = 3; k <= 6; k++) employees.push([`Z${d}${k}`, `乱数一般${d}${k}`, '一般', pick([`Z${d}1`, `Z${d}2`]), `部${d}`])
}
const date = (base, offset) => new Date(Date.parse(base) + offset * 86400000).toISOString().slice(0, 10)
const claims = []
const items = []
for (let n = 1; n <= 120; n++) {
  const id = `C${String(n).padStart(3, '0')}`
  const submit = date('2026-09-20', Math.floor(rand() * 50))
  claims.push([id, pick(employees)[0], submit])
  const k = 1 + Math.floor(rand() * 5)
  for (let i = 1; i <= k; i++) {
    const cat = pick(['交通費', '交通費', '宿泊費', '日当', '会議費', '接待費', '物品'])
    const d = date(submit, -Math.floor(rand() * 75) + (rand() < 0.03 ? 3 : 0))
    const receipt = rand() < 0.15 ? '無' : '有'
    const count = ['宿泊費', '日当', '会議費', '接待費'].includes(cat) ? 1 + Math.floor(rand() * 4) : ''
    const kind = cat === '宿泊費' ? pick(['東京', '大阪', 'その他']) : cat === '日当' ? pick(['日帰り', '宿泊']) : ''
    const amount = cat === '物品' ? Math.floor(rand() * 130000) : cat === '交通費' ? Math.floor(rand() * (rand() < 0.1 ? 400000 : 30000)) : Math.floor(rand() * 20000 * (count || 1))
    items.push(it(id, i, d, cat, amount, receipt, count, kind))
  }
}
DATASETS.random = { month: '2026-10', employees, claims, items }

rmSync(out, { recursive: true, force: true })
const write = (dir, d) => {
  mkdirSync(dir, { recursive: true })
  for (const [name, cols] of Object.entries(FILES)) writeFileSync(join(dir, `${name}.csv`), csv(cols, d[name] ?? (name === 'employees' ? ORG : [])))
}
for (const [name, d] of Object.entries(DATASETS)) {
  const dir = join(out, name)
  write(join(dir, 'input'), d)
  writeFileSync(join(dir, 'month'), d.month + '\n')
  execFileSync('node', [cli, '--month', d.month, '--data', join(dir, 'input'), '--out', join(dir, 'expected')])
}

// 入力の不整合（終了コード 2）。それぞれ、問題の行を示す番号がメッセージに出ること。
const okClaim = ['G1', 'X5', '2026-10-05']
const okItem = it('G1', 1, '2026-10-01', '交通費', 500)
const BAD = {
  badEmployee: [{ claims: [okClaim, ['G2', 'X9', '2026-10-06']], items: [okItem, it('G2', 1, '2026-10-01', '交通費', 500)] }, 'G2'],
  noItems: [{ claims: [okClaim, ['G3', 'X5', '2026-09-06']], items: [okItem] }, 'G3'],
  orphanItem: [{ claims: [okClaim], items: [okItem, it('G4', 1, '2026-10-01', '交通費', 500)] }, 'G4'],
  badCategory: [{ claims: [okClaim], items: [okItem, it('G1', 2, '2026-10-01', '雑費', 500)] }, 'G1'],
  badCount: [{ claims: [okClaim], items: [okItem, it('G1', 2, '2026-10-01', '宿泊費', 5000, '有', '', '東京')] }, 'G1'],
  badKind: [{ claims: [okClaim], items: [okItem, it('G1', 2, '2026-10-01', '日当', 2000, '無', 1, '出張')] }, 'G1'],
  badReceipt: [{ claims: [okClaim], items: [okItem, it('G1', 2, '2026-10-01', '交通費', 500, 'あり')] }, 'G1'],
  badManager: [{ employees: [...ORG, ['X8', '一般八', '一般', 'X99', '総務']], claims: [okClaim], items: [okItem] }, 'X8'],
  badGrade: [{ employees: [...ORG, ['X8', '嘱託八', '嘱託', 'X6', '総務']], claims: [okClaim], items: [okItem] }, 'X8'],
}
for (const [name, [d, id]] of Object.entries(BAD)) {
  write(join(out, name, 'input'), d)
  writeFileSync(join(out, name, 'error-id'), id + '\n')
}
console.log(`datasets -> ${out}`)
