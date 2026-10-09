// Stock kept in a slow store (think: a remote database).
export class Inventory {
  constructor(store) {
    this.store = store // { get(sku): Promise<number>, set(sku, n): Promise<void> }
  }

  // Reserves qty units of sku; resolves true when reserved, false when out of stock.
  async reserve(sku, qty) {
    const stock = await this.store.get(sku)
    if (stock < qty) return false
    await this.store.set(sku, stock - qty)
    return true
  }

  async release(sku, qty) {
    const stock = await this.store.get(sku)
    await this.store.set(sku, stock + qty)
  }
}

// An in-memory store with latency, for tests.
export function memoryStore(initial, delayMs = 5) {
  const data = new Map(Object.entries(initial))
  const wait = () => new Promise(r => setTimeout(r, delayMs))
  return {
    async get(sku) {
      await wait()
      return data.get(sku) ?? 0
    },
    async set(sku, n) {
      await wait()
      data.set(sku, n)
    },
  }
}
