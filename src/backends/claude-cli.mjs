// The vision call through the local Claude Code CLI (`claude -p`): it runs on
// the plan already signed in on this machine, with no API key.
//
// Kept independent on purpose — the reviewer must judge the pictures, not the
// code:
//   · it runs with a throwaway folder as its working directory, so it never
//     sees the project or its CLAUDE.md;
//   · `Read` is the only tool it has (to open the screenshots); no MCP
//     servers; no saved session;
//   · `--system-prompt` replaces the default prompt with the caller's.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_MODEL = 'sonnet'

export async function chat({ model, system, content }) {
  const dir = mkdtempSync(join(tmpdir(), 'affidavit-'))
  try {
    let n = 0
    const parts = []
    for (const part of content) {
      if (part.type === 'text') parts.push(part.text)
      else if (part.type === 'image') {
        const file = join(dir, `image-${String(++n).padStart(2, '0')}.png`)
        writeFileSync(file, part.png)
        parts.push(`[Image ${n}: open ${file} with the Read tool and look at it before judging.]`)
      }
    }
    const prompt = parts.join('\n\n') + (n > 0 ? `\n\nThere are ${n} images. Read every one of them before you answer.` : '')

    const args = [
      '-p', '--output-format', 'json', '--model', model,
      '--tools', 'Read', '--allowedTools', 'Read',
      '--system-prompt', system,
      '--no-session-persistence', '--strict-mcp-config',
    ]
    const out = await run(process.env.AFFIDAVIT_CLAUDE_BIN?.trim() || 'claude', args, prompt, dir)
    let parsed
    try { parsed = JSON.parse(out) } catch { throw new Error(`claude CLI did not return JSON: ${out.slice(0, 300)}`) }
    if (parsed.is_error) throw new Error(`claude CLI error: ${String(parsed.result).slice(0, 300)}`)
    return {
      text: typeof parsed.result === 'string' ? parsed.result : '',
      model: `claude-cli:${model}`,
      // Billed to the CLI's own plan, not per call.
      costUsd: null,
      tokens: parsed.usage ? (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0) : null,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function run(bin, args, stdin, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude CLI timed out')) }, TIMEOUT_MS)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`could not start the claude CLI (${bin}): ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`claude CLI exited ${code}: ${(err || out).slice(0, 400)}`))
      else resolve(out)
    })
    child.stdin.end(stdin)
  })
}
