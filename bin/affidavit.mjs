#!/usr/bin/env node
// Affidavit — visual-only QA. See README.md.

import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRoot, loadConfig } from '../src/config.mjs'
import { assertLocalBase, loadEnv } from '../src/env.mjs'
import { doctor, init } from '../src/init.mjs'
import { writeLedger } from '../src/ledger.mjs'
import { allSpecs, loadSpec, resolveSpecArg, runMany } from '../src/run.mjs'

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'))

const HELP = `affidavit ${PKG.version} — visual-only QA

Usage
  affidavit init [--preset next|vite|none]   set up this project
  affidavit doctor                           check the browser, reviewer, roles and server
  affidavit check [spec…]                    parse specs without running them
  affidavit run <spec…> | --all [options]    run specs (a path or an id)
  affidavit ledger [options]                 one page: every spec, latest result, history

Run options
  --all             every spec in the specs folder (files starting with "_" are skipped)
  --no-review       screenshots only, no model call
  --headed          show the browser
  --base <url>      override baseUrl
  --max-turns <n>   explore mode turn limit

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
    if (['all', 'no-review', 'headed', 'links', 'help'].includes(key)) flags[key] = true
    else if (['base', 'max-turns', 'out', 'title', 'notes', 'preset'].includes(key)) flags[key] = argv[++i]
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
      const { done, warn } = init(process.cwd(), { preset: flags.preset })
      for (const d of done) console.log(`  ✓ ${d}`)
      if (!done.length) console.log('  Already set up; nothing changed.')
      for (const w of warn) console.log(`  ! ${w}`)
      console.log('\nNext: fill in .env.qa.local, set "auth" in affidavit.config.json, then run "npx affidavit doctor".')
      return 0
    }
    case 'doctor': {
      let config = null
      try { config = project() } catch { /* reported by doctor */ }
      const checks = await doctor(config)
      for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(9)} ${c.detail}`)
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
      for (const file of files) {
        try {
          const spec = loadSpec(file, config)
          console.log(`  ✓ ${relative(config.root, file)}  [${spec.mode}, ${spec.role}, ${spec.viewportSize.name}, ${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"}]`)
        } catch (err) {
          bad++
          console.log(`  ✗ ${err.message}`)
        }
      }
      console.log(`\n${files.length - bad}/${files.length} specs are valid.`)
      return bad ? 1 : 0
    }
    case 'run': {
      const config = project()
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
      })
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
