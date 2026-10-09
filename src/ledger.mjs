// The ledger: every spec, its latest result, its recent history and the
// latest run's screenshots, on one page. By default the screenshots are
// embedded (compressed to JPEG by the same Chrome that took them), so the page
// can be shared on its own; --links references the local files instead.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { chromium } from 'playwright-core'
import { allSpecs, collectRuns, loadSpec } from './run.mjs'
import { RESULT_LABEL, esc } from './report.mjs'

const HISTORY = 12
const ORDER = { fail: 0, error: 0, blocked: 1, needs_human: 2, not_reviewed: 3, not_run: 4, pass: 5 }

export function buildLedgerModel(config) {
  const runs = collectRuns(config)
  const byId = new Map()
  for (const run of runs) {
    if (!byId.has(run.id)) byId.set(run.id, [])
    byId.get(run.id).push(run)
  }

  const entries = []
  const seen = new Set()
  for (const file of allSpecs(config)) {
    let spec = null
    let parseError = null
    try { spec = loadSpec(file, config) } catch (err) { parseError = err.message }
    const id = spec?.id ?? basename(file, '.qa.md')
    seen.add(id)
    const history = byId.get(id) ?? []
    const latest = history.at(-1) ?? null
    entries.push({
      id, file: relative(config.root, file), spec, parseError, latest, history: history.slice(-HISTORY),
      // The spec was edited after its latest run: that result may no longer hold.
      stale: Boolean(latest && statSync(file).mtime > latest.startedAt),
      result: parseError ? 'error' : latest?.result ?? 'not_run',
    })
  }
  // Runs whose spec file is gone (renamed or deleted) are listed, not dropped.
  for (const [id, history] of byId) {
    if (seen.has(id)) continue
    const latest = history.at(-1)
    entries.push({ id, file: latest.spec, spec: null, parseError: null, latest, history: history.slice(-HISTORY), orphan: true, stale: false, result: latest.result })
  }
  entries.sort((a, b) => (ORDER[a.result] ?? 3) - (ORDER[b.result] ?? 3) || String(a.latest?.title ?? a.spec?.title ?? a.id).localeCompare(String(b.latest?.title ?? b.spec?.title ?? b.id)))
  return { entries, runCount: runs.length }
}

async function compressor(channel) {
  const browser = await chromium.launch({ channel: channel || undefined, headless: true })
  const page = await browser.newPage()
  return {
    async jpeg(path) {
      const b64 = readFileSync(path).toString('base64')
      return page.evaluate(async src => {
        const img = new Image()
        img.src = `data:image/png;base64,${src}`
        await img.decode()
        const w = Math.min(img.naturalWidth, 720)
        const h = Math.round(img.naturalHeight * (w / img.naturalWidth))
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(img, 0, 0, w, h)
        return c.toDataURL('image/jpeg', 0.6)
      }, b64)
    },
    close: () => browser.close(),
  }
}

