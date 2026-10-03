import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindVariables, parseAction, parseSpec, toSpecMarkdown } from '../src/spec.mjs'
import { DEFAULTS, loadConfig, resolveViewport } from '../src/config.mjs'
import { overall } from '../src/reviewer.mjs'
import { signInSteps } from '../src/browser.mjs'

const SPEC = `---
id: demo
title: Demo flow
role: admin
viewport: phone
start: /home
---
## Goal
Do the thing.

## Steps
### 1. Open it
- do: click "Open"
- do: fill "Name" with "QA {run}"
- expect: It is open.

## Success criteria
- It worked.
`

test('parses a scripted spec', () => {
  const spec = parseSpec(SPEC, 'demo')
  assert.equal(spec.mode, 'scripted')
  assert.equal(spec.steps.length, 1)
  assert.deepEqual(spec.steps[0].actions.map(a => a.kind), ['click', 'fill'])
  assert.equal(spec.viewport, 'phone')
})

test('a spec with only a goal explores', () => {
  const spec = parseSpec(SPEC.replace(/## Steps[\s\S]*?(?=## Success)/, ''), 'demo')
  assert.equal(spec.mode, 'explore')
})

test('windows line endings parse the same', () => {
  assert.equal(parseSpec(SPEC.replace(/\n/g, '\r\n'), 'demo').steps.length, 1)
})

test('rejects code leaks', () => {
  for (const leak of ['check /api/users', 'the data-testid "x"', 'see Invoice.tsx', 'the invoice.send permission']) {
    assert.throws(() => parseSpec(SPEC.replace('Do the thing.', leak), 'demo'), /visible on screen/, leak)
  }
})

test('project leak terms', () => {
  assert.doesNotThrow(() => parseSpec(SPEC.replace('Do the thing.', 'the postgres row'), 'demo'))
  assert.throws(() => parseSpec(SPEC.replace('Do the thing.', 'the postgres row'), 'demo', { leakTerms: ['postgres'] }), /project-internal/)
  assert.throws(() => parseSpec(SPEC.replace('Do the thing.', 'the tenant_id column'), 'demo', { leakTerms: ['/\\btenant_id\\b/'] }), /project-internal/)
})

test('reports every problem at once', () => {
  const bad = SPEC.replace('- expect: It is open.', '').replace('click "Open"', 'tap Open')
  const err = assert.throws(() => parseSpec(bad, 'demo'), /cannot read the action[\s\S]*no "- expect:"/)
})

test('action vocabulary', () => {
  assert.deepEqual(parseAction('click "Approve" near "Row 1"'), { kind: 'click', target: 'Approve', near: 'Row 1', text: 'click "Approve" near "Row 1"' })
  assert.equal(parseAction('select "Currency" option "EUR"').kind, 'select')
  assert.equal(parseAction('reload').kind, 'reload')
  assert.equal(parseAction('`wait for "Done"`').kind, 'waitFor')
  assert.equal(parseAction('hover "Menu"'), null)
})

test('variables bind everywhere', () => {
  const spec = bindVariables(parseSpec(SPEC, 'demo'), { run: 'ab2cd' })
  assert.equal(spec.steps[0].actions[1].value, 'QA ab2cd')
})

test('recorded spec round-trips', () => {
  const spec = parseSpec(SPEC, 'demo')
  const again = parseSpec(toSpecMarkdown(spec, spec.steps), 'recorded')
  assert.equal(again.id, 'demo-recorded')
  assert.equal(again.steps[0].actions.length, 2)
  assert.equal(again.viewport, 'phone')
})

test('viewports by name or size', () => {
  const config = { ...DEFAULTS }
  assert.deepEqual(resolveViewport('phone', config), { width: 390, height: 844, name: 'phone' })
  assert.deepEqual(resolveViewport('1440x900', config), { width: 1440, height: 900, name: 'desktop' })
  assert.equal(resolveViewport(undefined, config).name, 'desktop')
  assert.throws(() => resolveViewport('watch', config), /unknown viewport/)
})

test('config merges over defaults and applies the preset', () => {
  const root = mkdtempSync(join(tmpdir(), 'affidavit-test-'))
  writeFileSync(join(root, 'affidavit.config.json'), JSON.stringify({ preset: 'next', auth: { fields: { email: 'Email address' } } }))
  const config = loadConfig(root)
  assert.equal(config.auth.fields.email, 'Email address')
  assert.equal(config.auth.fields.password, 'Password')
  assert.equal(config.auth.doneWhenGone, 'Email address')
  assert.ok(config.hide.includes('nextjs-portal'))
  assert.equal(config.notFoundText, 'This page could not be found')
})

test('sign-in masks the password', () => {
  const steps = signInSteps(DEFAULTS.auth, { email: 'a@b.test', password: 'secret' }, '/x', 1000)
  assert.ok(steps.every(s => !s.text.includes('secret')))
  assert.equal(steps.at(-1).path, '/x')
  assert.equal(signInSteps(DEFAULTS.auth, null, null, 1000).length, 0)
})

test('the verdict is computed, never taken from the model', () => {
  const done = [{ status: 'done' }]
  const passing = { steps: [{ verdict: 'pass' }], criteria: [{ verdict: 'pass' }], failure_signals: [{ seen: false }], other_issues: [] }
  assert.equal(overall(done, passing), 'pass')
  assert.equal(overall(done, { ...passing, steps: [{ verdict: 'unclear' }] }), 'needs_human')
  assert.equal(overall(done, { ...passing, failure_signals: [{ seen: true }] }), 'fail')
  assert.equal(overall(done, { ...passing, other_issues: [{ severity: 'high' }] }), 'fail')
  assert.equal(overall([{ status: 'blocked' }], passing), 'blocked')
  assert.equal(overall(done, null), 'not_reviewed')
  assert.equal(overall(done, passing, { stuck: true }), 'blocked')
})
