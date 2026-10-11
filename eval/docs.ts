// The documents a scenario's stages produce, shared by the document graders
// (eval/grade-docs.ts, eval/compare-docs.ts).
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { StageId } from './scenarios/types'

// Which rubric grades which product of which stage.
export const DOCS: { stage: StageId; rubric: string; paths: string[] }[] = [
  { stage: 'requirements', rubric: 'requirements.md', paths: ['docs/requirements.md'] },
  { stage: 'design', rubric: 'design.md', paths: ['docs/design.md'] },
  { stage: 'test', rubric: 'tests.md', paths: ['test/'] },
  { stage: 'report', rubric: 'spec.md', paths: ['docs/spec.md'] },
  { stage: 'report', rubric: 'report.md', paths: ['docs/report.md'] },
]

export const exists = (p: string) => stat(p).then(() => true, () => false)

// The text of a product: one file, or every file under a directory.
export const readProduct = async (root: string, path: string): Promise<string | undefined> => {
  const p = join(root, path.replace(/\/$/, ''))
  if (!(await exists(p))) return undefined
  if (!path.endsWith('/')) return readFile(p, 'utf8')
  const parts: string[] = []
  const walk = async (dir: string, rel: string) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${rel}${e.name}/`)
      else parts.push(`--- ${path}${rel}${e.name}\n${await readFile(join(dir, e.name), 'utf8')}`)
    }
  }
  await walk(p, '')
  return parts.join('\n\n')
}