/** A small Markdown subset for --notes: "## Heading", "- item", **bold**, paragraphs. */
function renderNotes(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  const panels = []
  let panel = null
  let list = null
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    const h = line.match(/^#{1,3}\s+(.+)$/)
    if (h) { panel = { title: h[1], html: [] }; panels.push(panel); list = null; continue }
    if (!panel) { panel = { title: '', html: [] }; panels.push(panel) }
    const li = line.match(/^[-*]\s+(.+)$/)
    if (li) {
      if (!list) { list = []; panel.html.push(list) }
      list.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    list = null
    if (line) panel.html.push(`<p>${inline(line)}</p>`)
  }
  return panels.map(p => `<section class="panel">${p.title ? `<h2>${inline(p.title)}</h2>` : ''}${p.html.map(x => Array.isArray(x) ? `<ul>${x.join('')}</ul>` : x).join('')}</section>`).join('')
}

const when = d => d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const pill = result => {
  const [label, tone] = result === 'not_run' ? ['Not run yet', 'mute'] : RESULT_LABEL[result] ?? [result, 'mute']
  return `<span class="pill ${tone}">${esc(label)}</span>`
}
const VERDICT_TONE = { pass: 'ok', fail: 'bad', unclear: 'warn' }

export async function renderLedger(config, { title, notes, links, outFile }) {
  const { entries, runCount } = buildLedgerModel(config)
  const images = links ? null : await compressor(config.browser.channel)
  const outDir = outFile ? join(outFile, '..') : config.runsDir

  const shot = async (run, step) => {
    if (!step.screenshot) return '<div class="noimg">Not run</div>'
    const path = join(run.dir, step.screenshot)
    if (!existsSync(path)) return '<div class="noimg">Screenshot missing</div>'
    const src = images ? await images.jpeg(path) : relative(outDir, path)
    return `<img loading="lazy" src="${esc(src)}" alt="Screen after step ${step.n}">`
  }

  const tally = { pass: 0, fail: 0, blocked: 0, needs_human: 0, not_run: 0 }
  const cards = []
  const retired = []
  try {
    for (const e of entries) {
      const bucket = e.result === 'error' || e.result === 'not_reviewed' ? 'fail' : e.result
      if (!e.orphan && bucket in tally) tally[bucket]++
      const run = e.latest
      const specTitle = run?.title ?? e.spec?.title ?? e.id
      const role = run?.role ?? e.spec?.role ?? ''
      const vp = run?.viewport?.name ?? e.spec?.viewportSize?.name ?? ''
      const goal = run?.goal ?? e.spec?.goal ?? ''
      const dots = e.history.map(h => `<span class="dot ${esc(h.result)}" title="${esc(`${when(h.startedAt)} · ${(RESULT_LABEL[h.result] ?? [h.result])[0]}`)}"></span>`).join('')

      let body = ''
      if (e.parseError) body += `<pre class="err">${esc(e.parseError)}</pre>`
      if (goal) body += `<p class="goal">${esc(goal)}</p>`
      if (e.orphan) body += '<p class="note">This spec file no longer exists; showing its last run.</p>'
      if (e.stale) body += '<p class="note">The spec was edited after this run, so this result may no longer hold. Run it again.</p>'
      if (run) {
        const verdict = run.verdict
        if (verdict?.summary) body += `<p><b>Reviewer:</b> ${esc(verdict.summary)}</p>`
        if (run.mode === 'explore' && run.outcome) body += `<p class="${run.outcome.done ? '' : 'stuck'}"><b>Explorer:</b> ${esc(run.outcome.done ? run.outcome.summary : run.outcome.reason)}</p>`
        body += `<div class="path"><span>Full report</span><code class="copy" tabindex="0" role="button" title="Copy">open "${esc(join(run.dir, 'report.html'))}"</code></div>`
        const crit = verdict?.criteria ?? []
        if (crit.length) body += `<h4>Success criteria</h4><ul class="crit">${crit.map(c => `<li><span class="pill v ${VERDICT_TONE[c.verdict] ?? 'mute'}">${esc(c.verdict)}</span><span>${esc(c.text)}${c.evidence ? `<span class="obs">${esc(c.evidence)}</span>` : ''}</span></li>`).join('')}</ul>`
        const issues = verdict?.other_issues ?? []
        if (issues.length) body += `<h4>Also noticed</h4><ul class="crit">${issues.map(i => `<li><span class="pill v ${i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : 'mute'}">${esc(i.severity)}</span><span>${Number.isFinite(Number(i.step)) ? `Step ${Number(i.step)} · ` : ''}${esc(i.description)}</span></li>`).join('')}</ul>`
        const byStep = new Map((verdict?.steps ?? []).map(s => [Number(s.n), s]))
        const steps = []
        for (const s of run.steps ?? []) {
          const v = byStep.get(s.n)
          const tone = v?.verdict ?? (s.status === 'blocked' ? 'fail' : s.status === 'not_run' ? '' : '')
          steps.push(`<li class="step ${tone === 'fail' ? 'step--fail' : ''}">
  <div class="step__text"><div class="step__head">${v ? `<span class="pill v ${VERDICT_TONE[v.verdict] ?? 'mute'}">${esc(v.verdict)}</span>` : s.status === 'blocked' ? '<span class="pill v bad">blocked</span>' : s.status === 'not_run' ? '<span class="pill v mute">not run</span>' : ''}<span class="step__n">Step ${s.n}</span><span class="step__t">${esc(s.title)}</span></div>
  ${s.actions?.length ? `<ul class="acts">${s.actions.map(a => `<li class="${a.ok ? '' : 'bad'}"><code>${esc(a.text)}</code>${a.ok ? '' : ` ${esc(a.note)}`}</li>`).join('')}</ul>` : ''}
  <ul class="exps">${(s.expect ?? []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
  ${v?.observed ? `<p class="obs"><b>Seen:</b> ${esc(v.observed)}</p>` : ''}${v?.verdict !== 'pass' && v?.reason ? `<p class="obs"><b>Why:</b> ${esc(v.reason)}</p>` : ''}</div>
  <figure class="shot">${await shot(run, s)}</figure></li>`)
        }
        if (steps.length) body += `<ol class="steps">${steps.join('')}</ol>`
      } else if (!e.parseError) {
        body += '<p class="note">This spec has never been run.</p>'
      }

      ;(e.orphan ? retired : cards).push(`<details class="spec" data-result="${esc(e.result === 'error' || e.result === 'not_reviewed' ? 'fail' : e.result)}"${e.stale ? ' data-stale="1"' : ''} id="${esc(e.id)}">
<summary><span>${pill(e.result)}</span><span class="spec__name"><b>${esc(specTitle)}</b><code>${esc(e.file ?? e.id)}</code></span>
<span class="spec__meta">${role ? `<span class="chip">${esc(role)}</span>` : ''}${vp ? `<span class="chip">${esc(vp)}</span>` : ''}${(run?.mode ?? e.spec?.mode) === 'explore' ? '<span class="chip">explore</span>' : ''}${e.stale ? '<span class="chip warnchip">changed since run</span>' : ''}${run ? `<span class="when">${esc(when(run.startedAt))}</span>` : ''}<span class="hist" aria-label="Recent runs">${dots}</span></span></summary>
<div class="spec__body">${body}</div></details>`)
    }
  } finally {
    await images?.close()
  }

  const project = title
  const generated = new Date().toLocaleString()
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project)}</title>
<style>
:root{--ground:#f3f5f8;--surface:#fff;--sunken:#eaeef3;--line:#d9e0e8;--ink:#17202b;--ink-2:#4a5566;--ink-3:#6b7585;--accent:#1d6fa5;--accent-soft:#e3eff8;--ok:#17774d;--ok-bg:#e2f3ea;--bad:#b3361f;--bad-bg:#fbe7e2;--warn:#8f5a00;--warn-bg:#fbf0d9;--mute:#5b6472;--mute-bg:#eceff3;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0f141a;--surface:#161d25;--sunken:#1d2630;--line:#2a3542;--ink:#e7ecf2;--ink-2:#b3bdc9;--ink-3:#8b96a4;--accent:#6cb2e4;--accent-soft:#16304a;--ok:#5fcf98;--ok-bg:#143426;--bad:#f08a74;--bad-bg:#3a1c16;--warn:#e8b660;--warn-bg:#352812;--mute:#a3adba;--mute-bg:#222b36}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 var(--sans);padding:28px 16px 64px}
.wrap{max-width:1080px;margin:0 auto;display:grid;gap:24px}
h1,h2,h4{margin:0}h1{font-size:clamp(24px,4vw,32px);letter-spacing:-.02em}h2{font-size:17px}h4{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-top:8px}
code{font:12.5px/1.5 var(--mono)}
.eyebrow{font:600 12px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
header{display:grid;gap:8px}header p{margin:0;color:var(--ink-2);max-width:70ch}
.tally{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tally div{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:grid;gap:2px}
.tally b{font:700 26px/1.1 var(--sans);font-variant-numeric:tabular-nums}.tally span{font-size:13px;color:var(--ink-3)}
.t-ok b{color:var(--ok)}.t-bad b{color:var(--bad)}.t-warn b{color:var(--warn)}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:grid;gap:8px;align-content:start}.panel ul{margin:0;padding-left:18px;display:grid;gap:6px}.panel p{margin:0}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
.filters{display:flex;flex-wrap:wrap;gap:6px}
.filters button{font:500 13px/1 var(--sans);color:var(--ink-2);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:8px 13px;cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--ink);color:var(--surface);border-color:var(--ink)}
.specs{display:grid;gap:8px}
.spec{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.spec[data-result="fail"],.spec[data-result="blocked"]{border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}
summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 16px}
summary::-webkit-details-marker{display:none}
.spec__name{display:grid;min-width:0}.spec__name b{font-weight:600;overflow-wrap:anywhere}.spec__name code{color:var(--ink-3);font-size:12px;overflow-wrap:anywhere}
.spec__meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end}
.chip{font:500 12px/1 var(--sans);color:var(--ink-2);background:var(--sunken);border-radius:6px;padding:5px 7px}.warnchip{background:var(--warn-bg);color:var(--warn)}
.when{font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.hist{display:inline-flex;gap:3px}.dot{width:8px;height:8px;border-radius:2px;background:var(--mute)}
.dot.pass{background:var(--ok)}.dot.fail,.dot.blocked,.dot.error{background:var(--bad)}.dot.needs_human{background:var(--warn)}
.pill{display:inline-block;font:600 11.5px/1 var(--sans);border-radius:999px;padding:5px 9px;white-space:nowrap}.pill.v{text-transform:capitalize}
.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.bad{color:var(--bad);background:var(--bad-bg)}.pill.warn{color:var(--warn);background:var(--warn-bg)}.pill.mute{color:var(--mute);background:var(--mute-bg)}
.spec__body{border-top:1px solid var(--line);padding:16px;display:grid;gap:10px}.spec__body>p{margin:0}
.goal{color:var(--ink-2)}.note{background:var(--warn-bg);border-radius:8px;padding:9px 12px;font-size:14px}.stuck{color:var(--bad)}
.err{white-space:pre-wrap;background:var(--bad-bg);color:var(--bad);border-radius:8px;padding:10px;margin:0;font:12.5px/1.5 var(--mono)}
.path{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px;color:var(--ink-3)}
.copy{background:var(--sunken);border-radius:6px;padding:4px 8px;cursor:pointer;overflow-wrap:anywhere;color:var(--ink)}.copy.done::after{content:" · copied";color:var(--ok)}
.crit{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:14px}.crit li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start}
.obs{display:block;margin:2px 0 0;font-size:13.5px;color:var(--ink-2)}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.step{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,300px);gap:14px;padding:12px;border-radius:10px;background:var(--sunken)}.step--fail{background:var(--bad-bg)}
.step__text{display:grid;gap:6px;align-content:start;min-width:0}.step__head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.step__n{font:500 12px/1 var(--mono);color:var(--ink-3)}.step__t{font-weight:600}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}.acts code{background:var(--surface);border-radius:5px;padding:2px 6px;font-size:11.5px;color:var(--ink-2)}.acts li.bad{color:var(--bad);font-size:12.5px}.acts li.bad code{color:var(--bad);outline:1px solid var(--bad)}
.exps{margin:0;padding-left:18px;font-size:13.5px;display:grid;gap:3px}
.shot{margin:0}.shot img{display:block;max-width:100%;border-radius:8px;border:1px solid var(--line);background:var(--surface)}
.retired>summary{display:block;padding:10px 4px;color:var(--ink-3);font-size:14px}.retired>summary::before{content:'▸ '}.retired[open]>summary::before{content:'▾ '}
.noimg{font-size:12px;color:var(--ink-3);padding:24px;text-align:center;border:1px dashed var(--line);border-radius:8px}
footer{font-size:13px;color:var(--ink-3)}
@media (max-width:720px){summary{grid-template-columns:auto minmax(0,1fr)}.spec__meta{grid-column:1/-1;justify-content:flex-start}.step{grid-template-columns:minmax(0,1fr)}.shot{max-width:260px}}
</style></head><body>
<div class="wrap">
<header>
  <span class="eyebrow">Affidavit · visual QA</span>
  <h1>${esc(project)}</h1>
  <p>Every spec, the latest result for each and its recent history. A spec is a written flow: who signs in, which screen size, the steps, and what a person should see. A browser performs the steps by what is visible on screen, and a reviewer that sees only the screenshots judges each one. Generated ${esc(generated)}.</p>
