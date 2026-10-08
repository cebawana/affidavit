// Runs a spec's steps and records what happened: each action's outcome and one
// screenshot of the screen after the step. Scripted mode runs the written
// steps; explore mode asks a vision model for the next step each turn.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loginFormVisible, perform, settle, signInSteps } from './browser.mjs'
import { saveSession } from './session.mjs'
import { ACTION_VOCABULARY, parseAction } from './spec.mjs'
import { chat } from './backends/index.mjs'
import { image, parseJson, text } from './backends/parts.mjs'

async function shoot(page, dir, n) {
  const file = `step-${String(n).padStart(2, '0')}.png`
  const png = await page.screenshot({ type: 'png' })
  writeFileSync(join(dir, file), png)
  return { file, png }
}

/** Performs actions in order; stops at the first one that could not be done. */
async function performAll(page, ctx, steps, actions) {
  for (const action of steps) {
    const res = await perform(page, ctx, action)
    actions.push({ text: action.text, ok: res.ok, note: res.note })
    if (!res.ok) return res.note
  }
  return null
}

async function runOne(page, ctx, dir, n, step) {
  const actions = []
  const error = await performAll(page, ctx, step.actions, actions)
  await settle(page)
  const shot = await shoot(page, dir, n)
  return { n, title: step.title, actions, expect: step.expect, status: error ? 'blocked' : 'done', error: error ?? undefined, screenshot: shot.file, png: shot.png, url: page.url() }
}

const openAction = path => ({ kind: 'open', path, text: `open "${path}"` })

/**
 * Step 0: sign in and open the start page, so every run begins the same way.
 *
 * With a saved session for the role, the browser starts already signed in and
 * only opens the start page — then looks: if the sign-in screen is showing,
 * the session has expired, so it signs in through the form as usual and the
 * saved session is refreshed. Either way step 0 stays in the report with a
 * screenshot, so the reviewer sees the app signed in (or not).
 */
async function setup(page, ctx, dir, spec, creds, session) {
  if (!creds) {
    if (!spec.start) return null
    return runOne(page, ctx, dir, 0, { title: `Open ${spec.start}`, actions: [openAction(spec.start)], expect: ['The page opens.'] })
  }
  const actions = []
  let error = null
  let reused = false
  if (session?.saved) {
    error = await performAll(page, ctx, [openAction(spec.start || '/')], actions)
    if (!error) {
      await settle(page)
      if (await loginFormVisible(page, ctx.auth)) {
        actions.at(-1).note = `the saved ${spec.role} session had expired (the sign-in screen appeared), so the browser signs in again`
      } else {
        reused = true
        actions.at(-1).note = `already signed in as ${spec.role} from the saved session`
      }
    }
  }
  if (!error && !reused) {
    error = await performAll(page, ctx, signInSteps(ctx.auth, creds, spec.start, ctx.timeouts.signIn), actions)
    if (!error && session) await saveSession(page, session)
  }
  await settle(page)
  const shot = await shoot(page, dir, 0)
  const opened = spec.start ? (reused ? `, open ${spec.start}` : ` and open ${spec.start}`) : ''
  return {
    n: 0,
    title: reused ? `Signed in as ${spec.role} (saved session)${opened}` : `Sign in as ${spec.role}${opened}`,
    actions, expect: ['The app is shown signed in — no login form is visible.'],
    status: error ? 'blocked' : 'done', error: error ?? undefined, screenshot: shot.file, png: shot.png, url: page.url(),
  }
}

/** @param {{ page, ctx, dir, spec, creds, session, log }} args */
export async function runScripted({ page, ctx, dir, spec, creds, session, log }) {
  const records = []
  const first = await setup(page, ctx, dir, spec, creds, session)
  if (first) {
    records.push(first)
    log(`  0. ${first.title} — ${first.status}${first.error ? `: ${first.error}` : ''}`)
    if (first.status !== 'done') return records
  }
  let blocked = false
  for (const [i, step] of spec.steps.entries()) {
    const n = i + 1
    if (blocked) { records.push({ n, title: step.title, actions: [], expect: step.expect, status: 'not_run' }); continue }
    const rec = await runOne(page, ctx, dir, n, step)
    records.push(rec)
    log(`  ${n}. ${step.title} — ${rec.status}${rec.error ? `: ${rec.error}` : ''}`)
    blocked = rec.status === 'blocked'
  }
  return records
}

