// The run report: one HTML page beside its screenshots, read top to bottom as
// the flow a person went through.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const RESULT_LABEL = {
  pass: ['Pass', 'ok'],
  fail: ['Fail', 'bad'],
  blocked: ['Blocked', 'bad'],
  needs_human: ['Needs a human look', 'warn'],
  not_reviewed: ['Not reviewed', 'mute'],
  error: ['Error', 'bad'],
}
const VERDICT = { pass: 'ok', fail: 'bad', unclear: 'warn' }
const pill = (label, tone) => `<span class="pill ${tone}">${esc(label)}</span>`

export function renderReport({ spec, runId, startedAt, base, records, verdict, result, outcome, usage, notes, recordedSpec }) {
  const byStep = new Map((verdict?.steps ?? []).map(s => [Number(s.n), s]))
  const [resultLabel, resultTone] = RESULT_LABEL[result] ?? [result, 'mute']
  const cost = [usage?.costUsd, verdict?.costUsd].filter(v => typeof v === 'number').reduce((a, b) => a + b, 0)
  const vp = spec.viewportSize

  const steps = records.map(r => {
    const v = byStep.get(r.n)
    const runner = r.status === 'done' ? '' : r.status === 'blocked' ? pill('Blocked', 'bad') : pill('Not run', 'mute')
    return `
    <article class="step" id="step-${r.n}">
      <div class="shot">${r.screenshot
        ? `<a href="${esc(r.screenshot)}" target="_blank"><img src="${esc(r.screenshot)}" alt="Screen after step ${r.n}" loading="lazy"></a><span class="url">${esc(r.url)}</span>`
        : '<div class="noshot">Not run</div>'}</div>
      <div class="body">
        <header><span class="n">${r.n}</span><h3>${esc(r.title)}</h3>${v ? pill(v.verdict, VERDICT[v.verdict] ?? 'mute') : ''}${runner}</header>
        ${r.actions.length ? `<h4>Did</h4><ul class="acts">${r.actions.map(a => `<li class="${a.ok ? '' : 'failed'}"><code>${esc(a.text)}</code>${a.note ? `<span>${esc(a.note)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        <h4>Expected</h4><ul>${r.expect.map(e => `<li>${esc(e)}</li>`).join('') || '<li class="mute">Nothing stated</li>'}</ul>
        ${v ? `<h4>Reviewer saw</h4><p>${esc(v.observed)}</p>${v.reason ? `<p class="mute">${esc(v.reason)}</p>` : ''}` : ''}
      </div>
    </article>`
  }).join('')

  const criteria = (verdict?.criteria ?? []).map(c =>
    `<tr><td>${pill(c.verdict, VERDICT[c.verdict] ?? 'mute')}</td><td>${esc(c.text)}</td><td class="mute">${esc(c.evidence)}</td></tr>`).join('')
  const signals = (verdict?.failure_signals ?? []).map(f =>
    `<tr><td>${f.seen ? pill('Seen', 'bad') : pill('Not seen', 'ok')}</td><td>${esc(f.text)}</td><td class="mute">${esc(f.evidence)}</td></tr>`).join('')
  const issues = (verdict?.other_issues ?? []).map(i =>
    `<li>${pill(i.severity, i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : 'mute')} ${Number.isFinite(Number(i.step)) ? `<a href="#step-${Number(i.step)}">Step ${Number(i.step)}</a> · ` : ''}${esc(i.description)}</li>`).join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title)} · Affidavit</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--sub:#5b6472;--line:#e3e6eb;--ok:#127a45;--ok-bg:#e3f5ea;--bad:#b42318;--bad-bg:#fdecea;--warn:#8a5a00;--warn-bg:#fff4d6;--mute-bg:#eef0f3;--accent:#2a62d9}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--ink:#e8eaee;--sub:#9aa3b2;--line:#2a2f38;--ok:#5ad19a;--ok-bg:#12301f;--bad:#ff8a80;--bad-bg:#3a1512;--warn:#f5c35b;--warn-bg:#352a0e;--mute-bg:#232730;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{max-width:1240px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}h3{font-size:15px;margin:0;flex:1}h4{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);margin:14px 0 4px}
.meta{color:var(--sub);font-size:13px}.meta code{font-size:12px}
.hero{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.hero .grow{flex:1;min-width:260px}.hero p{margin:8px 0 0}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap;text-transform:capitalize}
.pill.big{font-size:15px;padding:6px 14px}
.ok{background:var(--ok-bg);color:var(--ok)}.bad{background:var(--bad-bg);color:var(--bad)}.warn{background:var(--warn-bg);color:var(--warn)}.mute{color:var(--sub)}.pill.mute{background:var(--mute-bg)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
td{padding:9px 12px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:none}td:first-child{width:1%}
.issues{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px 10px 30px;margin:0}.issues li{margin:6px 0}
.step{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 14px}
.shot img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block}.shot .url{display:block;font-size:11px;color:var(--sub);margin-top:4px;word-break:break-all}
.noshot{height:120px;display:grid;place-items:center;border:1px dashed var(--line);border-radius:8px;color:var(--sub)}
.body header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.n{width:24px;height:24px;border-radius:99px;background:var(--mute-bg);display:grid;place-items:center;font-size:12px;font-weight:700;flex:none}
.body ul{margin:0;padding-left:18px}.body p{margin:0 0 4px}
.acts{list-style:none;padding:0!important}.acts li{margin:2px 0}.acts code{font-size:12px;background:var(--mute-bg);padding:1px 6px;border-radius:5px}.acts span{display:block;font-size:12px;color:var(--sub);margin:2px 0 0 4px}.acts li.failed code{background:var(--bad-bg);color:var(--bad)}.acts li.failed span{color:var(--bad)}
a{color:var(--accent)}details{margin-top:28px}pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;font-size:12px;overflow:auto}
@media (max-width:760px){.step{grid-template-columns:1fr}}
</style></head><body><main>
<div class="hero">
  <div class="grow">
    <h1>${esc(spec.title)}</h1>
    <div class="meta">${esc(spec.mode === 'explore' ? 'Explored from a goal' : 'Scripted')} · signed in as <b>${esc(spec.role)}</b> · ${esc(vp.name)} ${vp.width}×${vp.height} · ${esc(startedAt)} · <code>${esc(base)}</code> · run <code>${esc(runId)}</code></div>
    ${spec.goal ? `<p>${esc(spec.goal)}</p>` : ''}
    ${verdict?.summary ? `<p><b>Reviewer:</b> ${esc(verdict.summary)}</p>` : ''}
    ${spec.mode === 'explore' ? `<p class="mute">Explorer ${outcome?.done ? `finished: ${esc(outcome.summary)}` : `did not finish: ${esc(outcome?.reason)}`}</p>` : ''}
  </div>
  <div>${pill(resultLabel, `${resultTone} big`)}</div>
</div>
<p class="meta">Visual-only review: the reviewer saw the spec and these screenshots, nothing else. ${verdict?.model ? `Reviewer model <code>${esc(verdict.model)}</code>.` : ''} ${cost ? `Model cost $${cost.toFixed(4)}.` : ''}</p>
${criteria ? `<h2>Success criteria</h2><table>${criteria}</table>` : ''}
${signals ? `<h2>Failure signals</h2><table>${signals}</table>` : ''}
${issues ? `<h2>Other things the reviewer noticed</h2><ul class="issues">${issues}</ul>` : ''}
<h2>The flow, step by step</h2>
${steps}
${notes.length ? `<h2>Runner notes</h2><ul class="issues">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
${recordedSpec ? `<details><summary>Recorded as a scripted spec (<code>recorded.qa.md</code>)</summary><pre>${esc(recordedSpec)}</pre></details>` : ''}
<p class="meta" style="margin-top:32px">Affidavit — judged on what was seen, nothing else.</p>
</main></body></html>`
}
