import { MAX_CART_ITEMS } from './config.js'
import { addTax, formatYen } from './money.js'

export class Cart {
  constructor() {
    this.lines = new Map() // sku -> { price, qty }
    this.coupons = []
  }

  add(sku, price, qty = 1) {
    const line = this.lines.get(sku) ?? { price, qty: 0 }
    line.qty += qty
    if (this.count() + qty > MAX_CART_ITEMS) throw new Error('cart is full')
    this.lines.set(sku, line)
  }

  remove(sku) {
    this.lines.delete(sku)
  }

  count() {
    let n = 0
    for (const line of this.lines.values()) n += line.qty
    return n
  }

  // A coupon is a percentage off the subtotal, e.g. applyCoupon('SPRING', 10).
  applyCoupon(code, percent) {
    this.coupons.push({ code, percent })
  }

  subtotal() {
    let sum = 0
    for (const line of this.lines.values()) sum += line.price * line.qty
    return sum
  }

  // Tax-inclusive total after coupons.
  total() {
    let amount = this.subtotal()
    for (const c of this.coupons) amount = amount * (1 - c.percent / 100)
    return addTax(Math.round(amount))
  }

  // TODO: show each line, not only the total
  receipt() {
    return `合計 ${formatYen(this.total())}`
  }
}
