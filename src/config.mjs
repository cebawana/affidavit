// Project configuration: `affidavit.config.json` at the project root. JSON on
// purpose — a Laravel or Rails project should not have to write JavaScript to
// be tested.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PRESETS } from './presets.mjs'

export const CONFIG_FILE = 'affidavit.config.json'

export const DEFAULTS = {
  baseUrl: 'http://localhost:3000',
  specs: 'qa/specs',
  runs: 'qa/runs',
  envFiles: ['.env.qa.local'],
  envPrefix: 'QA_',
  locale: 'en-US',
  browser: { channel: 'chrome' },
  viewports: { desktop: '1440x900', phone: '390x844', tablet: '820x1180' },
  defaultViewport: 'desktop',
  // A spec without `role:` uses this. Left unset, every spec must name its
  // role, so a spec in an app with a login cannot silently run signed out.
  defaultRole: null,
  preset: 'none',
  auth: {
    // "form": sign in through the login screen. "none": the app has no
    // sign-in; credentials are never looked up and `role` is only a label.
    type: 'form',
    loginPath: '/login',
    fields: { email: 'Email', password: 'Password' },
    submit: 'Sign in',
    // Text that disappears once signed in. Defaults to the email field's label.
    doneWhenGone: null,
  },
  backend: { name: 'claude-cli', model: null, reviewModel: null, exploreModel: null },
  leakTerms: [],
  hide: [],
  timeouts: { find: 15000, gone: 20000, signIn: 90000 },
  allowRemote: false,
  maxTurns: 25,
}

/** The nearest folder at or above `from` that holds a config file. */
export function findRoot(from = process.cwd()) {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const isObject = v => v && typeof v === 'object' && !Array.isArray(v)

function merge(base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v
  }
  return out
}

export function loadConfig(root) {
  const path = join(root, CONFIG_FILE)
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${CONFIG_FILE}: ${err.message}`)
  }
  const config = merge(DEFAULTS, raw)
  const preset = PRESETS[config.preset]
  if (!preset) throw new Error(`${CONFIG_FILE}: unknown preset "${config.preset}" (known: ${Object.keys(PRESETS).join(', ')})`)
  config.hide = [...new Set([...preset.hide, ...config.hide])]
  config.notFoundText = config.notFoundText ?? preset.notFoundText
  config.auth.doneWhenGone ??= config.auth.fields?.email ?? null
  config.root = root
  config.specsDir = resolve(root, config.specs)
  config.runsDir = resolve(root, config.runs)

  // Environment overrides, so one run can differ without editing the file.
  const p = config.envPrefix
  const env = name => process.env[`${p}${name}`]?.trim() || process.env[`AFFIDAVIT_${name}`]?.trim()
  if (env('BASE_URL')) config.baseUrl = env('BASE_URL')
  if (env('BACKEND')) config.backend.name = env('BACKEND')
  if (env('MODEL')) config.backend.model = env('MODEL')
  if (env('REVIEW_MODEL')) config.backend.reviewModel = env('REVIEW_MODEL')
  if (env('EXPLORE_MODEL')) config.backend.exploreModel = env('EXPLORE_MODEL')
  if (env('LOCALE')) config.locale = env('LOCALE')
  if (env('ALLOW_REMOTE') === '1') config.allowRemote = true
  return config
}

/** "phone" → { width, height, name }; "390x844" also works. */
export function resolveViewport(value, config) {
  const name = value || config.defaultViewport
  const size = config.viewports[name] ?? name
  const m = String(size).match(/^(\d+)x(\d+)$/)
  if (!m) throw new Error(`unknown viewport "${name}" (known: ${Object.keys(config.viewports).join(', ')}, or WIDTHxHEIGHT)`)
  const width = Number(m[1])
  const height = Number(m[2])
  const named = Object.entries(config.viewports).find(([, v]) => v === `${width}x${height}`)?.[0]
  return { width, height, name: named ?? `${width}x${height}` }
}
