// Drives the app the way a person does: find what is on screen by the words on
// it, act on it, take a picture. No selectors, no test ids, no page internals —
// if a person could not find it by looking, neither can this, and that is a
// finding rather than something to work around.

import { chromium } from 'playwright-core'

const CLICK_ROLES = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'combobox']
const CONTROL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'

/**
 * @param {{ storageState?: string }} [options.storageState] a saved session
 *   (cookies and storage) to start from, so the role is already signed in.
 */
export async function openBrowser({ viewport, headed, locale, channel, hide, storageState }) {
  const browser = await chromium.launch({ channel: channel || undefined, headless: !headed })
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, locale, deviceScaleFactor: 1,
    storageState: storageState || undefined,
  })
  // Dev-only overlays (a framework's badge) sit over the app's own UI in every
  // screenshot, and the reviewer rightly reports them as overlapping text.
  if (hide?.length) {
    await context.addInitScript(css => {
      const apply = () => document.head?.insertAdjacentHTML('beforeend', `<style>${css}</style>`)
      if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply)
    }, hide.map(sel => `${sel}{display:none!important}`).join(''))
  }
  const page = await context.newPage()
  return { browser, page }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function poll(fn, timeout) {
  const until = Date.now() + timeout
  for (;;) {
    const found = await fn().catch(() => null)
    if (found || Date.now() > until) return found
    await sleep(250)
  }
}

async function firstVisible(locator) {
  const vis = locator.filter({ visible: true })
  const count = await vis.count()
  return count ? { loc: vis.first(), count } : null
}

/** The topmost open dialog, if any — a person sees the modal, not the page behind it. */
async function scopes(page) {
  const dialogs = page.getByRole('dialog').filter({ visible: true })
  const n = await dialogs.count()
  return n ? [dialogs.nth(n - 1), page] : [page]
}

async function findClickable(root, name) {
  for (const exact of [true, false]) {
    for (const role of CLICK_ROLES) {
      const hit = await firstVisible(root.getByRole(role, { name, exact }))
      if (hit) return hit
    }
    const hit = await firstVisible(root.getByText(name, { exact }))
    if (hit) return hit
  }
  return null
}

async function findNear(page, name, near) {
  for (const root of await scopes(page)) {
    const anchors = root.getByText(near).filter({ visible: true })
    const n = Math.min(await anchors.count(), 5)
    for (let i = 0; i < n; i++) {
      let box = anchors.nth(i)
      for (let depth = 0; depth < 8; depth++) {
        box = box.locator('xpath=..')
        const hit = await findClickable(box, name)
        if (hit) return hit
      }
    }
  }
  return null
}

async function findField(page, label) {
  for (const root of await scopes(page)) {
    for (const loc of [
      root.getByLabel(label, { exact: true }), root.getByPlaceholder(label, { exact: true }),
      root.getByLabel(label), root.getByPlaceholder(label),
    ]) {
      const hit = await firstVisible(loc)
      if (hit) return { ...hit, how: 'label' }
    }
    // The label is text shown beside the control but not tied to it.
    const texts = root.getByText(label, { exact: true }).filter({ visible: true })
    const n = Math.min(await texts.count(), 5)
    for (let i = 0; i < n; i++) {
      let box = texts.nth(i)
      for (let depth = 0; depth < 3; depth++) {
        box = box.locator('xpath=..')
        const hit = await firstVisible(box.locator(CONTROL))
        if (hit) return { ...hit, how: 'nearby text' }
      }
    }
  }
  return null
}

async function findCheckbox(page, label) {
  for (const root of await scopes(page)) {
    const hit = await firstVisible(root.getByRole('checkbox', { name: label }))
      ?? await firstVisible(root.getByLabel(label))
    if (hit) return hit
  }
  return null
}

async function findText(page, text) {
  return (await firstVisible(page.getByText(text, { exact: true }))) ?? firstVisible(page.getByText(text))
}

/** Lets the page finish what the last action started before we look at it. */
export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  await sleep(600)
}

const UNLABELLED = 'field found by the text beside it (it has no attached label)'

/**
 * Performs one action. Returns { ok, note } — never throws for "not on
 * screen", because that is a result the reviewer needs to see.
 *
 * @param {{ base: string, timeouts: { find: number, gone: number }, notFoundText: string | null }} ctx
 */
