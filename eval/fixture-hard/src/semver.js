// See docs/semver.md.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parse(version) {
  const m = VERSION.exec(version)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  }
}

// TODO: only exact versions are supported so far.
export function satisfies(version, range) {
  return version === range.trim()
}
