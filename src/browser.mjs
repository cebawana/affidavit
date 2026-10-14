// Drives the app the way a person does: find what is on screen by the words on
// it, act on it, take a picture. No selectors, no test ids, no page internals —
// if a person could not find it by looking, neither can this, and that is a
// finding rather than something to work around.

import { chromium } from 'playwright-core'

const CLICK_ROLES = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'combobox']
const CONTROL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select'

async function newPage(browser, { viewport, locale, hide, storageState }) {
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
  return context.newPage()
}

/**
 * @param {string} [options.storageState] a saved session (cookies and storage)
 *   to start from, so the role is already signed in.
 * @returns {{ browser, page, fresh }} `fresh(page)` closes that page's context
 *   and opens a new one with nothing stored, whatever the app keeps its
 *   session in (cookies, local storage, IndexedDB), so a sign-in starts clean.
 */
export async function openBrowser({ viewport, headed, locale, channel, hide, storageState }) {
  const browser = await chromium.launch({ channel: channel || undefined, headless: !headed })
  const page = await newPage(browser, { viewport, locale, hide, storageState })
  const fresh = async old => {
    await old.context().close().catch(() => {})
    return newPage(browser, { viewport, locale, hide })
  }
  return { browser, page, fresh }
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

/**
 * Where on the page an element sits, as a person would describe it: in the
 * open dialog, the main content, the navigation (a sidebar, the page's header
 * or footer), or just the page. Runs in the browser; it reads landmarks only.
 */
function regionOf(el) {
  let pending = null
  for (let n = el; n && n.tagName !== 'BODY'; n = n.parentElement) {
    const role = (n.getAttribute('role') || '').toLowerCase()
    const tag = n.tagName.toLowerCase()
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') return 'dialog'
    if (tag === 'main' || role === 'main') return 'main'
    if (tag === 'nav' || tag === 'aside' || ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role)) return 'navigation'
    // The page's own header or footer is chrome; a card's header inside an article is content.
    if (tag === 'header' || tag === 'footer') pending = 'navigation'
    if (tag === 'article' || tag === 'section' || tag === 'form') pending = null
  }
  return pending ?? 'page'
}

const REGION_RANK = { dialog: 0, main: 1, page: 2, navigation: 3 }
const REGION_NAME = { dialog: 'the open dialog', main: 'the main content', page: 'the page', navigation: 'the navigation' }
const MAX_CANDIDATES = 5 // per role; enough to rank, cheap to classify

/**
 * Among several visible matches, the one a person most likely means: in the
 * open dialog first, then the main content, then the rest of the page, then
 * the navigation. `click "Invoices"` is the tab in front of you, not the
 * sidebar link of the same name. Among equals, the role order and then the
 * order on the page decide. A single match is returned untouched.
 */
async function pick(found, count) {
  if (found.length === 1) return { loc: found[0].loc, count }
  for (const c of found) c.region = await c.loc.evaluate(regionOf).catch(() => 'page')
  found.sort((a, b) => REGION_RANK[a.region] - REGION_RANK[b.region] || a.order - b.order || a.index - b.index)
  const [best, ...rest] = found
  return { loc: best.loc, count, region: best.region, others: [...new Set(rest.map(c => c.region))] }
}

/** The visible matches for `name`, exact wording first, ranked by where they sit. */
async function findClickable(root, name) {
  for (const exact of [true, false]) {
    const found = []
    let count = 0
    for (const [order, role] of CLICK_ROLES.entries()) {
      const vis = root.getByRole(role, { name, exact }).filter({ visible: true })
      const n = await vis.count()
      count += n
      for (let index = 0; index < Math.min(n, MAX_CANDIDATES); index++) found.push({ loc: vis.nth(index), order, index })
    }
    if (!found.length) {
      const vis = root.getByText(name, { exact }).filter({ visible: true })
      count = await vis.count()
      for (let index = 0; index < Math.min(count, MAX_CANDIDATES); index++) found.push({ loc: vis.nth(index), order: 0, index })
    }
    if (found.length) return pick(found, count)
  }
  return null
}

async function findInScopes(page, name) {
  for (const root of await scopes(page)) {
    const hit = await findClickable(root, name)
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

const QUIET_MS = 300 // nothing on screen changed for this long: the page is ready
const NOTEWORTHY_MS = 1000 // a shorter wait is normal page loading, not worth a note
const NETWORK_MS = 1000 // the network gets this long to go idle; after that the screen decides

/**
 * Runs inside the page: resolves true once `quiet` ms pass with no change to
 * the document and no layout shift, false if the page is still changing when
 * `limit` ms are up. Counts changes only — it reads nothing from the app.
 */
function quietWindow({ quiet, limit }) {
  return new Promise(resolve => {
    let timer
    let shifts = null
    const changes = new MutationObserver(() => bump())
    const finish = value => {
      changes.disconnect()
      shifts?.disconnect()
      clearTimeout(timer)
      clearTimeout(deadline)
      resolve(value)
    }
    const bump = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(true), quiet)
    }
    const deadline = setTimeout(() => finish(false), limit)
    changes.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    try {
      shifts = new PerformanceObserver(list => { if (list.getEntries().some(e => !e.hadRecentInput)) bump() })
      shifts.observe({ type: 'layout-shift' })
    } catch { /* no layout-shift entries in this browser: document changes still count */ }
    bump()
  })
}

