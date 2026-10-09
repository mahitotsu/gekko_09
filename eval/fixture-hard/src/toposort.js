// See docs/toposort.md.
// TODO: order among ready nodes is arbitrary, and cycles are not reported.
export function toposort(deps) {
  const indegree = new Map()
  const users = new Map()
  for (const [node, ds] of Object.entries(deps)) {
    indegree.set(node, (indegree.get(node) ?? 0) + ds.length)
    for (const d of ds) {
      if (!indegree.has(d)) indegree.set(d, 0)
      users.set(d, [...(users.get(d) ?? []), node])
    }
  }
  const ready = [...indegree].filter(([, n]) => n === 0).map(([k]) => k)
  const out = []
  while (ready.length) {
    const n = ready.pop()
    out.push(n)
    for (const u of users.get(n) ?? []) {
      indegree.set(u, indegree.get(u) - 1)
      if (indegree.get(u) === 0) ready.push(u)
    }
  }
  return out
}
