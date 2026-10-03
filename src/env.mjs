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

/** The sign-in for a spec's `role`, or null for `role: none` (signed out). */
export function credentialsFor(role, prefix) {
  if (role === 'none') return null
  const key = role.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const email = process.env[`${prefix}${key}_EMAIL`]
  const password = process.env[`${prefix}${key}_PASSWORD`]
  if (!email || !password) {
    throw new Error(`No sign-in for role "${role}": set ${prefix}${key}_EMAIL and ${prefix}${key}_PASSWORD (e.g. in .env.qa.local)`)
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
