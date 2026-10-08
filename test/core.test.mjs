import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
import { detectPort, init, pageTitle, rolesCheck, serverDetail, viteServerPort } from '../src/init.mjs'
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
  assert.match(parseSpec(SPEC.replace("role: admin", "role: admin\nauthor: me"), "demo").warnings[0], /key "author" is not one Affidavit reads/)
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

test('an unrelated front-matter key is kept with a warning; a typo is an error', () => {
  const spec = parseSpec(SPEC.replace('role: admin', 'role: admin\ngrandmap: finance'), 'demo')
  assert.equal(spec.grandmap, 'finance')
  assert.match(spec.warnings[0], /key "grandmap" is not one Affidavit reads/)
  assert.throws(() => parseSpec(SPEC.replace('viewport: phone', 'viewprot: phone'), 'demo'), /did you mean "viewport:"/)
})

test('the typo check scales with key length, so short metadata keys are warnings', () => {
  const cases = [
    ['rol: admin', 'role'],        // one edit: a typo at any length
    ['viewprot: phone', 'viewport'], // two edits in an 8-letter key: a typo
    ['state: draft', null],        // two edits from `start`, but only 5 letters
    ['pr: 12', null],              // two edits from `id`
    ['ui: v2', null],              // two edits from `id`
    ['mode: fast', null],          // two edits from `role`
  ]
  for (const [line, typoOf] of cases) {
    const text = SPEC.replace('role: admin', `role: admin\n${line}`)
    if (typoOf) {
      assert.throws(() => parseSpec(text, 'demo'), new RegExp(`unknown key "${line.split(':')[0]}" — did you mean "${typoOf}:"`), line)
    } else {
      const spec = parseSpec(text, 'demo')
      assert.match(spec.warnings.join('\n'), new RegExp(`key "${line.split(':')[0]}" is not one Affidavit reads`), line)
    }
  }
})

test('vite server.port is read from the server block only', () => {
  assert.equal(viteServerPort('export default { server: { hmr: { port: 24678 }, port: 4000 } }'), 4000)
  assert.equal(viteServerPort('export default { server: { hmr: { port: 24678 } } }'), null)
  assert.equal(viteServerPort('export default { preview: { port: 4173 } }'), null)
  assert.equal(viteServerPort('export default defineConfig({\n  server: {\n    port: 5180,\n    open: true,\n  },\n})'), 5180)
})

// --- Review pipeline (#29) and saved sessions (#16) ---

import { createQueue, isRateLimit, withRetry } from '../src/queue.mjs'
import { concurrencyFor } from '../src/backends/index.mjs'
import { RESULT_FORMAT, collectRuns, loadRun, resolveRunArg, reviewRun, reviewRuns, runMany, selectRuns, writeRun } from '../src/run.mjs'
import { sessionFor, sessionPath } from '../src/session.mjs'
import { loginFormVisible } from '../src/browser.mjs'

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

test('the queue runs at most `concurrency` jobs at once, in order', async () => {
  const q = createQueue(2)
  let active = 0
  let peak = 0
  const started = []
  const jobs = [1, 2, 3, 4, 5].map(n => q.add(async () => {
    started.push(n)
    active++
    peak = Math.max(peak, active)
    await tick(10)
    active--
    return n * 10
  }))
  assert.equal(q.active, 2)
  assert.equal(q.waiting, 3)
  assert.deepEqual(await Promise.all(jobs), [10, 20, 30, 40, 50])
  assert.equal(peak, 2)
  assert.deepEqual(started, [1, 2, 3, 4, 5])
  await assert.rejects(q.add(() => { throw new Error('boom') }), /boom/)
  assert.throws(() => createQueue(0), /1 or more/)
})

test('rate limits are recognised however the backend words them', () => {
  for (const msg of ['OpenRouter 429: Rate limit exceeded', 'claude CLI error: You have hit your usage limit', 'Too Many Requests', 'overloaded_error', 'OpenRouter 529: at capacity']) {
    assert.ok(isRateLimit(new Error(msg)), msg)
  }
  assert.ok(!isRateLimit(new Error('The reviewer did not return readable JSON')))
})

test('withRetry waits the given delays for a rate limit, then gives up with the error', async () => {
  const waits = []
  const sleep = ms => { waits.push(ms); return Promise.resolve() }
  let calls = 0
  const flaky = async () => { if (++calls < 3) throw new Error('429 rate limit'); return 'ok' }
  assert.equal(await withRetry(flaky, { delays: [1, 2, 3], sleep }), 'ok')
  assert.deepEqual(waits, [1, 2])
  calls = 0
  await assert.rejects(withRetry(flaky, { delays: [1], sleep }), /rate limit/, 'one retry was not enough')
  let other = 0
  await assert.rejects(withRetry(async () => { other++; throw new Error('bad JSON') }, { delays: [1, 2], sleep }), /bad JSON/)
  assert.equal(other, 1, 'only rate limits are retried')
})

