import { formatYen } from './money.js'

export function salesLine(name, amount) {
  return `${name}: ${formatYen(amount)}`
}

export function salesReport(rows) {
  const total = rows.reduce((s, r) => s + r.amount, 0)
  return [...rows.map(r => salesLine(r.name, r.amount)), `TOTAL: ${formatYen(total)}`].join('\n')
}
