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

export const FRONT_MATTER_KEYS = ['id', 'title', 'role', 'viewport', 'start']

/** Edit distance, for "did you mean" hints. Small inputs, so the plain table is fine. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

function closest(word, candidates, max = 2) {
  let best = null
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase())
    if (d <= max && (!best || d < best.d)) best = { c, d }
  }
  return best?.c ?? null
}

/**
 * @param {string} text  the spec file's contents
 * @param {string} file  a name for error messages
 * @param {{ leakTerms?: string[], defaultRole?: string | null }} [options]
 */
export function parseSpec(text, file = 'spec', options = {}) {
  const errors = []
  const warnings = []
  let unknownAction = false
  const normalized = text.replace(/\r\n/g, '\n')
  const fm = normalized.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) throw new Error(`${file}: missing the --- front matter block`)

  const meta = {}
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    if (!FRONT_MATTER_KEYS.includes(m[1])) {
      const hint = closest(m[1], FRONT_MATTER_KEYS)
      errors.push(`front matter: unknown key "${m[1]}"${hint ? ` — did you mean "${hint}:"?` : ` (known: ${FRONT_MATTER_KEYS.join(', ')})`}`)
      continue
    }
    meta[m[1]] = m[2].trim()
  }
  if (!meta.role && options.defaultRole) meta.role = options.defaultRole
  for (const key of ['id', 'title']) if (!meta[key]) errors.push(`front matter needs "${key}"`)
  if (!meta.role) errors.push('front matter needs "role" (a role with sign-in credentials, or "none" for pages that need no sign-in; or set "defaultRole" in the config)')

  // `run <id>` looks for <id>.qa.md, so an id that differs from the file name
  // is a spec that can only be run by path.
  const fileId = file.match(/([^/\\]+)\.qa\.md$/)?.[1]
  if (meta.id && fileId && !fileId.startsWith('_') && fileId !== meta.id) {
    warnings.push(`id "${meta.id}" differs from the file name "${fileId}.qa.md", so "run ${meta.id}" will not find it`)
  }

  const spec = {
    ...meta,
    file,
    goal: '', preconditions: [], steps: [], successCriteria: [], failureSignals: [], outOfScope: [],
    warnings,
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
          if (action) step.actions.push(action)
          else {
            unknownAction = true
            const hint = suggestAction(item[2].trim())
            errors.push(`step "${step.title}": cannot read the action "${item[2].trim()}"${hint ? ` — did you mean \`${hint}\`?` : ''}`)
          }
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

  if (errors.length) {
    const err = new Error(`${file}:\n  - ${errors.join('\n  - ')}`)
    // The caller prints the vocabulary once per run, not once per bad line.
    err.unknownAction = unknownAction
    throw err
  }
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

// Words people reach for that mean one of ours. Only the verb is mapped; the
// quoted targets of the written line are kept.
const SYNONYMS = {
  tap: 'click', 'click on': 'click', push: 'click', choose: 'click', navigate: 'open', 'go to': 'open', visit: 'open', goto: 'open',
  type: 'fill', enter: 'fill', 'type in': 'fill', write: 'fill', input: 'fill',
  pick: 'select', tick: 'check', untick: 'uncheck', hit: 'press',
  scroll: 'scroll to', 'scroll down': 'scroll to', 'scroll down to': 'scroll to', 'scroll up': 'scroll to', 'scroll and look for': 'scroll to', 'look for': 'wait for', find: 'wait for', see: 'wait for', expect: 'wait for', wait: 'wait for', 'wait until': 'wait until gone',
  refresh: 'reload',
}

/**
 * The closest valid action for a line the parser could not read, or null.
 * Keeps the quoted targets from the written line and fills them into the
 * vocabulary entry's slots, so the hint is ready to paste.
 */
export function suggestAction(text) {
  const clean = text.trim().replace(/^`|`$/g, '')
  const quoted = [...clean.matchAll(/"([^"]*)"/g)].map(m => m[1])
  // `type "value" into "Field"` names the value first; `fill` names the field first.
  if (/\binto\b/i.test(clean) && quoted.length === 2) quoted.reverse()
  const verb = clean.replace(/"[^"]*"/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!verb) return null
  const verbs = [...new Set(ACTIONS_VERBS)]
  // Longest synonym or verb that the written line starts with, else the nearest by spelling.
  const starts = [...Object.keys(SYNONYMS), ...verbs].filter(v => verb === v || verb.startsWith(`${v} `)).sort((a, b) => b.length - a.length)[0]
  const firstWord = verb.split(' ')[0]
  const kind = starts ? (SYNONYMS[starts] ?? starts) : (closest(firstWord, verbs) ?? SYNONYMS[closest(firstWord, Object.keys(SYNONYMS)) ?? ''])
  if (!kind) return null
  // Prefer the vocabulary entry whose slot count matches what was written.
  const entries = ACTION_VOCABULARY.filter(e => e.toLowerCase().startsWith(kind))
  const slots = e => (e.match(/"[^"]*"/g) ?? []).length
  const entry = entries.find(e => slots(e) === quoted.length) ?? entries.sort((a, b) => slots(a) - slots(b))[0]
  if (!entry) return null
  let i = 0
  return entry.replace(/"[^"]*"/g, () => `"${quoted[i++] ?? '…'}"`)
}

const ACTIONS_VERBS = ACTION_VOCABULARY.map(e => e.replace(/\s*"[^"]*"/g, '').replace(/\s+(near|with|option)\s*$/, '').trim().toLowerCase())

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