test('review concurrency comes from the config, then the backend', () => {
  assert.equal(concurrencyFor({ name: 'claude-cli' }), 2)
  assert.equal(concurrencyFor({ name: 'openrouter' }), 4)
  assert.equal(concurrencyFor({ name: 'claude-cli', concurrency: 5 }), 5)
  const root = tmp()
  writeFileSync(join(root, 'affidavit.config.json'), JSON.stringify({ backend: { concurrency: 3 } }))
  assert.equal(concurrencyFor(loadConfig(root).backend), 3)
})

/** A project with a runs folder, and a captured-but-unreviewed run in it. */
function project(extra = {}) {
  const root = tmp()
  writeFileSync(join(root, 'affidavit.config.json'), JSON.stringify(extra))
  const config = loadConfig(root)
  mkdirSync(config.runsDir, { recursive: true })
  return config
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function fakeRun(config, { id = 'demo', runId = 'ab2cd', when = '2026-10-08T10:00:00.000Z', blocked = false } = {}) {
  const startedAt = new Date(when)
  const dir = join(config.runsDir, `${when.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'step-00.png'), PNG)
  writeFileSync(join(dir, 'step-01.png'), PNG)
  const spec = {
    file: `qa/specs/${id}.qa.md`, id, title: `Demo ${id}`, goal: 'Do the thing.', mode: 'scripted', role: 'admin', signedIn: true,
    viewportSize: { width: 390, height: 844, name: 'phone' }, start: '/home',
    preconditions: ['Signed in.'], successCriteria: ['It worked.'], failureSignals: ['Something went wrong'], outOfScope: ['Email'],
  }
  const records = [
    { n: 0, title: 'Sign in as admin and open /home', actions: [{ text: 'open "/login"', ok: true }], expect: ['Signed in.'], status: 'done', screenshot: 'step-00.png', png: PNG, url: 'http://localhost:3000/home' },
    { n: 1, title: 'Open it', actions: [{ text: 'click "Open"', ok: !blocked, note: blocked ? 'Could not see "Open" on screen' : undefined }], expect: ['It is open.'], status: blocked ? 'blocked' : 'done', error: blocked ? 'Could not see "Open" on screen' : undefined, screenshot: 'step-01.png', png: PNG, url: 'http://localhost:3000/x' },
  ]
  const run = {
    dir, spec, runId, startedAt, today: '2026-10-08', base: 'http://localhost:3000', records, outcome: null, usage: null, recordedSpec: null,
    verdict: null, reviewError: null, reviewedAt: null, result: blocked ? 'blocked' : 'not_reviewed', timings: { browserMs: 1234, queuedMs: null, reviewMs: null },
  }
  writeRun(run)
  return run
}

const PASSING = { steps: [{ n: 0, verdict: 'pass' }, { n: 1, verdict: 'pass' }], criteria: [{ text: 'It worked.', verdict: 'pass' }], failure_signals: [{ text: 'x', seen: false }], other_issues: [], summary: 'Fine.' }

test('result.json carries what a review needs, and loads back with the screenshots', () => {
  const config = project()
  const written = fakeRun(config)
  const json = JSON.parse(readFileSync(join(written.dir, 'result.json'), 'utf8'))
  assert.equal(json.affidavit, RESULT_FORMAT)
  assert.deepEqual(json.successCriteria, ['It worked.'])
  assert.deepEqual(json.timings, { browserMs: 1234, queuedMs: null, reviewMs: null })
  assert.equal(json.result, 'not_reviewed')
  assert.equal(json.steps[0].png, undefined, 'screenshots stay as files')
  const run = loadRun(written.dir, config)
  assert.equal(run.spec.title, 'Demo demo')
  assert.deepEqual(run.spec.failureSignals, ['Something went wrong'])
  assert.deepEqual(run.spec.viewportSize, { width: 390, height: 844, name: 'phone' })
  assert.ok(Buffer.isBuffer(run.records[1].png) && run.records[1].png.equals(PNG))
  assert.equal(run.timings.browserMs, 1234)
  assert.equal(run.today, '2026-10-08')
  assert.throws(() => loadRun(join(config.runsDir, 'nope'), config), /not a run folder/)
})

test('a run captured before format 2 is reviewed against the spec file as it is today', () => {
  const config = project()
  mkdirSync(config.specsDir, { recursive: true })
  writeFileSync(join(config.specsDir, 'demo.qa.md'), SPEC)
  const dir = join(config.runsDir, '20261001-100000-demo')
  mkdirSync(dir)
  writeFileSync(join(dir, 'result.json'), JSON.stringify({
    affidavit: 1, spec: 'qa/specs/demo.qa.md', id: 'demo', title: 'Demo flow', goal: 'Do the thing.', mode: 'scripted', role: 'admin',
    viewport: { width: 390, height: 844, name: 'phone' }, startedAt: '2026-10-01T10:00:00.000Z', base: 'http://localhost:3000', runId: 'xyz23',
    result: 'not_reviewed', outcome: null, steps: [], verdict: null,
  }))
  const run = loadRun(dir, config)
  assert.deepEqual(run.spec.successCriteria, ['It worked.'])
  assert.equal(run.spec.signedIn, true)
  rmSync(join(config.specsDir, 'demo.qa.md'))
  assert.throws(() => loadRun(dir, config), /older Affidavit[\s\S]*is gone/)
})

test('reviewRun: a rate limit is retried, then recorded as not_reviewed with the reason — never fail', async () => {
  const config = project()
  const log = []
  const sleep = () => Promise.resolve()
  // Limited twice, then answers.
  let calls = 0
  const run = fakeRun(config)
  await reviewRun(run, config, { log: m => log.push(m), sleep, delays: [1, 1, 1], reviewer: async () => { if (++calls < 3) throw new Error('OpenRouter 429: rate limit'); return PASSING } })
  assert.equal(run.result, 'pass')
  assert.equal(run.reviewError, null)
  assert.equal(calls, 3)
  assert.equal(log.filter(l => l.includes('retrying')).length, 2)
  assert.equal(typeof run.timings.reviewMs, 'number')
  let json = JSON.parse(readFileSync(join(run.dir, 'result.json'), 'utf8'))
  assert.equal(json.result, 'pass')
  assert.equal(json.verdict.summary, 'Fine.')
  assert.ok(json.reviewedAt)

  // Limited every time.
  const stuck = fakeRun(config, { runId: 'cd3ef', when: '2026-10-08T11:00:00.000Z' })
  await reviewRun(stuck, config, { log: () => {}, sleep, delays: [1, 1], reviewer: async () => { throw new Error('claude CLI error: You have hit your usage limit') } })
  assert.equal(stuck.result, 'not_reviewed')
  assert.match(stuck.reviewError, /usage limit/)
  json = JSON.parse(readFileSync(join(stuck.dir, 'result.json'), 'utf8'))
  assert.equal(json.result, 'not_reviewed')
  assert.match(json.reviewError, /usage limit/)
  assert.equal(json.verdict, null)
  assert.match(readFileSync(join(stuck.dir, 'report.html'), 'utf8'), /Not reviewed[\s\S]*review --unreviewed/)

  // A blocked run that cannot be reviewed stays blocked, not fail.
  const blocked = fakeRun(config, { id: 'other', runId: 'ef4gh', when: '2026-10-08T12:00:00.000Z', blocked: true })
  await reviewRun(blocked, config, { log: () => {}, sleep, delays: [], reviewer: async () => { throw new Error('429') } })
  assert.equal(blocked.result, 'blocked')
})

test('selectRuns: named folders, every spec\'s latest run, or the unreviewed ones; .sessions is ignored', async () => {
  const config = project()
  const a1 = fakeRun(config, { id: 'a', when: '2026-10-08T10:00:00.000Z' })
  const a2 = fakeRun(config, { id: 'a', when: '2026-10-08T11:00:00.000Z' })
  const b1 = fakeRun(config, { id: 'b', when: '2026-10-08T10:30:00.000Z' })
  mkdirSync(join(config.runsDir, '.sessions'))
  writeFileSync(join(config.runsDir, '.sessions', 'admin-abc12345.json'), '{"cookies":[]}')
  await reviewRun(a2, config, { log: () => {}, reviewer: async () => PASSING })
  assert.equal(collectRuns(config).length, 3)
  assert.deepEqual(selectRuns(config, { latest: true }), [a2.dir, b1.dir].sort())
  assert.deepEqual(selectRuns(config, { unreviewed: true }), [a1.dir, b1.dir].sort())
  assert.deepEqual(selectRuns(config, { args: [basename(b1.dir)] }), [b1.dir])
  assert.deepEqual(selectRuns(config, { args: [b1.dir], unreviewed: true }), [a1.dir, b1.dir].sort(), 'no duplicates')
  assert.throws(() => resolveRunArg('nope', config), /No run "nope"/)
  assert.deepEqual(selectRuns(config), [])
})

test('reviewRuns reviews existing runs from disk with the given concurrency', async () => {
  const config = project()
  const runs = [1, 2, 3].map(n => fakeRun(config, { id: `s${n}`, when: `2026-10-08T1${n}:00:00.000Z` }))
  let active = 0
  let peak = 0
  const results = await reviewRuns(runs.map(r => r.dir), config, {
    reviewConcurrency: 2,
    reviewer: async () => { active++; peak = Math.max(peak, active); await tick(10); active--; return PASSING },
  }, () => {})
  assert.equal(peak, 2)
  assert.deepEqual(results.map(r => r.result), ['pass', 'pass', 'pass'])
  for (const r of runs) assert.equal(JSON.parse(readFileSync(join(r.dir, 'result.json'), 'utf8')).result, 'pass')
})

test('runMany pipelines: the next capture starts while the last review runs, and the summary keeps spec order', async () => {
  const config = project()
  const events = []
  let n = 0
  const capture = async file => {
    events.push(`capture ${basename(file)}`)
    await tick(5)
    return fakeRun(config, { id: basename(file, '.qa.md'), when: `2026-10-08T1${n++}:00:00.000Z` })
  }
  let active = 0
  let peak = 0
  const reviewer = async ({ spec }) => {
    events.push(`review ${spec.id}`)
    active++
    peak = Math.max(peak, active)
    await tick(30)
    active--
    events.push(`done ${spec.id}`)
    if (spec.id === 'b') throw new Error('429 rate limit')
    return PASSING
  }
  const files = ['a.qa.md', 'b.qa.md', 'c.qa.md']
  const log = []
  const results = await runMany(files, config, { base: 'http://localhost:3000', review: true, capture, reviewer, delays: [], reviewConcurrency: 1 }, m => log.push(m))
  assert.deepEqual(results.map(r => [r.file, r.result]), [['a.qa.md', 'pass'], ['b.qa.md', 'not_reviewed'], ['c.qa.md', 'pass']])
  // Captures take 5ms and reviews 30ms: with a pipeline, c is captured before a's review is done.
  assert.ok(events.indexOf('capture c.qa.md') < events.indexOf('done a'), `captures waited for reviews: ${events.join(', ')}`)
  assert.deepEqual(events.filter(e => e.startsWith('review')), ['review a', 'review b', 'review c'], 'reviews run in capture order')
  assert.equal(peak, 1, 'the concurrency limit holds')
  const summary = log.join('\n')
  assert.match(summary, /Summary\n {2}pass {9}a\.qa\.md\n {2}not_reviewed b\.qa\.md {2}\(not reviewed: 429 rate limit\)\n {2}pass {9}c\.qa\.md/)
  assert.match(summary, /1 run was not reviewed[\s\S]*npx affidavit review --unreviewed/)

  // --no-review: screenshots only, and the hint to review later.
  const log2 = []
  const r2 = await runMany(['d.qa.md'], config, { base: 'http://localhost:3000', review: false, capture }, m => log2.push(m))
  assert.equal(r2[0].result, 'not_reviewed')
  assert.match(log2.join('\n'), /Screenshots only[\s\S]*review --unreviewed/)
})

test('a saved session is kept per role and account under the runs folder', () => {
  const config = project()
  const admin = sessionPath(config, 'admin', { email: 'admin@test' })
  assert.equal(join(config.runsDir, '.sessions'), join(admin, '..'))
  assert.match(basename(admin), /^admin-[0-9a-f]{8}\.json$/)
  assert.notEqual(admin, sessionPath(config, 'admin', { email: 'other@test' }), 'a changed test account never reuses the old session')
  assert.equal(sessionPath(config, 'Team Lead', { email: 'x' }).includes('team-lead-'), true)
  assert.deepEqual(sessionFor(config, 'admin', { email: 'admin@test' }), { path: admin, saved: false })
  mkdirSync(join(admin, '..'), { recursive: true })
  writeFileSync(admin, '{}')
  assert.equal(sessionFor(config, 'admin', { email: 'admin@test' }).saved, true)
  assert.equal(DEFAULTS.reuseSession, true)
})

test('the sign-in screen is recognised by its text, so an expired session is noticed', async () => {
  const fakePage = visible => ({
    getByText: t => ({ filter: () => ({ count: async () => (visible.includes(t) ? 1 : 0) }) }),
    getByLabel: () => ({ filter: () => ({ count: async () => 0 }) }),
    getByPlaceholder: () => ({ filter: () => ({ count: async () => 0 }) }),
  })
  assert.equal(await loginFormVisible(fakePage(['Email', 'Password']), DEFAULTS.auth, 10), true)
  assert.equal(await loginFormVisible(fakePage(['Dashboard']), DEFAULTS.auth, 10), false)
  assert.equal(await loginFormVisible(fakePage(['Email']), { type: 'none' }, 10), false)
})