/**
 * Waits until the page is ready to be acted on, the way a person waits for a
 * page to stop loading before clicking: the load has finished, the network has
 * gone quiet, and nothing on screen has changed or moved for a moment. On a
 * server-rendered app a click can otherwise land before the page's script has
 * taken over, and the click is lost — a timing problem that would read as a
 * product bug. Generic by design (no framework hooks, nothing from inside the
 * app), and best effort: a page that never stops changing (a live clock, a
 * polling feed) is acted on anyway once `budget` ms are spent. The target
 * itself is checked again at click time: Playwright acts only on an element
 * whose box has stopped moving.
 *
 * @returns {{ waitedMs: number, quiet: boolean, networkBusy: boolean }}
 */
export async function ready(page, budget) {
  const started = Date.now()
  const left = () => budget - (Date.now() - started)
  let quiet = false
  let networkBusy = false
  try {
    while (left() > 0 && !quiet) {
      await page.waitForLoadState('load', { timeout: left() }).catch(() => {})
      if (left() <= 0) break
      // A page that polls (notifications, a dashboard that refreshes) never
      // goes idle, and a person does not wait for it: the network gets a
      // moment, so a bundle still on its way can arrive, then the screen decides.
      networkBusy = !(await page.waitForLoadState('networkidle', { timeout: Math.min(left(), NETWORK_MS) }).then(() => true, () => false))
      if (left() <= 0) break
      // A navigation while we watch destroys the page's context: start over
      // with the new page. The deadline keeps one watch short, so a page that
      // is never quiet still re-checks the network on the way to giving up.
      const limit = Math.max(Math.min(left(), 2000), QUIET_MS)
      quiet = await page.evaluate(quietWindow, { quiet: QUIET_MS, limit }).catch(() => sleep(100).then(() => false))
    }
  } catch { /* readiness is a courtesy to the action, never a reason to skip it */ }
  return { waitedMs: Date.now() - started, quiet, networkBusy }
}

/** The note an action carries when the wait before it was long enough to matter. */
export function readyNote({ waitedMs, quiet, networkBusy }) {
  if (waitedMs < NOTEWORTHY_MS) return undefined
  const secs = `${(waitedMs / 1000).toFixed(1)}s`
  if (!quiet) return `the screen kept changing for ${secs}; acted anyway`
  return `waited ${secs} for the page to be ready${networkBusy ? '; the network stayed busy but the screen was still' : ''}`
}

/** Actions that touch the page, so they wait for it to be ready first. */
const INTERACTS = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'press', 'scrollTo'])

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
  const waited = INTERACTS.has(action.kind) ? readyNote(await ready(page, ctx.timeouts.ready ?? 5000)) : undefined
  const res = await act(page, ctx, action)
  return waited ? { ...res, note: [res.note, waited].filter(Boolean).join('; ') } : res
}

async function act(page, ctx, action) {
  const { find, gone: goneTimeout } = ctx.timeouts
  const miss = what => ({ ok: false, note: `Could not see ${what} on screen` })
  const many = hit => {
    if (hit.count <= 1) return undefined
    const others = hit.others?.filter(r => r !== hit.region) ?? []
    if (!hit.region || !others.length) return `${hit.count} matches on screen${hit.region ? `, all in ${REGION_NAME[hit.region]}` : ''}; used the first`
    return `${hit.count} matches on screen; used the one in ${REGION_NAME[hit.region]}; the others are in ${others.map(r => REGION_NAME[r]).join(' and ')}`
  }
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
        // Many apps disable a control until their script has taken over, so a
        // click that failed at once would read as broken: disabled counts as
        // "not clickable yet" for as long as finding it would. A spec that
        // expects a disabled control says so with `expect:`, so nothing waits there.
        let disabled = null
        const hit = await poll(async () => {
          const h = action.near ? await findNear(page, action.target, action.near) : await findInScopes(page, action.target)
          if (!h) return null
          if (await h.loc.isDisabled().catch(() => false)) { disabled = h; return null }
          disabled = null
          return h
        }, find)
        if (!hit) {
          return disabled
            ? { ok: false, note: `"${action.target}" is visible but disabled (still disabled after ${find / 1000}s)` }
            : miss(`"${action.target}"${action.near ? ` near "${action.near}"` : ''}`)
        }
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
