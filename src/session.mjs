// The signed-in browser session, saved per role after a sign-in and reused by
// the next spec of the same role. Signing in from scratch for every spec is
// the slowest part of a suite; a saved session skips it. Whether the session
// still holds is decided by looking: if the sign-in screen appears, the
// browser signs in again and the saved session is refreshed.
//
// Sessions live in <runs>/.sessions/, which `init` gitignores along with the
// runs. The file name carries a hash of the account, so a changed test account
// never picks up the old account's session.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function sessionPath(config, role, creds) {
  const slug = String(role).toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const account = createHash('sha1').update(String(creds.email)).digest('hex').slice(0, 8)
  return join(config.runsDir, '.sessions', `${slug}-${account}.json`)
}

/** Where this role's session is kept, and whether one is saved already. */
export function sessionFor(config, role, creds) {
  const path = sessionPath(config, role, creds)
  return { path, saved: existsSync(path) }
}

/** Saves the context's cookies and storage; a failure here must not fail the run. */
export async function saveSession(page, session) {
  try {
    mkdirSync(dirname(session.path), { recursive: true })
    await page.context().storageState({ path: session.path })
    session.saved = true
    return true
  } catch {
    return false
  }
}
