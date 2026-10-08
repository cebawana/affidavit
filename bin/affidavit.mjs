#!/usr/bin/env node
// Affidavit — visual-only QA. See README.md.

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, findRoot, loadConfig } from '../src/config.mjs'
import { assertLocalBase, loadEnv } from '../src/env.mjs'
import { doctor, init } from '../src/init.mjs'
import { writeLedger } from '../src/ledger.mjs'
import { allSpecs, loadSpec, resolveSpecArg, reviewRuns, runMany, selectRuns } from '../src/run.mjs'
import { ACTION_VOCABULARY } from '../src/spec.mjs'

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'))

const HELP = `affidavit ${PKG.version} — visual-only QA

Usage
  affidavit init [options]                   set up this project
  affidavit doctor                           check the browser, reviewer, roles and server
  affidavit check [spec…]                    parse specs without running them
  affidavit run <spec…> | --all [options]    run specs (a path or an id)
  affidavit review <run…> | --latest | --unreviewed
                                             review runs that exist, without the browser
  affidavit ledger [options]                 one page: every spec, latest result, history

Init options
  --no-auth         the app has no sign-in (otherwise init asks, or sets up a login form)
  --preset <name>   next · vite · none (detected from package.json by default)
  --base-url <url>  where the app runs (default: the preset's dev-server port)

Run options
  --all             every spec in the specs folder (files starting with "_" are skipped)
  --no-review       screenshots only, no model call
  --headed          show the browser
  --base <url>      override baseUrl
  --max-turns <n>   explore mode turn limit
  --review-concurrency <n>
                    reviews running at once while the browser captures the next spec
                    (default: backend.concurrency in the config, or the backend's own)
  --fresh-sign-in   ignore saved sessions and sign in from scratch for this run

Review options
  <run…>            run folders (a path, or a name inside the runs folder)
  --latest          every spec's latest run
  --unreviewed      runs without a verdict: captured with --no-review, or left by a failed review
  --review-concurrency <n>

Ledger options
  --out <file>      default: <runs>/ledger.html
  --title <text>    default: "<project> QA ledger"
  --notes <file.md> add your own panels ("## What changed", "## Still open"…)
  --links           link screenshots instead of embedding them (smaller, local only)
`

function parseFlags(argv) {
  const flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { flags._.push(a); continue }
    const key = a.slice(2)
    if (['all', 'no-review', 'headed', 'links', 'help', 'no-auth', 'latest', 'unreviewed', 'fresh-sign-in'].includes(key)) flags[key] = true
    else if (['base', 'base-url', 'max-turns', 'out', 'title', 'notes', 'preset', 'review-concurrency'].includes(key)) flags[key] = argv[++i]
    else throw new Error(`Unknown option ${a}`)
  }
  return flags
}

function project() {
  const root = findRoot()
  if (!root) throw new Error('No affidavit.config.json here or above. Run "npx affidavit init" in your project first.')
  // Read once to learn which env files to load, then again so their values
  // (QA_BASE_URL, QA_BACKEND…) can override the file.
  const first = loadConfig(root)
  loadEnv(root, first.envFiles, first.envPrefix)
  return loadConfig(root)
}

/**
 * `init` asks whether the app has a sign-in when nothing on the command line
 * says so and a person is at the terminal. Scripts and coding agents get no
 * question: they pass --no-auth, or get the sign-in setup.
 */
async function askAuth() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Does the app need a sign-in? [Y/n] ')
    return !/^n/i.test(answer.trim())
  } catch {
    return true // Ctrl+D: take the default
  } finally {
    rl.close()
  }
}

/** --review-concurrency: a whole number of 1 or more, or unset. */
function reviewConcurrency(flags) {
  if (flags['review-concurrency'] === undefined) return undefined
  const n = Number(flags['review-concurrency'])
  if (!Number.isInteger(n) || n < 1) throw new Error(`--review-concurrency needs a whole number of 1 or more, not "${flags['review-concurrency']}"`)
  return n
}

