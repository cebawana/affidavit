// Getting a person to the results without a file browser: the ledger is
// refreshed after every run and review at one fixed path, the terminal shows
// file:// links to it and to the reports worth reading, and `open` launches
// either in the browser.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeLedger } from './ledger.mjs'
import { collectRuns, resolveRunArg } from './run.mjs'

export const ledgerPath = config => join(config.runsDir, 'ledger.html')

/** A link most terminals open on Cmd/Ctrl-click. */
export const fileLink = path => pathToFileURL(path).href

/**
 * Rewrites <runs>/ledger.html with linked screenshots: no Chrome needed, so
 * it is quick enough to run after every command. Returns the path, or null
 * when it could not be written: a stale page must never fail a run.
 */
export async function refreshLedger(config, title, warn = console.error) {
  try {
    const { outFile } = await writeLedger(config, { title, links: true })
    return outFile
  } catch (err) {
    warn(`! The ledger was not refreshed: ${String(err.message ?? err).split('\n')[0]}`)
    return null
  }
}

/**
 * Where to look after a run: the ledger, and the report of every run that did
 * not pass. Passing runs are left out so a large suite stays a short list.
 */
export function resultLinks(ledger, results) {
  const lines = []
  if (ledger) lines.push(`\nResults  ${fileLink(ledger)}`)
  const worth = results.filter(r => r?.report && r.result !== 'pass')
  for (const r of worth) lines.push(`  ${r.result.padEnd(12)} ${r.id ?? r.file}  ${fileLink(r.report)}`)
  return lines.join('\n')
}

/**
 * The page `affidavit open <arg>` shows: a spec id's latest report, or a run
 * folder's report. Without an argument, the ledger.
 */
export function pageFor(config, arg) {
  if (!arg) return ledgerPath(config)
  const runs = collectRuns(config).filter(r => r.id === arg)
  if (runs.length) return join(runs.at(-1).dir, 'report.html')
  try {
    return join(resolveRunArg(arg, config), 'report.html')
  } catch {
    throw new Error(`No runs of "${arg}". Name a spec id or a run folder, or leave it out to open the ledger.`)
  }
}

/** Opens a file in the default browser. Best effort: failures are reported, never thrown. */
export function openInBrowser(path, warn = console.error) {
  if (!existsSync(path)) { warn(`! Nothing to open: ${path} does not exist`); return false }
  const [cmd, args] = process.platform === 'darwin' ? ['open', [path]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', path]]
    : ['xdg-open', [path]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', err => warn(`! Could not open ${path}: ${err.message}`))
    child.unref()
    return true
  } catch (err) {
    warn(`! Could not open ${path}: ${err.message}`)
    return false
  }
}