</header>
<section class="tally" aria-label="Summary">
  <div class="t-ok"><b>${tally.pass}</b><span>passing</span></div>
  <div class="t-bad"><b>${tally.fail}</b><span>failing</span></div>
  <div class="t-bad"><b>${tally.blocked}</b><span>blocked</span></div>
  <div class="t-warn"><b>${tally.needs_human}</b><span>need a person</span></div>
  <div><b>${tally.not_run}</b><span>not run yet</span></div>
  <div><b>${entries.length - retired.length}</b><span>specs</span></div>
  <div><b>${runCount}</b><span>runs recorded</span></div>
</section>
${notes ? `<div class="panels">${renderNotes(notes)}</div>` : ''}
<section style="display:grid;gap:12px">
  <div class="bar"><h2>Specs</h2>
    <div class="filters" role="group" aria-label="Filter specs">
      <button type="button" data-f="all" aria-pressed="true">All</button>
      <button type="button" data-f="fail" aria-pressed="false">Failing</button>
      <button type="button" data-f="blocked" aria-pressed="false">Blocked</button>
      <button type="button" data-f="needs_human" aria-pressed="false">Needs a person</button>
      <button type="button" data-f="pass" aria-pressed="false">Passing</button>
      <button type="button" data-f="not_run" aria-pressed="false">Not run</button>
      <button type="button" data-f="stale" aria-pressed="false">Changed since run</button>
    </div>
  </div>
  <div class="specs">${cards.join('\n')}</div>
  ${retired.length ? `<details class="retired"><summary>${retired.length} spec${retired.length === 1 ? '' : 's'} no longer in the specs folder (renamed, deleted or temporary). Last runs kept for the record, not counted above.</summary><div class="specs">${retired.join('\n')}</div></details>` : ''}
</section>
<footer>Affidavit — judged on what was seen, nothing else. Screenshots ${links ? 'are linked from the local run folders' : 'are embedded and compressed'}.</footer>
</div>
<script>
document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.filters button').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
  const f = b.dataset.f
  document.querySelectorAll('.spec').forEach(s => {
    s.hidden = !(f === 'all' || (f === 'stale' ? s.dataset.stale === '1' : s.dataset.result === f))
  })
}))
document.querySelectorAll('.copy').forEach(c => c.addEventListener('click', () => {
  navigator.clipboard?.writeText(c.textContent).then(() => { c.classList.add('done'); setTimeout(() => c.classList.remove('done'), 1500) }).catch(() => {})
}))
</script>
</body></html>`
}

export async function writeLedger(config, { title, notesFile, links, out }) {
  const outFile = out ?? join(config.runsDir, 'ledger.html')
  const notes = notesFile ? readFileSync(notesFile, 'utf8') : null
  const html = await renderLedger(config, { title, notes, links, outFile })
  writeFileSync(outFile, html)
  return { outFile, bytes: Buffer.byteLength(html) }
}
