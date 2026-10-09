import { TAX_RATE } from './config.js'

// Formats an integer yen amount: 1200 -> "¥1,200"
export function formatYen(amount) {
  return '¥' + String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Tax-inclusive price in whole yen. Spec: round half up to the nearest yen.
export function addTax(price, rate = TAX_RATE) {
  return Math.floor(price * (1 + rate))
}
