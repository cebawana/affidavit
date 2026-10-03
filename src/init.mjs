// `affidavit init` sets a project up; `affidavit doctor` checks it can run.
// Init never overwrites a file that already exists, and says what it did.

import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { CONFIG_FILE } from './config.mjs'
import { PRESETS } from './presets.mjs'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')

function detectPreset(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.next) return 'next'
    if (deps.vite) return 'vite'
  } catch { /* not a JS project */ }
  return 'none'
}

function gitignored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function init(root, { preset } = {}) {
  const done = []
  const warn = []
  const chosen = preset ?? detectPreset(root)
  if (!PRESETS[chosen]) throw new Error(`unknown preset "${chosen}" (known: ${Object.keys(PRESETS).join(', ')})`)

  const configPath = join(root, CONFIG_FILE)
  if (!existsSync(configPath)) {
    const config = {
      baseUrl: 'http://localhost:3000',
      preset: chosen,
      specs: 'qa/specs',
      runs: 'qa/runs',
      envFiles: ['.env.qa.local'],
      envPrefix: 'QA_',
      viewports: { desktop: '1440x900', phone: '390x844', tablet: '820x1180' },
      auth: { type: 'form', loginPath: '/login', fields: { email: 'Email', password: 'Password' }, submit: 'Sign in' },
      backend: { name: 'claude-cli', model: 'sonnet' },
      leakTerms: [],
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    done.push(`wrote ${CONFIG_FILE} (preset "${chosen}"): set "auth" to your login screen's labels`)
  }

  const specsDir = join(root, 'qa/specs')
  mkdirSync(specsDir, { recursive: true })
  const example = join(specsDir, '_example.qa.md')
  if (!existsSync(example)) {
    copyFileSync(join(PKG, 'templates/_example.qa.md'), example)
    done.push(`wrote ${relative(root, example)}`)
  }

  const envExample = join(root, '.env.qa.example')
  if (!existsSync(envExample)) {
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
  return { done, warn }
}

/** Everything a run needs, checked without running anything that writes. */
export async function doctor(config) {
  const checks = []
  const ok = (name, detail) => checks.push({ ok: true, name, detail })
  const bad = (name, detail) => checks.push({ ok: false, name, detail })

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

  const prefix = config.envPrefix
  const roles = Object.keys(process.env).filter(k => k.startsWith(prefix) && k.endsWith('_EMAIL')).map(k => k.slice(prefix.length, -6).toLowerCase())
  roles.length ? ok('roles', roles.join(', ')) : bad('roles', `no ${prefix}<ROLE>_EMAIL / _PASSWORD found in ${config.envFiles.join(', ')}`)

  try {
    const res = await fetch(config.baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    ok('server', `${config.baseUrl} answered ${res.status}`)
  } catch {
    bad('server', `${config.baseUrl} did not answer; start the app first`)
  }
  return checks
}
