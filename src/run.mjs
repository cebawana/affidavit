// Runs specs end to end: parse → drive the browser → review → write the report.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { resolveViewport } from './config.mjs'
import { credentialsFor } from './env.mjs'
import { bindVariables, parseSpec, toSpecMarkdown } from './spec.mjs'
import { openBrowser } from './browser.mjs'
import { runExplore, runScripted } from './executor.mjs'
import { overall, review } from './reviewer.mjs'
import { renderReport } from './report.mjs'

const stamp = d => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
// No 0/o, 1/l/i: the reviewer reads this id off a screenshot.
const newRunId = () => Array.from({ length: 5 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('')

/** Every spec file in the specs folder. Files starting with "_" are templates and are skipped. */
export function allSpecs(config) {
  if (!existsSync(config.specsDir)) return []
  return readdirSync(config.specsDir)
    .filter(f => f.endsWith('.qa.md') && !f.startsWith('_'))
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
  const spec = parseSpec(readFileSync(file, 'utf8'), relative(config.root, file), { leakTerms: config.leakTerms })
  spec.viewportSize = resolveViewport(spec.viewport, config)
  return spec
}

export async function runSpec(file, config, opts, log = console.log) {
  const startedAt = new Date()
  const runId = newRunId()
  const today = new Date(startedAt.getTime() - startedAt.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const spec = bindVariables(loadSpec(file, config), { run: runId, today })
  const dir = join(config.runsDir, `${stamp(startedAt)}-${spec.id}`)
  mkdirSync(dir, { recursive: true })
  log(`\n▶ ${spec.title}  [${spec.mode}, as ${spec.role}, ${spec.viewportSize.name}]  run ${runId}`)

  const creds = credentialsFor(spec.role, config.envPrefix)
  const ctx = { base: opts.base, timeouts: config.timeouts, notFoundText: config.notFoundText, auth: config.auth }
  const { browser, page } = await openBrowser({
    viewport: spec.viewportSize, headed: opts.headed, locale: config.locale, channel: config.browser.channel, hide: config.hide,
  })
  let records
  let outcome = null
  let usage = null
  try {
    if (spec.mode === 'scripted') {
      records = await runScripted({ page, ctx, dir, spec, creds, log })
    } else {
      ({ records, outcome, usage } = await runExplore({ page, ctx, dir, spec, creds, log, backend: config.backend, maxTurns: opts.maxTurns ?? config.maxTurns }))
    }
  } finally {
    await browser.close()
  }

  // An exploration that found its way becomes a scripted spec to keep. One
  // that got lost is not a path worth replaying.
  let recordedSpec = null
  if (spec.mode === 'explore' && outcome?.done) {
    const steps = records.filter(r => r.n > 0 && r.status === 'done')
    recordedSpec = toSpecMarkdown(spec, steps).split(runId).join('{run}')
    writeFileSync(join(dir, 'recorded.qa.md'), recordedSpec)
  }

  let verdict = null
  if (opts.review) {
    log('  … reviewing screenshots')
    try {
      verdict = await review({ spec, records, outcome, today, backend: config.backend })
    } catch (err) {
      log(`  ! review failed: ${err.message}`)
    }
  }
  const result = overall(records, verdict, outcome)

  const notes = [...new Set(records.flatMap(r => r.actions.filter(a => a.ok && a.note).map(a => `${a.text} — ${a.note}`)))]
  writeFileSync(join(dir, 'report.html'), renderReport({
    spec, runId, startedAt: startedAt.toLocaleString(), base: opts.base, records, verdict, result, outcome, usage, notes, recordedSpec,
  }))
  writeFileSync(join(dir, 'result.json'), JSON.stringify({
    affidavit: 1,
    spec: spec.file, id: spec.id, title: spec.title, goal: spec.goal, mode: spec.mode, role: spec.role,
    viewport: spec.viewportSize, startedAt: startedAt.toISOString(), base: opts.base, runId, result, outcome,
    steps: records.map(({ png, ...r }) => r), verdict,
  }, null, 2))

  log(`  ${result.toUpperCase()} → ${relative(config.root, join(dir, 'report.html'))}`)
  return { file: basename(file), id: spec.id, result, report: join(dir, 'report.html') }
}

export async function runMany(files, config, opts) {
  const results = []
  for (const file of files) {
    try {
      results.push(await runSpec(file, config, opts))
    } catch (err) {
      console.error(`\n✗ ${relative(config.root, file)}\n${err.message}`)
      results.push({ file: basename(file), result: 'error' })
    }
  }
  if (results.length > 1) {
    console.log('\nSummary')
    for (const r of results) console.log(`  ${r.result.padEnd(12)} ${r.file}`)
  }
  return results
}
