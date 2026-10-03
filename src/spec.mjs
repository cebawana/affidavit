// Parses a `*.qa.md` spec and refuses one that leaks the codebase into QA.
//
// A spec is written in the words a user sees on screen. The reviewer reads it
// next to the screenshots and nothing else, so a selector, an API route or a
// file name in here would hand it knowledge the screen does not give it.
//
// Two modes, decided by the spec itself:
//   scripted — it has "## Steps"; the executor runs them exactly.
//   explore  — it has only a "## Goal"; an agent looks at the screen and
//              works out the steps, which are then saved as a scripted spec.

const SECTION_KEYS = {
  'goal': 'goal',
  'preconditions': 'preconditions',
  'steps': 'steps',
  'success criteria': 'successCriteria',
  'failure signals': 'failureSignals',
  'out of scope': 'outOfScope',
}

// Things only someone reading the code would write. Projects add their own
// vocabulary (a database vendor, a permission scheme) through `leakTerms`.
const CORE_LEAKS = [
  [/data-testid|aria-[a-z]+=|\[role=|xpath|querySelector/i, 'a DOM selector'],
  [/\/api\//i, 'an API route'],
  [/\b[\w/-]+\.(tsx?|mjs|cjs|jsx|vue|svelte|php|rb|py|sql|css|scss)\b/i, 'a source file name'],
  [/\b(select|insert|update|delete)\(/i, 'a code call'],
  [/status code|\bhttp \d{3}\b|console\.|network tab/i, 'a network or console detail'],
  [/\b[a-z]+\.[a-z_]+\b(?= capability| permission)/i, 'a permission name'],
]

function projectLeaks(terms = []) {
  return terms.map(t => {
    const regex = t.match(/^\/(.+)\/([a-z]*)$/)
    const re = regex
      ? new RegExp(regex[1], regex[2].includes('i') ? regex[2] : `${regex[2]}i`)
      : new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return [re, 'a project-internal term']
  })
}

/**
 * @param {string} text  the spec file's contents
 * @param {string} file  a name for error messages
 * @param {{ leakTerms?: string[] }} [options]
 */
export function parseSpec(text, file = 'spec', options = {}) {
  const errors = []
  const normalized = text.replace(/\r\n/g, '\n')
  const fm = normalized.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) throw new Error(`${file}: missing the --- front matter block`)

  const meta = {}
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (m) meta[m[1]] = m[2].trim()
  }
  for (const key of ['id', 'title', 'role']) if (!meta[key]) errors.push(`front matter needs "${key}"`)

  const spec = {
    ...meta,
    file,
    goal: '', preconditions: [], steps: [], successCriteria: [], failureSignals: [], outOfScope: [],
  }

  let section = null
  let step = null
  for (const raw of normalized.slice(fm[0].length).split('\n')) {
    const line = raw.trimEnd()
    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      section = SECTION_KEYS[h2[1].trim().toLowerCase()] ?? null
      step = null
      continue
    }
    if (section === 'steps') {
      const h3 = line.match(/^###\s+(?:\d+[.)]\s*)?(.+)$/)
      if (h3) {
        step = { title: h3[1].trim(), actions: [], expect: [] }
        spec.steps.push(step)
        continue
      }
      const item = line.match(/^\s*-\s*(do|expect):\s*(.+)$/i)
      if (item && step) {
        if (item[1].toLowerCase() === 'do') {
          const action = parseAction(item[2].trim())
          if (!action) errors.push(`step "${step.title}": cannot read the action "${item[2].trim()}"`)
          else step.actions.push(action)
        } else step.expect.push(item[2].trim())
      }
      continue
    }
    if (!section) continue
    if (section === 'goal') { if (line.trim()) spec.goal += (spec.goal ? ' ' : '') + line.trim(); continue }
    const bullet = line.match(/^\s*-\s+(.+)$/)
    if (bullet) spec[section].push(bullet[1].trim())
  }

  spec.mode = spec.steps.length > 0 ? 'scripted' : 'explore'
  if (spec.mode === 'explore' && !spec.goal) errors.push('needs either "## Steps" or a "## Goal" to explore')
  for (const s of spec.steps) if (s.expect.length === 0) errors.push(`step "${s.title}" has no "- expect:" line`)
  if (spec.successCriteria.length === 0) errors.push('no "## Success criteria"')

  for (const [re, what] of [...CORE_LEAKS, ...projectLeaks(options.leakTerms)]) {
    const hit = normalized.match(re)
    if (hit) errors.push(`mentions ${what} ("${hit[0]}") — specs describe only what is visible on screen`)
  }

  if (errors.length) throw new Error(`${file}:\n  - ${errors.join('\n  - ')}`)
  return spec
}

// The action vocabulary. Every target is text a user can see — or, for an
// icon-only button, the name it announces (its tooltip / screen-reader label).
export const ACTION_VOCABULARY = [
  'open "/path"',
  'click "Text"',
  'click "Text" near "Other visible text"',
  'fill "Field label or placeholder" with "value"',
  'select "Field label" option "Option text"',
  'check "Checkbox label"',
  'uncheck "Checkbox label"',
  'press "Escape"',
  'wait for "Text"',
  'wait until gone "Text"',
  'scroll to "Text"',
  'reload',
]

const ACTIONS = [
  [/^open\s+"([^"]+)"$/i, m => ({ kind: 'open', path: m[1] })],
  [/^click\s+"([^"]+)"\s+near\s+"([^"]+)"$/i, m => ({ kind: 'click', target: m[1], near: m[2] })],
  [/^click\s+"([^"]+)"$/i, m => ({ kind: 'click', target: m[1] })],
  [/^fill\s+"([^"]+)"\s+with\s+"([^"]*)"$/i, m => ({ kind: 'fill', target: m[1], value: m[2] })],
  [/^select\s+"([^"]+)"\s+option\s+"([^"]+)"$/i, m => ({ kind: 'select', target: m[1], value: m[2] })],
  [/^check\s+"([^"]+)"$/i, m => ({ kind: 'check', target: m[1] })],
  [/^uncheck\s+"([^"]+)"$/i, m => ({ kind: 'uncheck', target: m[1] })],
  [/^press\s+"([^"]+)"$/i, m => ({ kind: 'press', key: m[1] })],
  [/^wait for\s+"([^"]+)"$/i, m => ({ kind: 'waitFor', target: m[1] })],
  [/^wait until gone\s+"([^"]+)"$/i, m => ({ kind: 'waitGone', target: m[1] })],
  [/^scroll to\s+"([^"]+)"$/i, m => ({ kind: 'scrollTo', target: m[1] })],
  [/^reload$/i, () => ({ kind: 'reload' })],
]