export async function perform(page, ctx, action) {
  const { find, gone: goneTimeout } = ctx.timeouts
  const miss = what => ({ ok: false, note: `Could not see ${what} on screen` })
  const many = hit => (hit.count > 1 ? `${hit.count} matches on screen; used the first` : undefined)
  try {
    switch (action.kind) {
      case 'open': {
        // Some dev servers answer 404 for a few seconds while they recompile.
        // Retry like a person pressing reload, and say so — a 404 that
        // survives the retries is left on screen for the reviewer.
        let retries = 0
        for (;;) {
          await page.goto(new URL(action.path, ctx.base).toString(), { waitUntil: 'domcontentloaded' })
          const notFound = ctx.notFoundText
            ? await page.getByText(ctx.notFoundText).filter({ visible: true }).count()
            : 0
          if (!notFound || retries === 3) break
          retries++
          await sleep(3000)
        }
        return { ok: true, note: retries ? `page showed "${ctx.notFoundText}" and was reloaded ${retries}×` : undefined }
      }
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' })
        return { ok: true }
      case 'click': {
        const hit = await poll(async () => {
          if (action.near) return findNear(page, action.target, action.near)
          for (const root of await scopes(page)) {
            const h = await findClickable(root, action.target)
            if (h) return h
          }
          return null
        }, find)
        if (!hit) return miss(`"${action.target}"${action.near ? ` near "${action.near}"` : ''}`)
        if (await hit.loc.isDisabled().catch(() => false)) return { ok: false, note: `"${action.target}" is visible but disabled` }
        await hit.loc.click({ timeout: 5000 })
        return { ok: true, note: many(hit) }
      }
      case 'fill': {
        const hit = await poll(() => findField(page, action.target), find)
        if (!hit) return miss(`a field labelled "${action.target}"`)
        await hit.loc.fill(action.value, { timeout: 5000 })
        return { ok: true, note: hit.how === 'nearby text' ? UNLABELLED : many(hit) }
      }
      case 'select': {
        const hit = await poll(() => findField(page, action.target), find)
        if (!hit) return miss(`a field labelled "${action.target}"`)
        await hit.loc.selectOption({ label: action.value }, { timeout: 5000 })
          .catch(() => hit.loc.selectOption(action.value, { timeout: 5000 }))
        return { ok: true, note: hit.how === 'nearby text' ? UNLABELLED : undefined }
      }
      case 'check':
      case 'uncheck': {
        const hit = await poll(() => findCheckbox(page, action.target), find)
        if (!hit) return miss(`a checkbox "${action.target}"`)
        await (action.kind === 'check' ? hit.loc.check({ timeout: 5000 }) : hit.loc.uncheck({ timeout: 5000 }))
        return { ok: true }
      }
      case 'press':
        await page.keyboard.press(action.key)
        return { ok: true }
      case 'waitFor': {
        const limit = find + 4000
        const hit = await poll(() => findText(page, action.target), limit)
        return hit ? { ok: true } : miss(`"${action.target}" (waited ${limit / 1000}s)`)
      }
      case 'waitGone': {
        const limit = action.timeout ?? goneTimeout
        const gone = await poll(async () => (await page.getByText(action.target).filter({ visible: true }).count()) === 0, limit)
        return gone ? { ok: true } : { ok: false, note: `"${action.target}" was still on screen after ${limit / 1000}s` }
      }
      case 'scrollTo': {
        const hit = await poll(() => findText(page, action.target), find)
        if (!hit) return miss(`"${action.target}"`)
        await hit.loc.scrollIntoViewIfNeeded()
        return { ok: true }
      }
      default:
        return { ok: false, note: `Unknown action "${action.text}"` }
    }
  } catch (err) {
    return { ok: false, note: `The action failed: ${String(err.message ?? err).split('\n')[0]}` }
  }
}

/** Whether `text` is on screen, giving a client-side render or redirect up to `wait` ms to show it. */
export async function textVisible(page, text, wait = 1000) {
  return Boolean(await poll(async () => ((await page.getByText(text).filter({ visible: true }).count()) ? true : null), wait))
}

/**
 * Whether the sign-in screen is showing — judged the way a person would, by
 * the text on it (the field label that `doneWhenGone` waits for). A saved
 * session that lands here has expired. A client-side redirect to the login
 * page can take a moment, so this looks for a short while before saying no.
 */
export async function loginFormVisible(page, auth, wait = 1000) {
  if (auth?.type !== 'form') return false
  const marker = auth.doneWhenGone || auth.fields?.email
  if (!marker) return false
  return Boolean(await poll(async () => {
    for (const loc of [page.getByText(marker), page.getByLabel(marker), page.getByPlaceholder(marker)]) {
      if (await loc.filter({ visible: true }).count()) return true
    }
    return null
  }, wait))
}

/**
 * Forgets the browser's cookies and storage, so a sign-in starts from nothing.
 * Needed before signing in again over a saved session the app would not
 * confirm: left in place, the app may show the signed-in page instead of the
 * form. This resets the browser's own state; it reads nothing from the app.
 */
export async function forgetSession(page) {
  await page.context().clearCookies().catch(() => {})
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* opaque origin */ } }).catch(() => {})
}

/** Whether `url` is the sign-in page (path only; the query may carry a "next" target). */
export function onLoginPath(url, loginPath, base) {
  try {
    const strip = p => p.replace(/\/+$/, '') || '/'
    return strip(new URL(url).pathname) === strip(new URL(loginPath, base).pathname)
  } catch {
    return false
  }
}

/**
 * Signs in through the app's own login screen, as configured. The password is
 * masked in every log, report and reviewer prompt. `onLoginPage` skips opening
 * the login page when the form is already on screen.
 */
export function signInSteps(auth, creds, start, signInTimeout, { onLoginPage = false } = {}) {
  const steps = []
  if (creds && auth.type === 'form') {
    const { email, password } = auth.fields
    if (!onLoginPage) steps.push({ kind: 'open', path: auth.loginPath, text: `open "${auth.loginPath}"` })
    steps.push(
      { kind: 'fill', target: email, value: creds.email, text: `fill "${email}" with "${creds.email}"` },
      { kind: 'fill', target: password, value: creds.password, text: `fill "${password}" with "••••••••"` },
      { kind: 'click', target: auth.submit, text: `click "${auth.submit}"` },
    )
    if (auth.doneWhenGone) {
      steps.push({ kind: 'waitGone', target: auth.doneWhenGone, timeout: signInTimeout, text: `wait until gone "${auth.doneWhenGone}"` })
    }
  }
  if (start) steps.push({ kind: 'open', path: start, text: `open "${start}"` })
  return steps
}
