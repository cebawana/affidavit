// The signed-in browser session, saved per role after a sign-in and reused by
// the next spec of the same role. Signing in from scratch for every spec is
// the slowest part of a suite; a saved session skips it. Whether it still
// holds is decided in src/executor.mjs by looking, most reliable signal first,
// and when nothing confirms it the browser signs in again.
//
// Sessions are live sign-in cookies, so they stay out of the runs folder
// (which gets zipped, shared and uploaded): they live in .affidavit/sessions/
// under the project root, gitignored by `init`, checked by `doctor`, and
// written readable by the owner only. The file name carries a hash of the
// account, so a changed test account never picks up the old account's session.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SESSIONS_DIR = '.affidavit/sessions'

export function sessionPath(config, role, creds) {
  const slug = String(role).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const account = createHash('sha1').update(String(creds.email)).digest('hex').slice(0, 8)
  return join(config.root, SESSIONS_DIR, `${slug}-${account}.json`)
}

/** Where this role's session is kept, and whether one is saved already. */
export function sessionFor(config, role, creds) {
  const path = sessionPath(config, role, creds)
  return { path, saved: existsSync(path) }
}

/** Saves the context's cookies and storage, owner-readable only; a failure here must not fail the run. */
export async function saveSession(page, session) {
  try {
    const state = await page.context().storageState()
    mkdirSync(dirname(session.path), { recursive: true, mode: 0o700 })
    writeFileSync(session.path, JSON.stringify(state), { mode: 0o600 })
    chmodSync(session.path, 0o600) // the mode above applies only when the file is new
    session.saved = true
    return true
  } catch {
    return false
  }
}
