// Runs the browser layer against a real Google Chrome and a small local app.
// Skipped where Chrome is not installed (the rest of the suite needs neither
// a browser nor a server), so a project without it still runs `npm test`.

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { perform, ready, textVisible } from '../src/browser.mjs'

/**
 * A pretend app with the timing problems #1 is about. Its script is served
 * `async`, as frameworks serve their bundles, so DOMContentLoaded fires before
 * it arrives and a click on "Save" lands on a button nobody is listening to.
 */
const PAGES = {
  // The bundle takes 1.5s to arrive; until then the button does nothing.
  '/slow-bundle': `<!doctype html><title>Slow</title><h1>Invoice</h1><button>Save</button><p id="out"></p>
    <script async src="/app.js?delay=1500"></script>`,
  // The bundle is quick, but hydration itself is deferred and first redraws
  // the page (new content above the button, so it moves) before it listens.
  '/late-hydrate': `<!doctype html><title>Late</title><div id="top"></div><h1>Invoice</h1><button>Save</button><p id="out"></p>
    <script>setTimeout(() => {
      document.getElementById('top').innerHTML = '<div style="height:120px">Welcome back</div>'
      setTimeout(() => { document.getElementById('top').insertAdjacentHTML('beforeend', '<div style="height:40px">2 unread</div>') }, 200)
      setTimeout(() => { document.querySelector('button').onclick = () => { document.getElementById('out').textContent = 'Saved' } }, 400)
    }, 600)</script>`,
  // Nothing to wait for.
  '/ready': `<!doctype html><title>Ready</title><h1>Invoice</h1><button onclick="document.getElementById('out').textContent='Saved'">Save</button><p id="out"></p>`,
  // Polls the network every 300 ms (notifications, a refreshing dashboard)
  // while the screen stays still: the network never goes idle.
  '/polling': `<!doctype html><title>Polling</title><h1>Invoice</h1><button onclick="document.getElementById('out').textContent='Saved'">Save</button><p id="out"></p>
    <script>setInterval(() => fetch('/ping'), 300)</script>`,
  // The button is disabled until the script has taken over, 1.2 s in.
  '/enabled-later': `<!doctype html><title>Later</title><h1>Invoice</h1><button disabled onclick="document.getElementById('out').textContent='Saved'">Save</button><p id="out"></p>
    <script>setTimeout(() => { document.querySelector('button').disabled = false }, 1200)</script>`,
  // Disabled for good.
  '/never-enabled': `<!doctype html><title>Never</title><h1>Invoice</h1><button disabled>Save</button><p id="out"></p>`,
  // A live clock: the page never stops changing, and is acted on anyway.
  '/ticking': `<!doctype html><title>Ticking</title><h1>Invoice</h1><span id="clock"></span>
    <button onclick="document.getElementById('out').textContent='Saved'">Save</button><p id="out"></p>
    <script>setInterval(() => { document.getElementById('clock').textContent = Date.now() }, 50)</script>`,
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/app.js') {
    setTimeout(() => {
      res.setHeader('content-type', 'text/javascript')
      res.end(`document.querySelector('button').onclick = () => { document.getElementById('out').textContent = 'Saved' }`)
    }, Number(url.searchParams.get('delay') ?? 0))
    return
  }
  if (url.pathname === '/ping') { res.statusCode = 204; res.end(); return }
  const html = PAGES[url.pathname]
  res.statusCode = html ? 200 : 404
  res.setHeader('content-type', 'text/html')
  res.end(html ?? 'Not found')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

let browser = null
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true })
} catch { /* no Chrome here */ }
after(async () => {
  await browser?.close()
  server.close()
})
const skip = browser ? false : 'Google Chrome is not installed'

const ctx = (readyMs, find = 3000) => ({ base, notFoundText: null, auth: null, timeouts: { find, gone: 3000, signIn: 3000, ready: readyMs } })
const click = (page, c) => perform(page, c, { kind: 'click', target: 'Save', text: 'click "Save"' })
const saved = page => textVisible(page, 'Saved', 1500)

async function open(path) {
  const page = await browser.newContext({ viewport: { width: 800, height: 600 } }).then(c => c.newPage())
  await perform(page, ctx(5000), { kind: 'open', path, text: `open "${path}"` })
  return page
}

test('a click right after navigation waits for a slow bundle, and the report says how long', { skip }, async () => {
  // First, the problem: with no wait the click lands before the script does.
  let page = await open('/slow-bundle')
  const lost = await click(page, ctx(0))
  assert.equal(lost.ok, true, 'the button is visible, so the click itself succeeds')
  assert.equal(await saved(page), false, 'and nothing happens: the click was lost')
  await page.context().close()

  page = await open('/slow-bundle')
  const res = await click(page, ctx(5000))
  assert.equal(res.ok, true)
  assert.equal(await saved(page), true, 'the click landed after the bundle took over')
  assert.match(res.note, /^waited \d\.\ds for the page to be ready$/, `a wait that long is noted (${res.note})`)
  await page.context().close()
})

test('hydration that redraws the page before it listens: the wait outlasts the changes', { skip }, async () => {
  const page = await open('/late-hydrate')
  const res = await click(page, ctx(5000))
  assert.equal(res.ok, true)
  assert.equal(await saved(page), true)
  assert.match(res.note, /^waited \d\.\ds for the page to be ready$/)
  await page.context().close()
})

test('a page that is ready at once is acted on at once, with no note', { skip }, async () => {
  const page = await open('/ready')
  const started = Date.now()
  const res = await click(page, ctx(5000))
  assert.equal(res.ok, true)
  assert.equal(res.note, undefined, 'a short wait is not worth a note')
  assert.ok(Date.now() - started < 2000, 'no long wait on a page with nothing to wait for')
  assert.equal(await saved(page), true)
  await page.context().close()
})

test('a page that keeps the network busy gets a moment, then the screen decides', { skip }, async () => {
  const page = await open('/polling')
  const started = Date.now()
  const res = await click(page, ctx(5000))
  assert.equal(res.ok, true)
  assert.ok(Date.now() - started < 2500, `the network wait is capped, not the whole budget (${Date.now() - started}ms)`)
  assert.match(res.note, /^waited 1\.\ds for the page to be ready; the network stayed busy but the screen was still$/, res.note)
  assert.equal(await saved(page), true)
  await page.context().close()
})

test('a control disabled until the page is ready gets time to become enabled; one that never does is reported', { skip }, async () => {
  let page = await open('/enabled-later')
  const res = await click(page, ctx(5000))
  assert.equal(res.ok, true, res.note)
  assert.equal(await saved(page), true, 'the click landed once the button was enabled')
  await page.context().close()

  page = await open('/never-enabled')
  const started = Date.now()
  const stuck = await click(page, ctx(5000, 1000))
  assert.equal(stuck.ok, false)
  assert.equal(stuck.note, '"Save" is visible but disabled (still disabled after 1s)')
  assert.ok(Date.now() - started >= 1000, 'given the find timeout to become enabled')
  await page.context().close()
})

test('a page that never stops changing is acted on when the budget is spent, and the note says so', { skip }, async () => {
  const page = await open('/ticking')
  const wait = await ready(page, 1200)
  assert.equal(wait.quiet, false)
  assert.ok(wait.waitedMs >= 1200 && wait.waitedMs < 4000, `spent the budget and no more (${wait.waitedMs}ms)`)
  const res = await click(page, ctx(1200))
  assert.equal(res.ok, true)
  assert.match(res.note, /^the screen kept changing for 1\.\ds; acted anyway$/)
  assert.equal(await saved(page), true)
  await page.context().close()
})
