// The large scenarios as eval tasks. Each scenario gives:
//   <id>/script   the stages as a multi-turn conversation (prompts and follow-ups)
//   <id>/auto     the whole job in one request
//   <id>/stage-N  stage N alone, started from the model output of the stages before it
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Task } from '../tasks'
import { expense } from './expense/scenario'
import { invoice } from './invoice/scenario'
import type { Scenario, Stage } from './types'

export const SCENARIOS: readonly Scenario[] = [invoice, expense]

export const scenarioDir = (id: string) => fileURLToPath(new URL(`./${id}/`, import.meta.url))

// Copies a workspace path (file, or directory with a trailing /) from one root to another.
export const copyPath = async (from: string, to: string, path: string) => {
  const p = path.replace(/\/$/, '')
  await mkdir(join(to, p, '..'), { recursive: true })
  await cp(join(from, p), join(to, p), { recursive: true }).catch(err => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  })
}

// The starting workspace, with the model output of `before` copied in.
const prepare = (s: Scenario, before: readonly Stage[]) => async (cwd: string) => {
  const dir = scenarioDir(s.id)
  await cp(join(dir, 'workspace'), cwd, { recursive: true })
  await cp(join(dir, 'materials'), join(cwd, 'docs', '資料'), { recursive: true })
  for (const stage of before) for (const path of stage.produces) await copyPath(join(dir, 'reference'), cwd, path)
}

const promptsOf = (stage: Stage) => [stage.prompt, ...(stage.followUps ?? [])]

// Snapshot a stage's products after the last prompt of that stage.
const snapshotsOf = (stages: readonly Stage[]) =>
  stages.flatMap(stage => promptsOf(stage).map((_, i, all) => (i === all.length - 1 ? stage.produces : undefined)))

export const scenarioTasks = (s: Scenario): Task[] => [
  {
    id: `${s.id}/script`,
    level: 'scenario',
    split: s.split,
    prompt: s.stages.flatMap(promptsOf),
    prepare: prepare(s, []),
    maxTurns: 80,
    snapshots: snapshotsOf(s.stages),
    grade: { kind: 'scenario', scenario: s.id },
  },
  {
    id: `${s.id}/auto`,
    level: 'scenario',
    split: s.split,
    prompt: s.autonomousPrompt,
    prepare: prepare(s, []),
    maxTurns: 200,
    grade: { kind: 'scenario', scenario: s.id },
  },
  ...s.stages.map(
    (stage, i): Task => ({
      id: `${s.id}/stage-${i + 1}`,
      level: 'scenario',
      split: s.split,
      prompt: promptsOf(stage),
      prepare: prepare(s, s.stages.slice(0, i)),
      maxTurns: 80,
      snapshots: snapshotsOf([stage]),
      grade: { kind: 'scenario', scenario: s.id, stage: stage.id },
    }),
  ),
]
