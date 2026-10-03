# Affidavit

**Visual-only QA for web apps.** You write a flow in the words a user sees on
screen. A real browser performs it by finding things the way a person would.
A reviewer model that has seen nothing but the screenshots testifies to what
they show, step by step.

Nothing in the QA path reads your code, database or network traffic. If a
person could not see it, Affidavit cannot claim it.

```
spec (*.qa.md) ──► browser ──► screenshot per step ──► reviewer ──► report + ledger
 words on screen    finds by       what a person         sees only the
 + expectations     visible text   would have seen       spec + pictures
```

## Why it holds up

- **Specs cannot leak the code.** The parser rejects selectors, test ids, API
  routes, file names and permission names, plus any terms your project adds.
- **The browser only acts on what is visible.** Something it cannot find is a
  `blocked` step with a screenshot, never a workaround.
- **The reviewer is isolated.** It runs in an empty folder with only a Read
  tool, no project files, no MCP servers and no memory.
- **The verdict is computed, not trusted.** Any failed step, criterion or
  visible failure signal is a `fail`; anything the screenshots cannot show is
  `needs_human`; `unclear` is never a pass.

## Quick start

Needs Node 20+, Google Chrome, and (for the default reviewer) the
[Claude Code](https://claude.com/claude-code) CLI signed in.

```bash
npm i -D github:cebawana/affidavit
npx affidavit init                  # config, example spec, env template, Claude Code skill
cp .env.qa.example .env.qa.local    # fill in test accounts
npx affidavit doctor                # browser, reviewer, roles, server
npx affidavit run --all
npx affidavit ledger                # one page for everything
```

Non-JavaScript projects (Laravel, Rails, Django…) need only Node on the
machine: run `npx affidavit …` from the project root.

## Commands

| Command | What it does |
|---|---|
| `init [--preset next\|vite\|none]` | Writes `affidavit.config.json`, `qa/specs/_example.qa.md`, `.env.qa.example`, the skill in `.claude/skills/affidavit/`, and gitignore lines. Never overwrites a file. |
| `doctor` | Checks the browser, reviewer backend, test accounts and that the app answers. |
| `check [spec…]` | Parses specs without running them; reports every problem at once. |
| `run <spec…> \| --all` | Runs specs by path or id. `--no-review` (screenshots only), `--headed`, `--base <url>`, `--max-turns <n>`. Exits non-zero unless every spec passes. |
| `ledger` | Builds one page with every spec's latest result, history, reviewer findings and screenshots (embedded, compressed). `--notes notes.md` adds your own panels; `--links` links screenshots instead; `--out`, `--title`. |

Each run writes `qa/runs/<time>-<id>/` with `report.html`, `result.json` and
one `step-NN.png` per step.

## Writing a spec

```markdown
---
id: invoice-send
title: Send an invoice to a client
role: admin                     # reads QA_ADMIN_EMAIL / QA_ADMIN_PASSWORD; "none" = signed out
viewport: phone                 # desktop · phone · tablet · 390x844
start: /invoices                # opened right after sign-in
---
## Goal
An admin sends invoice INV-0042 and sees it marked as sent.

## Steps
### 1. Open the invoice
- do: click "INV-0042"
- do: wait for "Send invoice"
- expect: Invoice INV-0042 is open and its total is shown as money.

### 2. Send it
- do: click "Send invoice"
- do: reload
- expect: After a reload the invoice is still marked "Sent".

## Success criteria
- The invoice is marked sent and stays sent after a reload.

## Failure signals
- Any error message, error code or "Something went wrong" screen.

## Out of scope
- The email itself.
```

**Actions:** `open "/path"` · `click "Text"` · `click "Text" near "Row text"` ·
`fill "Label" with "value"` · `select "Label" option "Option"` ·
`check "Label"` / `uncheck "Label"` · `press "Escape"` · `wait for "Text"` ·
`wait until gone "Text"` · `scroll to "Text"` · `reload`.
`{run}` becomes a short unique id per run, `{today}` becomes `YYYY-MM-DD`.

**Two modes, one format.** With `## Steps` the spec is scripted, which is
repeatable and the right shape for regression. With only `## Goal`, a vision
model explores like a new user. If it reaches the goal, its path is saved as
`recorded.qa.md` to keep as a scripted spec. If it gets lost, that is a finding:
the UI did not show the way.

Files starting with `_` are skipped by `run --all`.

## Configuration

`affidavit.config.json` at the project root (JSON, so any stack can use it):

```json
{
  "baseUrl": "http://localhost:3000",
  "preset": "next",
  "specs": "qa/specs",
  "runs": "qa/runs",
  "envFiles": [".env.qa.local"],
  "envPrefix": "QA_",
  "viewports": { "desktop": "1440x900", "phone": "390x844", "tablet": "820x1180" },
  "auth": {
    "type": "form",
    "loginPath": "/login",
    "fields": { "email": "Email", "password": "Password" },
    "submit": "Sign in",
    "doneWhenGone": "Email"
  },
  "backend": { "name": "claude-cli", "model": "sonnet" },
  "leakTerms": ["postgres", "/\\btenant_id\\b/"],
  "hide": [],
  "timeouts": { "find": 15000, "gone": 20000, "signIn": 90000 },
  "allowRemote": false
}
```

- **auth**: the labels on *your* login screen. `"type": "none"` skips sign-in.
- **preset**: dev-server noise per framework. `next` hides the dev badge and
  retries the transient 404 Next.js shows while recompiling (always reported).
- **backend**: `claude-cli` (default; your signed-in plan, no API key) or
  `openrouter` (`OPENROUTER_API_KEY`). `reviewModel` / `exploreModel` split them.
  A backend is one file in `src/backends/`.
- **leakTerms**: words a spec may not contain in this project; `/regex/` works.
- **allowRemote**: Affidavit signs in and writes data, so it refuses non-local
  hosts unless this is set.

Environment overrides use the prefix: `QA_BASE_URL`, `QA_BACKEND`, `QA_MODEL`,
`QA_REVIEW_MODEL`, `QA_EXPLORE_MODEL`, `QA_LOCALE`, `QA_ALLOW_REMOTE=1`.

## With Claude Code

`init` installs the `affidavit` skill, so an agent building a feature writes the
spec from the requirement *before* reading its own code back, runs it, opens the
screenshots, and reports the result. It never weakens an expectation just to get
a pass. If your `.gitignore` excludes `.claude/`, init tells you how to let
`.claude/skills/` through so other checkouts get the skill too.

## Status

v0.1, early. Planned: reusing the browser session per role between runs, more
framework presets, Codex / local-model backends, a Claude Code plugin package,
and a public npm release.

## License

[MIT](LICENSE) © 2026 Cris Bawana
