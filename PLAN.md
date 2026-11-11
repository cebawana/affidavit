# Affidavit — Plan

Snapshot of GitHub issues per milestone. Latest release: **0.7.0** (3 Nov 2026).
Source of truth is GitHub; this file is a readable view of it.

Legend: ✅ done · 🔀 PR open · ⬜ open · 📊 measurement

## 1. Reliable & fast — 11 done / 12 open

The runner acts on what it sees, waits the right amount, and suites finish quickly.

**Done**
- ✅ #1 Wait until the page is interactive before acting (0.4.0)
- ✅ #2 Prefer the main content over navigation when a click target is ambiguous (0.5.0)
- ✅ #16 Reuse the signed-in session per role (0.3.0)
- ✅ #28 First-run experience: apps without sign-in, the right server, actionable errors (0.2.0)
- ✅ #29 Review pipeline: review while the browser captures, re-review existing runs (0.3.0)
- ✅ #3 Click targets covered by a sticky header or a bottom bar (0.6.0)
- ✅ #35 Note when a control was disabled before it could be clicked (0.6.0)

- ✅ #39 `wait for` prefers an exact match over a substring (0.6.0)
- ✅ #36 settle(): the quiet-screen check instead of a fixed pause (0.7.0)
- ✅ #34 Skip the network wait on a page that never goes idle (0.7.0)
- ✅ #45 Sign in once per role: the saved session is the sign-in and nothing else (0.7.0)

**Speed — towards 0.8.0**
- 📊 #44 Suite wall time on a 94-spec project: where the minutes go (measured on nex-receptionist, 0.6.0). The breakdown behind every item below.
- ⬜ #46 Fail fast when the environment is wrong: preflight, environment guard, stop on a repeated block
- ⬜ #47 Rerun what failed, and from the failed step: `run --failed`, `run <spec> --from <n>`
- ⬜ #37 Re-measure the 94-spec suite on 0.7.0 and post the numbers (needs the real project)
- ⬜ #18 Parallel runs with `--workers` (decide after #37's numbers)

**Spec & runner**
- ⬜ #43 `upload "file" to "Button text"`: a fixture file on the input a visible button opens (blocks real QA, also 0.7.0)
- ⬜ #4 `## Cleanup` steps that always run
- ⬜ #14 New actions: hover, type, drag, horizontal scroll (upload split into #43)
- ⬜ #15 Full-page capture and sideways-overflow notes

**Seeing results**
- 🔀 #50 See results without Finder: the ledger refreshed after every run, clickable links, `affidavit open` (0.7.1)

**Auth**
- ⬜ #17 `affidavit login <role>`: sign in by hand once (OAuth, SSO, magic links, 2FA)
- ⬜ #32 init and doctor find the sign-in page and read its labels

## 2. Any agent, any model — 0 done / 5 open

Affidavit works with whichever coding agent and model the project already uses.

- ⬜ #5 OpenAI-compatible backend (OpenRouter, OpenAI, Ollama, LM Studio, vLLM)
- ⬜ #6 Codex CLI backend
- ⬜ #19 Anthropic API backend
- ⬜ #7 AGENTS.md support for Codex, Cursor, Gemini CLI and other coding agents
- ⬜ #20 `affidavit bench`: measure how accurate each reviewer is

## 3. Ready to promote (1.0) — 0 done / 9 open

Good enough to show strangers: proof, CI, sharing, polish.

**Proof & docs**
- ⬜ #12 README demo: a short recording and a ledger screenshot
- ⬜ #13 Prove it on projects with different stacks
- ⬜ #25 Windows support check

**CI & sharing**
- ⬜ #8 CI mode: machine-readable results, a GitHub Action, time and cost per run
- ⬜ #9 Ledger v2: newly failing, trends, one-command sharing

**Reviewer & explore**
- ⬜ #10 A second opinion before a failing verdict stands
- ⬜ #11 Explore mode stops going in circles

**Authoring & distribution**
- ⬜ #21 `affidavit record`: write a spec by clicking through a flow
- ⬜ #23 Claude Code plugin package

## 4. Later (after 1.0) — 5 open

- ⬜ #22 `affidavit new`: scaffold a spec
- ⬜ #24 Firefox and WebKit
- ⬜ #26 Documentation site
- ⬜ #27 Native mobile apps through simulators
- ⬜ #51 `affidavit serve`: a local live viewer for runs

## Next up

1. Publish 0.7.0 to npm (`npm publish` after `npm login`).
2. On nex-receptionist: set `reuseSession` back to `true`, run the suite on 0.7.0, post the numbers in #37.
3. #43 `upload`, so nex-receptionist drops its `documentAutoPick` knob.
4. #46 and #47: stop paying for a broken environment, rerun only what failed.
5. #18 `--workers` once #37's numbers say where the ceiling is.
