// Loads only what QA needs. Affidavit never reads database or service keys:
// it signs in through the login screen like a person, and the reviewer gets
// screenshots, so there is nothing for those keys to do.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadEnv(root, files, prefix) {
  const wanted = new RegExp(`^(${prefix}|AFFIDAVIT_|OPENROUTER_)`)
  for (const name of files) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m || !wanted.test(m[1]) || process.env[m[1]] !== undefined) continue
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

/** QA_ADMIN for "admin"; the env variable stem for a role. */
export function roleKey(role, prefix) {
  return `${prefix}${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * The sign-in for a spec's `role`, or null when there is nothing to sign in
 * with: `role: none` (signed out), or an app without sign-in (`auth.type:
 * "none"`), where the role is only a label.
 */
export function credentialsFor(role, prefix, auth = { type: 'form' }) {
  if (role === 'none' || auth?.type === 'none') return null
  const key = roleKey(role, prefix)
  const email = process.env[`${key}_EMAIL`]
  const password = process.env[`${key}_PASSWORD`]
  if (!email || !password) {
    throw new Error(`No sign-in for role "${role}": set ${key}_EMAIL and ${key}_PASSWORD (e.g. in .env.qa.local), or use "role: none" for pages that need no sign-in`)
  }
  return { email, password }
}

/** Affidavit clicks and writes for real; point it at a local server unless told otherwise. */
export function assertLocalBase(base, allowRemote) {
  const host = new URL(base).hostname
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.localhost') || host.endsWith('.test')
  if (!local && !allowRemote) {
    throw new Error(`Refusing to run against ${host}: QA signs in and writes data. Use a local server, or set "allowRemote": true deliberately.`)
  }
}