/** One action line → an action object, or null when it is not in the vocabulary. */
export function parseAction(text) {
  const clean = text.trim().replace(/^`|`$/g, '')
  for (const [re, build] of ACTIONS) {
    const m = clean.match(re)
    if (m) return { ...build(m), text: clean }
  }
  return null
}

/** Replaces {run} and {today} in every string of the spec. */
export function bindVariables(spec, vars) {
  const sub = s => s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all))
  const walk = v => typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
  return walk(spec)
}

/** A run's steps written back out as a scripted spec (explore → regression). */
export function toSpecMarkdown(spec, steps) {
  const lines = [
    '---',
    `id: ${spec.id}-recorded`,
    `title: ${spec.title}`,
    `role: ${spec.role}`,
    ...(spec.viewport ? [`viewport: ${spec.viewport}`] : []),
    ...(spec.start ? [`start: ${spec.start}`] : []),
    '---',
    '',
    '<!-- Recorded from an exploration run. Read every step before keeping it:',
    '     the explorer may have taken a detour a scripted test should not. -->',
    '',
    '## Goal',
    spec.goal,
    '',
  ]
  const list = (title, items) => { if (items.length) lines.push(`## ${title}`, ...items.map(i => `- ${i}`), '') }
  list('Preconditions', spec.preconditions)
  lines.push('## Steps', '')
  steps.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.title}`, ...s.actions.map(a => `- do: ${a.text}`), ...s.expect.map(e => `- expect: ${e}`), '')
  })
  list('Success criteria', spec.successCriteria)
  list('Failure signals', spec.failureSignals)
  list('Out of scope', spec.outOfScope)
  return lines.join('\n')
}