const EXPLORER_SYSTEM = `You are testing a web app by using it, exactly like a new user.
You can see ONLY the screenshot. You have no source code, no page markup, no logs.

Each turn, choose ONE action that moves toward the goal, written in this exact vocabulary:
${ACTION_VOCABULARY.map(a => `  ${a}`).join('\n')}

Rules:
- Quote text exactly as it appears on screen. For an icon-only button, use the name a tooltip or screen reader would give it (e.g. "Edit Coffee receipt", "Close").
- "open" is only for a page address a user would type or bookmark; prefer clicking.
- If your last action failed, try a different way — do not repeat it unchanged.
- Column headings of a table are not form fields. Only fill a field you can see an input box for.
- If a menu or page does not offer what you need, go back and look elsewhere (the navigation, the item's own page).
- Never enter real personal data. Invent obvious test values.
- Stop with done=true as soon as the goal is visibly complete on screen.
- Stop with stuck=true if you cannot find a way forward — that is a useful result, not a failure on your part.

Reply with JSON only, one of:
{"intent": "short step title", "action": "<one action>", "expect": "what should be visible after it"}
{"done": true, "summary": "what on screen shows the goal is complete"}
{"stuck": true, "reason": "what you looked for and could not find"}`

/** @param {{ page, ctx, dir, spec, creds, session, log, backend, maxTurns }} args */
export async function runExplore({ page, ctx, dir, spec, creds, session, log, backend, maxTurns }) {
  const records = []
  const usage = { costUsd: 0, calls: 0 }
  let current = null

  const first = await setup(page, ctx, dir, spec, creds, session)
  if (first) {
    records.push(first)
    log(`  0. ${first.title} — ${first.status}${first.error ? `: ${first.error}` : ''}`)
    if (first.status !== 'done') return { records, outcome: { stuck: true, reason: first.error }, usage }
    current = first.png
  } else {
    await settle(page)
    current = await page.screenshot({ type: 'png' })
  }

  const history = []
  const tried = new Map()
  let outcome = { stuck: true, reason: `Reached the ${maxTurns}-turn limit without finishing` }
  for (let turn = 1; turn <= maxTurns; turn++) {
    const brief = [
      `Goal: ${spec.goal}`,
      spec.successCriteria.length ? `Done means:\n${spec.successCriteria.map(c => `- ${c}`).join('\n')}` : '',
      spec.outOfScope.length ? `Do not do:\n${spec.outOfScope.map(c => `- ${c}`).join('\n')}` : '',
      history.length ? `What you have done so far:\n${history.join('\n')}` : 'You have not done anything yet.',
      'This is the screen right now:',
    ].filter(Boolean).join('\n\n')

    let decision
    let lastError
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {
      try {
        const reply = await chat(backend, 'explore', { system: EXPLORER_SYSTEM, content: [text(brief), image(current)], maxTokens: 2000 })
        usage.calls++
        if (reply.costUsd !== null) usage.costUsd += reply.costUsd
        decision = parseJson(reply.text)
      } catch (err) {
        lastError = err
      }
    }
    if (!decision) {
      outcome = { stuck: true, reason: `Explorer model error: ${lastError?.message}` }
      break
    }

    if (decision.done) { outcome = { done: true, summary: decision.summary }; log(`  ✓ explorer: ${decision.summary}`); break }
    if (decision.stuck) { outcome = { stuck: true, reason: decision.reason }; log(`  ✗ explorer stuck: ${decision.reason}`); break }

    const action = parseAction(String(decision.action ?? ''))
    if (!action) {
      history.push(`${turn}. "${decision.action}" — not a valid action; use the vocabulary exactly`)
      continue
    }
    // Going in circles is a finding in itself: the UI did not show the way.
    const tries = (tried.get(action.text) ?? 0) + 1
    tried.set(action.text, tries)
    if (tries > 3) {
      outcome = { stuck: true, reason: `Kept returning to ${action.text} without progress — the way forward was not visible` }
      log(`  ✗ explorer is going in circles: ${action.text}`)
      break
    }
    const rec = await runOne(page, ctx, dir, records.length, {
      title: String(decision.intent ?? action.text), actions: [action], expect: decision.expect ? [String(decision.expect)] : [],
    })
    records.push(rec)
    current = rec.png
    history.push(`${turn}. ${action.text} — ${rec.status === 'done' ? 'ok' : `FAILED: ${rec.error}`}${tries > 1 ? ` (you have now done this ${tries} times — if it did not help, look somewhere else)` : ''}`)
    log(`  ${rec.n}. ${rec.title} → ${action.text} — ${rec.status}${rec.error ? `: ${rec.error}` : ''}`)
  }
  return { records, outcome, usage }
}
