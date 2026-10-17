// A large scenario: external materials in, a business app and its
// documents out, in five stages. Each scenario lives in eval/scenarios/<id>/:
//   materials/  copied to docs/資料/ in the workspace (minutes, rules, spec, data)
//   workspace/  the starting repository
//   reference/  the model output of every stage (docs/, src/, test/)
//   hidden/     acceptance.test.js and datasets/, copied in only to grade
//   rubric/     one checklist per document stage, for blind grading
export type StageId = 'requirements' | 'design' | 'implement' | 'test' | 'report'

export type Stage = {
  id: StageId
  prompt: string
  // Short requests sent after the stage's main prompt, in the same session.
  followUps?: readonly string[]
  // What the stage produces, as workspace paths (a trailing / means a directory):
  // snapshotted when its turns end, kept for grading, and taken from
  // reference/ when a later stage starts from the model output.
  produces: readonly string[]
}

export type Scenario = {
  id: string
  title: string
  stages: readonly Stage[]
  // The whole job in one request, for the single-turn autonomous run.
  autonomousPrompt: string
}
