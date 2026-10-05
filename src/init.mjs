// `affidavit init` sets a project up; `affidavit doctor` checks it can run.
// Init never overwrites a file that already exists, and says what it did.

import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CONFIG_FILE } from './config.mjs'
import { roleKey } from './env.mjs'
import { PRESETS } from './presets.mjs'
import { allSpecs, loadSpec } from './run.mjs'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

export function detectPreset(root) {
  const pkg = readJson(join(root, 'package.json'))
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  if (deps.next) return 'next'
  if (deps.vite) return 'vite'
  return 'none'
}

/**
 * The port the project's own dev server says it uses, or null. Only what the
 * project states outright is trusted: a `--port` / `-p` flag or a `PORT=` in
 * the dev script, or `server.port` in a Vite config. Otherwise the preset's
 * default applies.
 */
export function detectPort(root) {
  const pkg = readJson(join(root, 'package.json'))
  for (const name of ['dev', 'start', 'serve']) {
    const script = pkg?.scripts?.[name]
    if (typeof script !== 'string') continue
    const m = script.match(/(?:--port|-p)[= ](\d{2,5})\b/) ?? script.match(/\bPORT=(\d{2,5})\b/)
    if (m) return Number(m[1])
  }
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    const m = readFileSync(path, 'utf8').match(/\bport\s*:\s*(\d{2,5})\b/)
    if (m) return Number(m[1])
  }
  return null
}

function gitignored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} root
 * @param {{ preset?: string, auth?: boolean, baseUrl?: string }} [options]
 *   auth: false when the app has no sign-in. Defaults to true (today's
 *   behaviour) so a script that does not ask gets the fuller setup.
 */
export function init(root, { preset, auth = true, baseUrl } = {}) {
  const done = []
  const warn = []
  const chosen = preset ?? detectPreset(root)
  if (!PRESETS[chosen]) throw new Error(`unknown preset "${chosen}" (known: ${Object.keys(PRESETS).join(', ')})`)

  const configPath = join(root, CONFIG_FILE)
  if (!existsSync(configPath)) {
    const port = detectPort(root) ?? PRESETS[chosen].port
    const config = {
      baseUrl: baseUrl ?? `http://localhost:${port}`,
      preset: chosen,
      specs: 'qa/specs',
      runs: 'qa/runs',
      envFiles: ['.env.qa.local'],
      envPrefix: 'QA_',
      viewports: { desktop: '1440x900', phone: '390x844', tablet: '820x1180' },
      ...(auth
        ? { auth: { type: 'form', loginPath: '/login', fields: { email: 'Email', password: 'Password' }, submit: 'Sign in' } }
        : { auth: { type: 'none' }, defaultRole: 'none' }),
      backend: { name: 'claude-cli', model: 'sonnet' },
      leakTerms: [],
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    done.push(`wrote ${CONFIG_FILE} (preset "${chosen}", app at ${config.baseUrl}${auth ? ', sign-in form' : ', no sign-in'})${auth ? ': set "auth" to your login screen\'s labels' : ''}`)
  }

  const specsDir = join(root, 'qa/specs')
  mkdirSync(specsDir, { recursive: true })
  const example = join(specsDir, '_example.qa.md')
  if (!existsSync(example)) {
    copyFileSync(join(PKG, auth ? 'templates/_example.qa.md' : 'templates/_example-public.qa.md'), example)
    done.push(`wrote ${relative(root, example)}`)
  }

  // An app without sign-in has no test accounts to fill in, so no template.
  const envExample = join(root, '.env.qa.example')
  if (auth && !existsSync(envExample)) {
    copyFileSync(join(PKG, 'templates/env.qa.example'), envExample)
    done.push('wrote .env.qa.example: copy it to .env.qa.local and fill in test accounts')
  }

  const skill = join(root, '.claude/skills/affidavit/SKILL.md')
  if (!existsSync(skill)) {
    mkdirSync(dirname(skill), { recursive: true })
    copyFileSync(join(PKG, 'skills/affidavit/SKILL.md'), skill)
    done.push('installed the Claude Code skill in .claude/skills/affidavit/')
  }
  if (existsSync(join(root, '.git')) && gitignored(root, '.claude/skills/affidavit/SKILL.md')) {
    warn.push('.claude/ is gitignored, so the skill will not reach other checkouts. Replace ".claude/" in .gitignore with:\n      .claude/*\n      !.claude/skills/')
  }

  const ignore = join(root, '.gitignore')
  const lines = existsSync(ignore) ? readFileSync(ignore, 'utf8').split('\n').map(l => l.trim()) : []
  const add = ['qa/runs/', '.env.qa.local'].filter(l => !lines.includes(l) && !(existsSync(join(root, '.git')) && gitignored(root, l.replace(/\/$/, '/x'))))
  if (add.length) {
    appendFileSync(ignore, `${lines.length && lines.at(-1) !== '' ? '\n' : ''}# Affidavit (visual QA)\n${add.join('\n')}\n`)
    done.push(`added ${add.join(', ')} to .gitignore`)
  }

  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg.scripts?.qa) {
      pkg.scripts = { ...pkg.scripts, qa: 'affidavit run' }
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
      done.push('added "qa": "affidavit run" to package.json scripts')
    }
  }
  return { done, warn, auth }
}

