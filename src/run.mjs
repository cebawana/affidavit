// Runs specs end to end: parse → drive the browser → review → write the report.
//
// Capture and review are pipelined. The browser captures one spec at a time
// and hands each finished run to a review queue, then moves straight on to
// the next spec; reviews run from the queue, several at once, while capture
// continues. Reviews only read screenshots that already exist, so they can
// never change what the browser does — a pipelined run captures exactly what
// a sequential one would.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { resolveViewport } from './config.mjs'
import { credentialsFor } from './env.mjs'
import { bindVariables, parseSpec, toSpecMarkdown } from './spec.mjs'
import { openBrowser } from './browser.mjs'
import { runExplore, runScripted } from './executor.mjs'
import { overall, review } from './reviewer.mjs'
import { renderReport } from './report.mjs'
import { concurrencyFor } from './backends/index.mjs'
import { createQueue, isRateLimit, withRetry } from './queue.mjs'
import { sessionFor } from './session.mjs'

const stamp = d => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
// No 0/o, 1/l/i: the reviewer reads this id off a screenshot.
const newRunId = () => Array.from({ length: 5 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('')
const localDate = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const seconds = ms => `${(ms / 1000).toFixed(1)}s`

/** The format of result.json. 2 carries everything a review needs, so a run can be reviewed again from disk. */
export const RESULT_FORMAT = 2

// Waits between retries when the reviewer backend is rate limited.
export const RETRY_DELAYS = [15_000, 30_000, 60_000]

/**
 * Every spec file in the specs folder. Files starting with "_" are templates:
 * skipped by `run --all` and the ledger, but still validated by `check`.
 */
export function allSpecs(config, { templates = false } = {}) {
  if (!existsSync(config.specsDir)) return []
  return readdirSync(config.specsDir)
    .filter(f => f.endsWith('.qa.md') && (templates || !f.startsWith('_')))
    .sort()
    .map(f => join(config.specsDir, f))
}

/** A path, or a bare id ("finance-phone") looked up in the specs folder. */
export function resolveSpecArg(arg, config) {
  const asPath = resolve(arg)
  if (existsSync(asPath)) return asPath
  const byId = join(config.specsDir, arg.endsWith('.qa.md') ? arg : `${arg}.qa.md`)
  if (existsSync(byId)) return byId
  throw new Error(`No spec "${arg}" (looked for ${relative(config.root, asPath)} and ${relative(config.root, byId)})`)
}

export function loadSpec(file, config) {
  const spec = parseSpec(readFileSync(file, 'utf8'), relative(config.root, file), { leakTerms: config.leakTerms, defaultRole: config.defaultRole })
  spec.viewportSize = resolveViewport(spec.viewport, config)
  return spec
}

/**
 * Drives the browser through one spec and writes the run to disk, unreviewed.
 * Returns the run for the review queue. Writing before any review means a
 * crash, a timeout or a rate limit never loses the screenshots: `affidavit
 * review --unreviewed` finishes the run later.
 */
export async function captureSpec(file, config, opts, log = console.log) {
  const startedAt = new Date()
  const runId = newRunId()
  const today = localDate(startedAt)
  const spec = bindVariables(loadSpec(file, config), { run: runId, today })
  // Before the run folder exists: a missing sign-in must not leave an empty
  // run behind, and it is the first thing a new user gets wrong.
  const creds = credentialsFor(spec.role, config.envPrefix, config.auth)
  // Without credentials the role is only a label: the reviewer and the report
  // must not claim anyone signed in.
  spec.signedIn = Boolean(creds)
  const session = creds && config.reuseSession && !opts.freshSignIn ? sessionFor(config, spec.role, creds) : null
  const dir = join(config.runsDir, `${stamp(startedAt)}-${spec.id}`)
  mkdirSync(dir, { recursive: true })
  log(`\n▶ ${spec.title}  [${spec.mode}, as ${spec.role}, ${spec.viewportSize.name}]  run ${runId}`)
  const ctx = { base: opts.base, timeouts: config.timeouts, notFoundText: config.notFoundText, auth: config.auth }
  const t0 = Date.now()
  const { browser, page } = await openBrowser({
    viewport: spec.viewportSize, headed: opts.headed, locale: config.locale, channel: config.browser.channel, hide: config.hide,
    storageState: session?.saved ? session.path : undefined,
  })
  let records
  let outcome = null
  let usage = null
  try {
    if (spec.mode === 'scripted') {
      records = await runScripted({ page, ctx, dir, spec, creds, session, log })
    } else {
      ({ records, outcome, usage } = await runExplore({ page, ctx, dir, spec, creds, session, log, backend: config.backend, maxTurns: opts.maxTurns ?? config.maxTurns }))
    }
  } finally {
    await browser.close()
  }
  const browserMs = Date.now() - t0

  // An exploration that found its way becomes a scripted spec to keep. One
  // that got lost is not a path worth replaying.
  let recordedSpec = null
  if (spec.mode === 'explore' && outcome?.done) {
    const steps = records.filter(r => r.n > 0 && r.status === 'done')
    recordedSpec = toSpecMarkdown(spec, steps).split(runId).join('{run}')
    writeFileSync(join(dir, 'recorded.qa.md'), recordedSpec)
  }

  const run = {
    dir, spec, runId, startedAt, today, base: opts.base, records, outcome, usage, recordedSpec,
    verdict: null, reviewError: null, reviewedAt: null,
    timings: { browserMs, queuedMs: null, reviewMs: null },
  }
  run.result = overall(records, null, outcome)
  writeRun(run)
  return run
}

/**
 * Reviews a run and rewrites its report and result.json. A rate limit is the
 * backend asking us to wait, not a verdict: it is retried with growing waits
 * and, if it persists, recorded as not_reviewed with the reason. Never fail.
 *
 * @param {{ log?, reviewer?, delays?, sleep? }} [opts] reviewer/delays/sleep are for tests
 */
export async function reviewRun(run, config, opts = {}) {
  const log = opts.log ?? console.log
  const reviewer = opts.reviewer ?? review
  const delays = opts.delays ?? RETRY_DELAYS
  const { spec, records, outcome, today } = run
  const t0 = Date.now()
  try {
    run.verdict = await withRetry(() => reviewer({ spec, records, outcome, today, backend: config.backend }), {
      retryable: isRateLimit, delays, sleep: opts.sleep,
      onRetry: (err, wait, n, of) => log(`  ⏳ ${spec.id}: the reviewer is rate limited (${String(err.message).split('\n')[0]}); retrying in ${seconds(wait)} (${n}/${of})`),
    })
    run.reviewError = null
  } catch (err) {
    run.verdict = null
    run.reviewError = String(err.message ?? err).split('\n')[0]
  }
  run.reviewedAt = new Date()
  run.timings.reviewMs = Date.now() - t0
  run.result = overall(records, run.verdict, outcome)
  writeRun(run)
  const took = [run.timings.browserMs != null && `browser ${seconds(run.timings.browserMs)}`, `review ${seconds(run.timings.reviewMs)}`].filter(Boolean).join(' · ')
  log(`  ${run.result.toUpperCase().padEnd(12)} ${spec.id} → ${relative(config.root, join(run.dir, 'report.html'))}  [${took}]${run.reviewError ? `\n    ! not reviewed: ${run.reviewError}` : ''}`)
  return run
}

/** The report and result.json for a run, in its folder. */
export function writeRun(run) {
  const { spec, records } = run
  const notes = [...new Set(records.flatMap(r => r.actions.filter(a => a.ok && a.note).map(a => `${a.text} — ${a.note}`)))]
  writeFileSync(join(run.dir, 'report.html'), renderReport({
    spec, runId: run.runId, startedAt: run.startedAt.toLocaleString(), base: run.base, records,
    verdict: run.verdict, result: run.result, outcome: run.outcome, usage: run.usage, notes, recordedSpec: run.recordedSpec,
    reviewError: run.reviewError, timings: run.timings,
  }))
  writeFileSync(join(run.dir, 'result.json'), JSON.stringify({
    affidavit: RESULT_FORMAT,
    spec: spec.file, id: spec.id, title: spec.title, goal: spec.goal, mode: spec.mode, role: spec.role, signedIn: spec.signedIn,
    viewport: spec.viewportSize, startedAt: run.startedAt.toISOString(), today: run.today, base: run.base, runId: run.runId,
    // What the reviewer compares the screenshots with, kept with the run so it
    // can be reviewed again later even after the spec file changes.
    preconditions: spec.preconditions, successCriteria: spec.successCriteria, failureSignals: spec.failureSignals, outOfScope: spec.outOfScope,
    result: run.result, outcome: run.outcome, usage: run.usage,
    steps: records.map(({ png, ...r }) => r),
    verdict: run.verdict, reviewError: run.reviewError, reviewedAt: run.reviewedAt ? run.reviewedAt.toISOString() : null,
    timings: run.timings,
  }, null, 2))
}

/**
 * A run read back from its folder, with the screenshots, so it can be
 * reviewed again without the browser. Runs captured before format 2 did not
 * save the spec's criteria; those come from the spec file as it is today.
 */
export function loadRun(dir, config) {
  const file = join(dir, 'result.json')
  const name = relative(config.root, dir) || dir
  if (!existsSync(file)) throw new Error(`${name} is not a run folder (no result.json)`)
  let json
  try { json = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { throw new Error(`${name}/result.json: ${err.message}`) }
  const startedAt = new Date(json.startedAt)
  const today = json.today ?? localDate(startedAt)
  let criteria = json
  if (!(json.affidavit >= 2)) {
    const specFile = resolve(config.root, json.spec)
    if (!existsSync(specFile)) throw new Error(`cannot review ${name}: it was captured by an older Affidavit and its spec ${json.spec} is gone`)
    criteria = bindVariables(loadSpec(specFile, config), { run: json.runId, today })
  }
  const spec = {
    file: json.spec, id: json.id, title: json.title, goal: json.goal ?? '', mode: json.mode, role: json.role,
    signedIn: json.signedIn ?? (json.role !== 'none'), viewportSize: json.viewport, start: criteria.start,
    preconditions: criteria.preconditions ?? [], successCriteria: criteria.successCriteria ?? [],
    failureSignals: criteria.failureSignals ?? [], outOfScope: criteria.outOfScope ?? [],
  }
  const records = (json.steps ?? []).map(r => {
    const shot = r.screenshot ? join(dir, r.screenshot) : null
    return { ...r, actions: r.actions ?? [], expect: r.expect ?? [], png: shot && existsSync(shot) ? readFileSync(shot) : undefined }
  })
  const recorded = join(dir, 'recorded.qa.md')
  return {
    dir, spec, runId: json.runId, startedAt, today, base: json.base, records, outcome: json.outcome ?? null, usage: json.usage ?? null,
    recordedSpec: existsSync(recorded) ? readFileSync(recorded, 'utf8') : null,
    verdict: json.verdict ?? null, reviewError: json.reviewError ?? null, reviewedAt: json.reviewedAt ? new Date(json.reviewedAt) : null,
    result: json.result, timings: { browserMs: json.timings?.browserMs ?? null, queuedMs: null, reviewMs: null },
  }
}

/** "20260928-091438-finance-phone" → Date (the folder stamp is UTC). */
function stampDate(name) {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/)
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null
}

/** Every run's result.json in the runs folder, oldest first. Folders without one (.sessions) are skipped. */
export function collectRuns(config) {
  if (!existsSync(config.runsDir)) return []
  const runs = []
  for (const name of readdirSync(config.runsDir)) {
    const dir = join(config.runsDir, name)
    const file = join(dir, 'result.json')
    if (!existsSync(file)) continue
    let json
    try { json = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    const startedAt = json.startedAt ? new Date(json.startedAt) : stampDate(name) ?? statSync(file).mtime
    runs.push({ ...json, dir, startedAt })
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt)
}

/** A run folder by path, or by name inside the runs folder. */
export function resolveRunArg(arg, config) {
  const asPath = resolve(arg)
  if (existsSync(join(asPath, 'result.json'))) return asPath
  const byName = join(config.runsDir, arg)
  if (existsSync(join(byName, 'result.json'))) return byName
  throw new Error(`No run "${arg}" (looked for ${relative(config.root, asPath)} and ${relative(config.root, byName)}; a run folder holds a result.json)`)
}

/**
 * Which runs `affidavit review` works on: the folders named, every spec's
 * latest run (--latest), and runs without a verdict (--unreviewed: captured
 * with --no-review, or left behind by a failed review).
 */
export function selectRuns(config, { latest = false, unreviewed = false, args = [] } = {}) {
  const dirs = args.map(a => resolveRunArg(a, config))
  if (latest || unreviewed) {
    const runs = collectRuns(config)
    if (unreviewed) dirs.push(...runs.filter(r => r.verdict == null).map(r => r.dir))
    if (latest) {
      const byId = new Map()
      for (const r of runs) byId.set(r.id, r.dir)
      dirs.push(...byId.values())
    }
  }
  return [...new Set(dirs)].sort()
}

const summarize = run => ({ file: basename(run.spec.file), id: run.spec.id, run: basename(run.dir), result: run.result, report: join(run.dir, 'report.html'), reviewError: run.reviewError })

function printSummary(results, log, { reviewed = true, showRun = false } = {}) {
  if (results.length > 1) {
    log('\nSummary')
    for (const r of results) log(`  ${r.result.padEnd(12)} ${r.file}${showRun && r.run ? `  ${r.run}` : ''}${r.reviewError ? `  (not reviewed: ${r.reviewError})` : ''}`)
  }
  const left = results.filter(r => r.result === 'not_reviewed')
  if (!left.length) return
  if (!reviewed) log(`\nScreenshots only. Review ${left.length === 1 ? 'this run' : 'these runs'} later with:\n  npx affidavit review --unreviewed`)
  else log(`\n${left.length} run${left.length === 1 ? ' was' : 's were'} not reviewed. Finish ${left.length === 1 ? 'it' : 'them'} with:\n  npx affidavit review --unreviewed`)
}

/**
 * Runs specs in order with one browser; reviews run from a queue alongside.
 * One line per finished capture, one per finished review, then the summary in
 * spec order.
 *
 * @param {{ base, review, headed, maxTurns?, freshSignIn?, reviewConcurrency?, capture?, reviewer?, delays?, sleep? }} opts
 *   capture/reviewer/delays/sleep are for tests.
 */
export async function runMany(files, config, opts, log = console.log) {
  const capture = opts.capture ?? captureSpec
  const queue = createQueue(opts.reviewConcurrency ?? concurrencyFor(config.backend))
  const results = new Array(files.length)
  const reviews = []
  for (const [i, file] of files.entries()) {
    let run
    try {
      run = await capture(file, config, opts, log)
    } catch (err) {
      console.error(`\n✗ ${relative(config.root, file)}\n${err.message}`)
      results[i] = { file: basename(file), result: 'error' }
      continue
    }
    if (!opts.review) {
      results[i] = summarize(run)
      log(`  ${run.result.toUpperCase().padEnd(12)} ${run.spec.id} → ${relative(config.root, join(run.dir, 'report.html'))}  [browser ${seconds(run.timings.browserMs)}]`)
      continue
    }
    const queuedAt = Date.now()
    log(`  captured in ${seconds(run.timings.browserMs)} → review queued${queue.waiting ? ` (${queue.waiting} ahead)` : ''}`)
    reviews.push(queue.add(async () => {
      run.timings.queuedMs = Date.now() - queuedAt
      await reviewRun(run, config, { log, reviewer: opts.reviewer, delays: opts.delays, sleep: opts.sleep })
      results[i] = summarize(run)
    }))
  }
  if (reviews.length && queue.active + queue.waiting) log(`\n… ${queue.active + queue.waiting} review${queue.active + queue.waiting === 1 ? '' : 's'} still running`)
  await Promise.all(reviews)
  printSummary(results, log, { reviewed: opts.review })
  return results
}

/**
 * Reviews runs that already exist, without the browser: after a failed
 * review, with another backend or model, or a suite captured with --no-review.
 * Screenshots are untouched; report.html and result.json are rewritten.
 */
export async function reviewRuns(dirs, config, opts = {}, log = console.log) {
  const queue = createQueue(opts.reviewConcurrency ?? concurrencyFor(config.backend))
  const t0 = Date.now()
  const results = await Promise.all(dirs.map(dir => queue.add(async () => {
    let run
    try {
      run = loadRun(dir, config)
    } catch (err) {
      console.error(`\n✗ ${err.message}`)
      return { file: basename(dir), result: 'error' }
    }
    run.timings.queuedMs = Date.now() - t0
    log(`\n▶ ${run.spec.title}  run ${run.runId}  (${relative(config.root, dir)}${run.verdict ? ', reviewed before' : ''})`)
    await reviewRun(run, config, { log, reviewer: opts.reviewer, delays: opts.delays, sleep: opts.sleep })
    return summarize(run)
  })))
  printSummary(results, log, { showRun: true })
  return results
}
