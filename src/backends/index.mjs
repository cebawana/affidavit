// The one contract every model backend meets:
//
//   chat({ model, system, content, maxTokens }) → { text, model, costUsd, tokens }
//
// `content` is a list of text() / image() parts from ./parts.mjs. Adding a
// backend (Codex CLI, a local model…) is one file here plus one line below.

import * as claudeCli from './claude-cli.mjs'
import * as openrouter from './openrouter.mjs'

const BACKENDS = { 'claude-cli': claudeCli, openrouter }

export const BACKEND_NAMES = Object.keys(BACKENDS)

/**
 * @param {{ name: string, model?: string, reviewModel?: string, exploreModel?: string }} backend
 * @param {'review' | 'explore'} purpose
 */
export function modelFor(backend, purpose) {
  const impl = BACKENDS[backend.name]
  if (!impl) throw new Error(`unknown backend "${backend.name}" (known: ${BACKEND_NAMES.join(', ')})`)
  return backend[`${purpose}Model`] || backend.model || impl.DEFAULT_MODEL
}

export async function chat(backend, purpose, { system, content, maxTokens }) {
  const impl = BACKENDS[backend.name]
  if (!impl) throw new Error(`unknown backend "${backend.name}" (known: ${BACKEND_NAMES.join(', ')})`)
  return impl.chat({ model: modelFor(backend, purpose), system, content, maxTokens })
}