/** The <title> of a page, or null. */
export function pageTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? m[1].replace(/\s+/g, ' ').trim() || null : null
}

/**
 * One line that shows *what* answered, not only that something did:
 * `http://localhost:5173 → "Portfolio"`, or when the server redirected,
 * `http://localhost:3000 → /login "Other App"`. Seeing the wrong app's title
 * here is the cheapest way to notice that `baseUrl` points at the wrong port.
 */
export function serverDetail(baseUrl, finalUrl, title) {
  const base = new URL(baseUrl)
  const end = new URL(finalUrl)
  const moved = end.href.replace(/\/$/, '') !== base.href.replace(/\/$/, '')
  const where = !moved ? '' : end.origin === base.origin ? `${end.pathname}${end.search}` : end.href
  const label = title ? `"${title}"` : '(no page title)'
  return `${baseUrl} → ${where ? `${where} ` : ''}${label}`
}

/**
 * Which roles the specs sign in as, and which of those have no credentials.
 * Specs that cannot be parsed are skipped; `check` reports those.
 */
export function rolesCheck(config) {
  if (config.auth.type === 'none') return { ok: true, detail: 'no sign-in needed (auth.type is "none")' }
  const prefix = config.envPrefix
  const needed = new Set()
  let specs = 0
  for (const file of allSpecs(config)) {
    try {
      const spec = loadSpec(file, config)
      specs++
      if (spec.role !== 'none') needed.add(spec.role)
    } catch { /* reported by `check` */ }
  }
  const has = role => process.env[`${roleKey(role, prefix)}_EMAIL`] && process.env[`${roleKey(role, prefix)}_PASSWORD`]
  if (specs && needed.size === 0) return { ok: true, detail: 'no sign-in needed (every spec uses role: none)' }
  if (needed.size) {
    const missing = [...needed].filter(r => !has(r))
    if (!missing.length) return { ok: true, detail: [...needed].join(', ') }
    const vars = missing.map(r => `${roleKey(r, prefix)}_EMAIL / _PASSWORD`).join(', ')
    return { ok: false, detail: `no credentials for ${missing.join(', ')}: set ${vars} in ${config.envFiles.join(', ')}, or use "role: none" for pages that need no sign-in` }
  }
  // No specs yet: show whatever accounts are configured.
  const roles = Object.keys(process.env).filter(k => k.startsWith(prefix) && k.endsWith('_EMAIL')).map(k => k.slice(prefix.length, -6).toLowerCase())
  return roles.length
    ? { ok: true, detail: roles.join(', ') }
    : { ok: false, detail: `no ${prefix}<ROLE>_EMAIL / _PASSWORD found in ${config.envFiles.join(', ')}; or set "auth": {"type": "none"} if the app has no sign-in` }
}

/** Everything a run needs, checked without running anything that writes. */
export async function doctor(config) {
  const checks = []
  const ok = (name, detail) => checks.push({ ok: true, name, detail })
  const bad = (name, detail) => checks.push({ ok: false, name, detail })
  const warn = (name, detail) => checks.push({ ok: true, warn: true, name, detail })

  try {
    const browser = await chromium.launch({ channel: config?.browser?.channel || undefined, headless: true })
    ok('browser', `${config?.browser?.channel || 'chromium'} ${browser.version()}`)
    await browser.close()
  } catch (err) {
    bad('browser', `cannot launch ${config?.browser?.channel || 'chromium'}: ${String(err.message).split('\n')[0]}. Install Google Chrome, or set "browser": {"channel": ""} and run "npx playwright install chromium".`)
  }

  if (!config) {
    bad('config', `no ${CONFIG_FILE}; run "npx affidavit init"`)
    return checks
  }
  ok('config', `${CONFIG_FILE}, preset "${config.preset}", backend "${config.backend.name}"`)

  if (config.backend.name === 'claude-cli') {
    try {
      const v = execFileSync(process.env.AFFIDAVIT_CLAUDE_BIN?.trim() || 'claude', ['--version'], { encoding: 'utf8' }).trim()
      ok('reviewer', `claude CLI ${v}`)
    } catch {
      bad('reviewer', 'the claude CLI is not on PATH (needed by the claude-cli backend)')
    }
  } else if (config.backend.name === 'openrouter') {
    process.env.OPENROUTER_API_KEY ? ok('reviewer', 'OPENROUTER_API_KEY is set') : bad('reviewer', 'OPENROUTER_API_KEY is not set')
  }

  const roles = rolesCheck(config)
  ;(roles.ok ? ok : bad)('roles', roles.detail)

  try {
    const res = await fetch(config.baseUrl, { redirect: 'follow', signal: AbortSignal.timeout(5000) })
    const html = res.headers.get('content-type')?.includes('html') ? await res.text() : ''
    ok('server', serverDetail(config.baseUrl, res.url, pageTitle(html)))
    const loginPath = config.auth.loginPath
    if (config.auth.type === 'none' && loginPath && new URL(res.url).pathname.startsWith(loginPath) && res.url !== config.baseUrl) {
      warn('server', 'this app redirects to a sign-in page, but auth.type is "none"; check "baseUrl" or "auth"')
    }
  } catch {
    bad('server', `${config.baseUrl} did not answer; start the app first`)
  }
  return checks
}
