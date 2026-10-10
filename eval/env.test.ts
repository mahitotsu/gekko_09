// npx tsx --test eval/env.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contamination, type InitRecord } from './env'

const init = (over: Partial<InitRecord> = {}): InitRecord => ({
  claudeCodeVersion: '2.1.295',
  model: 'claude-opus-5-5',
  permissionMode: 'acceptEdits',
  apiKeySource: 'none',
  outputStyle: 'default',
  tools: ['Bash', 'Read'],
  mcpServers: [],
  skills: ['debug', 'verify'],
  agents: ['Explore'],
  plugins: ['cc-plugin-telemetry@builtin', 'eval-probe@inline'],
  pluginErrors: [],
  slashCommands: [],
  ...over,
})

test('a clean session passes', () => {
  assert.equal(contamination(init(), ['eval-probe'], ['debug', 'verify']), undefined)
})

test('catches what the eval did not load', () => {
  assert.match(contamination(init({ apiKeySource: 'ANTHROPIC_API_KEY' }), ['eval-probe'])!, /apiKeySource/)
  assert.match(contamination(init({ mcpServers: ['claude.ai Gmail:needs-auth'] }), ['eval-probe'])!, /MCP/)
  assert.match(contamination(init(), ['model-router', 'eval-probe'])!, /expected eval-probe@inline, model-router@inline/)
  assert.match(contamination(init({ skills: ['anthropic-skills:pdf', 'debug'] }), ['eval-probe'])!, /anthropic-skills:pdf/)
  assert.match(contamination(init({ skills: ['debug', 'verify', 'extra'] }), ['eval-probe'], ['debug', 'verify'])!, /extra/)
})
