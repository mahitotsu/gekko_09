// See docs/cache.md.
// TODO: no TTL, no capacity limit, no onEvict yet.
export class TtlCache {
  constructor(options = {}) {
    this.options = options
    this.map = new Map()
  }

  set(key, value) {
    this.map.set(key, value)
  }

  get(key) {
    return this.map.get(key)
  }

  delete(key) {
    return this.map.delete(key)
  }

  get size() {
    return this.map.size
  }
}
