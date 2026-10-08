// The independent reviewer — the witness. It gets the spec and the screenshots,
// nothing else, and testifies only to what the pictures show. It never saw the
// code, the diff or the explorer's reasoning, so it cannot grade what was meant
// instead of what is on screen.

import { chat, modelFor } from './backends/index.mjs'
import { image, parseJson, text } from './backends/parts.mjs'

const SYSTEM = `You are a QA reviewer for a web app. You see ONLY screenshots, one taken after each step.
You have no source code, no logs, no database and no network traffic. Judge only what is visible.

For every step, compare its "Expected" lines with that step's screenshot:
- "pass"    — the screenshot clearly shows every expectation.
- "fail"    — the screenshot contradicts an expectation, or shows an error.
- "unclear" — the screenshot cannot show it (off screen, already gone, too small). Never guess "pass".
A step the runner could not finish ("blocked") is judged on what its screenshot shows about why.

Then judge each success criterion across all screenshots, and say whether any failure signal is visible.
Also report other problems a careful person would notice even if the spec did not ask:
overlapping or cut-off text, broken layout, raw error text or codes, unformatted numbers or dates,
typos, contradictory figures, controls that look enabled but should not be, or the reverse.

Quote on-screen text exactly when you cite it. Reply with JSON only:
{
  "steps": [{"n": 0, "verdict": "pass|fail|unclear", "observed": "what the screenshot shows", "reason": "why this verdict"}],
  "criteria": [{"text": "<criterion>", "verdict": "pass|fail|unclear", "evidence": "which steps, what is seen"}],
  "failure_signals": [{"text": "<signal>", "seen": true, "evidence": "step and what is seen"}],
  "other_issues": [{"severity": "high|medium|low", "step": 0, "description": "..."}],
  "summary": "two or three sentences a product owner can read"
}`

export async function review({ spec, records, outcome, today, backend }) {
  const intro = [
    `Scenario: ${spec.title}`,
    `Today's date: ${today}`,
    spec.signedIn ? `Signed in as: ${spec.role}` : `Signed in as: nobody${spec.role && spec.role !== 'none' ? ` (the app has no sign-in; the user is described as "${spec.role}")` : ' (signed out)'}`,
    `Screen size: ${spec.viewportSize.width}×${spec.viewportSize.height} (${spec.viewportSize.name})`,
    spec.goal ? `Goal: ${spec.goal}` : '',
    spec.preconditions.length ? `Preconditions:\n${spec.preconditions.map(p => `- ${p}`).join('\n')}` : '',
    spec.mode === 'explore'
      ? `These steps were chosen by an exploring tester, not written in advance. Its final word: ${outcome?.done ? `finished — ${outcome.summary}` : `did not finish — ${outcome?.reason}`}`
      : '',
  ].filter(Boolean).join('\n\n')

  const content = [text(intro)]
  for (const r of records) {
    const actions = r.actions.length
      ? r.actions.map(a => `  - ${a.text}${a.ok ? '' : `  → FAILED: ${a.note}`}`).join('\n')
      : '  (none)'
    content.push(text([
      `Step ${r.n} — ${r.title}`,
      `Actions:\n${actions}`,
      `Runner: ${r.status === 'done' ? 'completed' : r.status === 'blocked' ? `blocked — ${r.error}` : 'not run (an earlier step was blocked)'}`,
      `Expected:\n${r.expect.map(e => `  - ${e}`).join('\n') || '  (nothing stated)'}`,
      r.png ? 'Screenshot after this step:' : 'No screenshot (step not run).',
    ].join('\n')))
    if (r.png) content.push(image(r.png))
  }
  content.push(text([
    `Success criteria:\n${spec.successCriteria.map(c => `- ${c}`).join('\n')}`,
    spec.failureSignals.length ? `Failure signals:\n${spec.failureSignals.map(c => `- ${c}`).join('\n')}` : 'Failure signals: none listed.',
    spec.outOfScope.length ? `Out of scope (do not judge):\n${spec.outOfScope.map(c => `- ${c}`).join('\n')}` : '',
    'Now give your verdicts as JSON.',
  ].filter(Boolean).join('\n\n')))

  let reply
  let verdict
  for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
    reply = await chat(backend, 'review', { system: SYSTEM, content, maxTokens: 6000 })
    try { verdict = parseJson(reply.text) } catch { /* ask once more */ }
  }
  if (!verdict) throw new Error(`The reviewer did not return readable JSON: ${reply.text.slice(0, 300)}`)
  return { ...verdict, model: reply.model ?? modelFor(backend, 'review'), costUsd: reply.costUsd }
}

/**
 * The overall result is computed here, never taken from the model: any fail is
 * a fail, a step the runner could not finish is blocked, any "unclear" needs a
 * human, and only then is it a pass.
 */
export function overall(records, verdict, outcome) {
  if (verdict) {
    const fails = (verdict.steps ?? []).some(s => s.verdict === 'fail')
      || (verdict.criteria ?? []).some(c => c.verdict === 'fail')
      || (verdict.failure_signals ?? []).some(f => f.seen)
      || (verdict.other_issues ?? []).some(i => i.severity === 'high')
    if (fails) return 'fail'
  }
  if (records.some(r => r.status === 'blocked') || outcome?.stuck) return 'blocked'
  if (!verdict) return 'not_reviewed'
  const unclear = (verdict.steps ?? []).some(s => s.verdict !== 'pass')
    || (verdict.criteria ?? []).some(c => c.verdict !== 'pass')
  return unclear ? 'needs_human' : 'pass'
}