function projectName(root) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name || basename(root) } catch { return basename(root) }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(HELP); return 0 }
  if (command === '--version' || command === '-v') { console.log(PKG.version); return 0 }
  const flags = parseFlags(rest)

  switch (command) {
    case 'init': {
      // Only a project without a config has anything to decide.
      const fresh = !existsSync(join(process.cwd(), CONFIG_FILE))
      const auth = flags['no-auth'] ? false : fresh ? await askAuth() : true
      const { done, warn } = init(process.cwd(), { preset: flags.preset, auth, baseUrl: flags['base-url'] })
      for (const d of done) console.log(`  ✓ ${d}`)
      if (!done.length) console.log('  Already set up; nothing changed.')
      for (const w of warn) console.log(`  ! ${w}`)
      console.log(auth
        ? '\nNext: fill in .env.qa.local, set "auth" in affidavit.config.json, start the app, then run "npx affidavit doctor".'
        : '\nNext: start the app, then run "npx affidavit doctor".')
      return 0
    }
    case 'doctor': {
      let config = null
      try { config = project() } catch { /* reported by doctor */ }
      const checks = await doctor(config)
      for (const c of checks) console.log(`  ${c.warn ? '!' : c.ok ? '✓' : '✗'} ${c.name.padEnd(9)} ${c.detail}`)
      return checks.every(c => c.ok) ? 0 : 1
    }
    case 'check': {
      const config = project()
      const files = flags._.length ? flags._.map(a => resolveSpecArg(a, config)) : allSpecs(config, { templates: true })
      if (!files.length) {
        console.log(`No specs in ${relative(process.cwd(), config.specsDir) || '.'} yet. Run "npx affidavit init" for an example, or add a <name>.qa.md file.`)
        return 0
      }
      let bad = 0
      let unknownAction = false
      for (const file of files) {
        try {
          const spec = loadSpec(file, config)
          console.log(`  ✓ ${relative(config.root, file)}  [${spec.mode}, ${spec.role}, ${spec.viewportSize.name}, ${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"}]`)
          for (const w of spec.warnings) console.log(`    ! ${w}`)
        } catch (err) {
          bad++
          unknownAction ||= Boolean(err.unknownAction)
          console.log(`  ✗ ${err.message}`)
        }
      }
      // The vocabulary once per run, not once per unreadable line.
      if (unknownAction) console.log(`\nActions a spec can use:\n${ACTION_VOCABULARY.map(a => `  ${a}`).join('\n')}`)
      console.log(`\n${files.length - bad}/${files.length} specs are valid.`)
      return bad ? 1 : 0
    }
    case 'run': {
      const config = project()
      const concurrency = reviewConcurrency(flags)
      const files = flags.all ? allSpecs(config) : flags._.map(a => resolveSpecArg(a, config))
      if (!files.length) {
        throw new Error(flags.all
          ? `No specs to run in ${relative(process.cwd(), config.specsDir) || '.'}. Files starting with "_" are templates and are skipped: copy one to a new name to make it a spec.`
          : 'Name a spec (path or id), or pass --all')
      }
      const base = flags.base ?? config.baseUrl
      assertLocalBase(base, config.allowRemote)
      const results = await runMany(files, config, {
        base, review: !flags['no-review'], headed: Boolean(flags.headed),
        maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
        freshSignIn: Boolean(flags['fresh-sign-in']), reviewConcurrency: concurrency,
      })
      return results.every(r => r.result === 'pass') ? 0 : 1
    }
    case 'review': {
      const config = project()
      const concurrency = reviewConcurrency(flags)
      const dirs = selectRuns(config, { latest: Boolean(flags.latest), unreviewed: Boolean(flags.unreviewed), args: flags._ })
      if (!dirs.length) {
        if (flags.unreviewed) { console.log('Nothing to review: every run has a verdict.'); return 0 }
        if (flags.latest) { console.log(`No runs in ${relative(process.cwd(), config.runsDir) || '.'} yet. Run "npx affidavit run --all" first.`); return 0 }
        throw new Error('Name run folders, or pass --latest or --unreviewed')
      }
      const results = await reviewRuns(dirs, config, { reviewConcurrency: concurrency })
      return results.every(r => r.result === 'pass') ? 0 : 1
    }
    case 'ledger': {
      const config = project()
      const { outFile, bytes } = await writeLedger(config, {
        title: flags.title ?? `${projectName(config.root)} QA ledger`,
        notesFile: flags.notes, links: Boolean(flags.links), out: flags.out,
      })
      console.log(`Ledger → ${relative(process.cwd(), outFile)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
      return 0
    }
    default:
      throw new Error(`Unknown command "${command}". Run "affidavit help".`)
  }
}

main().then(code => process.exit(code), err => { console.error(err.message); process.exit(2) })
