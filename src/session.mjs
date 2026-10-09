// The signed-in browser session, saved per role after a sign-in and reused by
// the next spec of the same role. Signing in from scratch for every spec is
// the slowest part of a suite; a saved session skips it. Whether it still
// holds is decided in src/executor.mjs by looking, most reliable signal first,
// and when nothing confirms it the browser signs in again.
//
// Sessions are live sign-in cookies, so they stay out of the runs folder
// (which gets zipped, shared and uploaded): they live in .affidavit/sessions/
// under the project root and are written readable by the owner only. The
// folder gitignores itself (.affidavit/.gitignore holding "*", as pytest does
// for its cache), so a project that upgraded without running `init` again
// cannot commit them by accident; `init` adds the root line too and `doctor`
// checks. The file name carries a hash of the account, so a changed test
// account never picks up the old account's session.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const STATE_DIR = '.affidavit'

export const SESSIONS_DIR = `${STATE_DIR}/sessions`

export function sessionPath(config, role, creds) {
  const slug = String(role).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const account = createHash('sha1').update(String(creds.email)).digest('hex').slice(0, 8)
  return join(config.root, SESSIONS_DIR, `${slug}-${account}.json`)
}

/** Where this role's session is kept, and whether one is saved already. */
export function sessionFor(config, role, creds) {
  const path = sessionPath(config, role, creds)
  return { path, saved: existsSync(path), root: config.root }
}

/** Creates .affidavit/ (owner-only) with a .gitignore that ignores everything in it. */
export function ensureStateDir(root) {
  const dir = join(root, STATE_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ignore = join(dir, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '# Affidavit state (saved sign-in sessions): never committed.\n*\n')
  return dir
}

/** The project root a session path belongs to, when it sits in <root>/.affidavit/sessions/. */
function rootOf(session) {
  if (session.root) return session.root
  const dir = dirname(session.path)
  return basename(dir) === 'sessions' && basename(dirname(dir)) === STATE_DIR ? resolve(dir, '..', '..') : null
}

/** Saves the context's cookies and storage, owner-readable only; a failure here must not fail the run. */
export async function saveSession(page, session) {
  try {
    const state = await page.context().storageState()
    const root = rootOf(session)
    if (root) ensureStateDir(root)
    mkdirSync(dirname(session.path), { recursive: true, mode: 0o700 })
    writeFileSync(session.path, JSON.stringify(state), { mode: 0o600 })
    chmodSync(session.path, 0o600) // the mode above applies only when the file is new
    session.saved = true
    return true
  } catch {
    return false
  }
}
