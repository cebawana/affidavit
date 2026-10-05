import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// --- First-run experience (#28): apps without sign-in, presets, hints ---

import { credentialsFor } from '../src/env.mjs'
import { suggestAction } from '../src/spec.mjs'
import { PRESETS } from '../src/presets.mjs'
import { detectPort, init, pageTitle, rolesCheck, serverDetail } from '../src/init.mjs'
import { existsSync, readFileSync } from 'node:fs'

const tmp = () => mkdtempSync(join(tmpdir(), 'affidavit-test-'))

test('auth.type none never looks credentials up', () => {
  delete process.env.QA_ADMIN_EMAIL
  assert.equal(credentialsFor('admin', 'QA_', { type: 'none' }), null)
  assert.equal(credentialsFor('none', 'QA_', { type: 'form' }), null)
  assert.throws(() => credentialsFor('admin', 'QA_', { type: 'form' }), /QA_ADMIN_EMAIL[\s\S]*role: none/)
})

test('defaultRole fills a missing role; without it role is required', () => {
  const noRole = SPEC.replace('role: admin\n', '')
  assert.equal(parseSpec(noRole, 'demo', { defaultRole: 'none' }).role, 'none')
  assert.equal(parseSpec(SPEC, 'demo', { defaultRole: 'none' }).role, 'admin', 'a written role wins')
  assert.throws(() => parseSpec(noRole, 'demo'), /needs "role"[\s\S]*defaultRole/)
})

test('front matter typos get a hint', () => {
  assert.throws(() => parseSpec(SPEC.replace('role: admin', 'rol: admin'), 'demo'), /unknown key "rol" — did you mean "role:"/)
  assert.throws(() => parseSpec(SPEC.replace('role: admin', 'role: admin\nauthor: me'), 'demo'), /unknown key "author" \(known: id, title, role/)
})

test('an id that differs from the file name is a warning, not an error', () => {
  assert.deepEqual(parseSpec(SPEC, 'qa/specs/demo.qa.md').warnings, [])
  assert.match(parseSpec(SPEC, 'qa/specs/other.qa.md').warnings[0], /id "demo" differs from the file name "other.qa.md"/)
  assert.deepEqual(parseSpec(SPEC, 'qa/specs/_template.qa.md').warnings, [], 'templates are copied and renamed, so no warning')
})

test('unknown actions suggest the closest valid one', () => {
  assert.equal(suggestAction('scroll and look for "Pricing"'), 'scroll to "Pricing"')
  assert.equal(suggestAction('tap "Save"'), 'click "Save"')
  assert.equal(suggestAction('clik "Save"'), 'click "Save"')
  assert.equal(suggestAction('type "Ada" into "Name"'), 'fill "Name" with "Ada"')
  assert.equal(suggestAction('go to "/home"'), 'open "/home"')
  assert.equal(suggestAction('click "A" next to "B"'), 'click "A" near "B"')
  assert.equal(suggestAction('refresh'), 'reload')
  assert.equal(suggestAction('hover "Menu"'), null)
  let err
  try { parseSpec(SPEC.replace('click "Open"', 'scroll and look for "Open"'), 'demo') } catch (e) { err = e }
  assert.match(err.message, /did you mean `scroll to "Open"`/)
  assert.equal(err.unknownAction, true, 'so the CLI can print the vocabulary once per run')
})

test('presets carry the dev-server port and the project can override it', () => {
  assert.equal(PRESETS.vite.port, 5173)
  assert.equal(PRESETS.next.port, 3000)
  const root = tmp()
  assert.equal(detectPort(root), null)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite --port 4321' } }))
  assert.equal(detectPort(root), 4321)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev -p 3100' } }))
  assert.equal(detectPort(root), 3100)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
  writeFileSync(join(root, 'vite.config.ts'), 'export default { server: { port: 8080 } }')
  assert.equal(detectPort(root), 8080)
})

test('init --no-auth: no credentials anywhere, Vite port, example with role none', () => {
  const root = tmp()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'site', devDependencies: { vite: '^6' } }))
  init(root, { auth: false })
  const config = JSON.parse(readFileSync(join(root, 'affidavit.config.json'), 'utf8'))
  assert.equal(config.baseUrl, 'http://localhost:5173')
  assert.equal(config.preset, 'vite')
  assert.deepEqual(config.auth, { type: 'none' })
  assert.equal(config.defaultRole, 'none')
  assert.ok(!existsSync(join(root, '.env.qa.example')), 'no env template for an app without sign-in')
  const example = readFileSync(join(root, 'qa/specs/_example.qa.md'), 'utf8')
  assert.match(example, /^role: none$/m)
  // The generated project parses and resolves with no env file at all.
  const loaded = loadConfig(root)
  const spec = parseSpec(example, '_example.qa.md', { defaultRole: loaded.defaultRole })
  assert.equal(credentialsFor(spec.role, loaded.envPrefix, loaded.auth), null)
  assert.equal(rolesCheck(loaded).detail, 'no sign-in needed (auth.type is "none")')
})

test('init with sign-in keeps today\'s shape, and --base-url wins over the preset', () => {
  const root = tmp()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }))
  init(root, { baseUrl: 'http://localhost:4000' })
  const config = JSON.parse(readFileSync(join(root, 'affidavit.config.json'), 'utf8'))
  assert.equal(config.baseUrl, 'http://localhost:4000')
  assert.equal(config.auth.type, 'form')
  assert.equal(config.defaultRole, undefined)
  assert.ok(existsSync(join(root, '.env.qa.example')))
  assert.match(readFileSync(join(root, 'qa/specs/_example.qa.md'), 'utf8'), /^role: admin$/m)
})

test('roles check follows what the specs need', () => {
  const root = tmp()
  writeFileSync(join(root, 'affidavit.config.json'), '{}')
  const config = loadConfig(root)
  mkdirSync(config.specsDir, { recursive: true })
  writeFileSync(join(config.specsDir, 'demo.qa.md'), SPEC.replace('role: admin', 'role: none'))
  assert.equal(rolesCheck(config).detail, 'no sign-in needed (every spec uses role: none)')
  writeFileSync(join(config.specsDir, 'demo.qa.md'), SPEC)
  delete process.env.QA_ADMIN_EMAIL
  delete process.env.QA_ADMIN_PASSWORD
  const missing = rolesCheck(config)
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /no credentials for admin: set QA_ADMIN_EMAIL \/ _PASSWORD[\s\S]*role: none/)
  process.env.QA_ADMIN_EMAIL = 'a@b.test'
  process.env.QA_ADMIN_PASSWORD = 'x'
  assert.deepEqual(rolesCheck(config), { ok: true, detail: 'admin' })
  delete process.env.QA_ADMIN_EMAIL
  delete process.env.QA_ADMIN_PASSWORD
})

test('doctor shows what answered', () => {
  assert.equal(pageTitle('<html><head><title>\n  Portfolio </title></head></html>'), 'Portfolio')
  assert.equal(pageTitle('<p>no title</p>'), null)
  assert.equal(serverDetail('http://localhost:5173', 'http://localhost:5173/', 'Portfolio'), 'http://localhost:5173 → "Portfolio"')
  assert.equal(serverDetail('http://localhost:3000', 'http://localhost:3000/login?next=%2F', 'Other App'), 'http://localhost:3000 → /login?next=%2F "Other App"')
  assert.equal(serverDetail('http://localhost:3000', 'https://accounts.example.com/sso', null), 'http://localhost:3000 → https://accounts.example.com/sso (no page title)')
})
