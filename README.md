# Affidavit

**Your coding agent says it works. Affidavit shows you.**

Coding agents are fast at building and quick to report success they never
saw — "done, tested, works" — when the screen says otherwise. A human can
check one or two screens. Not hundreds.

Affidavit is the independent witness. Your agent writes each flow in the
words a user sees on screen. A real browser performs it against your running
app. A reviewer that has never seen your code testifies to what each
screenshot shows — and every verdict comes with the picture to prove it.

You stop doing the checking. You review the evidence.

```
spec (*.qa.md) ──► browser ──► screenshot per step ──► reviewer ──► report + ledger
 words on screen    finds by       what a person         sees only the
 + expectations     visible text   would have seen       spec + pictures
```

## Where it fits

Affidavit is black-box QA from the user's side of the screen: it drives the
running app, but never looks inside it. Nothing in the QA path reads your code,
DOM, database or network traffic. If a person could not see it, Affidavit
cannot claim it.

It does not replace unit tests or classic end-to-end suites. Keep those for
logic and fast CI. Affidavit covers what they miss: UX flows, layouts across
screen sizes, who can see what, and whether the work your agent reported as
done actually shows up.

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
npm i -D affidavit                  # or straight from GitHub: npm i -D github:cebawana/affidavit
npx affidavit init --no-auth        # config, example spec, Claude Code skill
npm run dev                         # start the app (in another terminal)
npx affidavit doctor                # browser, reviewer, server: shows the page title it found
npx affidavit run --all
npx affidavit ledger                # one page for everything
```

That is the whole setup for an app without a sign-in: no credentials, no
`.env` file. `init` picks `baseUrl` from the framework (Vite 5173, Next 3000,
or the port the dev script states); `--base-url <url>` overrides it.

Scripts and coding agents have no terminal to answer in, so `init` without
`--no-auth` sets up the sign-in form: pass `--no-auth` whenever the app has no
sign-in.

If the app has a login screen, run `npx affidavit init` instead (it asks), then
`cp .env.qa.example .env.qa.local`, fill in the test accounts, and set `auth`
in `affidavit.config.json` to the labels on your login screen.

Non-JavaScript projects (Laravel, Rails, Django…) need only Node on the
machine: run `npx affidavit …` from the project root.

## Commands

| Command | What it does |
|---|---|
| `init [--no-auth] [--preset next\|vite\|none] [--base-url <url>]` | Writes `affidavit.config.json`, `qa/specs/_example.qa.md`, the skill in `.claude/skills/affidavit/`, and gitignore lines; with a sign-in, also `.env.qa.example`. Asks "Does the app need a sign-in?" in a terminal; `--no-auth` answers for scripts and agents. Never overwrites a file. |
| `doctor` | Checks the browser, the reviewer backend, the roles your specs sign in as, and that the app answers: it shows the final URL and page title, so the wrong app on the port is obvious. |
| `check [spec…]` | Parses specs without running them; reports every problem at once, with a "did you mean" for an action or front-matter key it cannot read. |
| `run <spec…> \| --all` | Runs specs by path or id. The browser captures one spec after another; reviews run from a queue alongside it. `--no-review` (screenshots only), `--headed`, `--base <url>`, `--max-turns <n>`, `--review-concurrency <n>`, `--fresh-sign-in`. Exits non-zero unless every spec passes. |
| `review <run…> \| --latest \| --unreviewed` | Reviews runs that already exist, without the browser: after a rate limit or a timeout, with another backend or model, or a whole suite captured with `--no-review`. `--latest` is every spec's latest run; `--unreviewed` every run without a verdict. Rewrites `report.html` and `result.json`; the screenshots are untouched. |
| `ledger` | Builds one page with every spec's latest result, history, reviewer findings and screenshots (embedded, compressed). `--notes notes.md` adds your own panels; `--links` links screenshots instead; `--out`, `--title`. |

Each run writes `qa/runs/<time>-<id>/` with `report.html`, `result.json` and
one `step-NN.png` per step. `result.json` carries the verdict, the spec's
criteria as they were at capture time, and `timings` (`browserMs`, `queuedMs`,
`reviewMs`), so a run can be reviewed again later and the time split measured.

### Fast suites

Capture and review are pipelined: as soon as the browser finishes a spec it
hands the run to a review queue and starts the next spec. Reviews run from the
queue, several at once (`backend.concurrency`, default 2 for `claude-cli` and
4 for `openrouter`), while capture continues. Reviews only read screenshots
that already exist, so they can never change what the browser does: a
pipelined run captures exactly what a sequential one would.

A rate limit from the reviewer is never a verdict. It is retried with growing
waits (15 s, 30 s, 60 s), and if it persists the run is recorded as
`not_reviewed` with the reason. The summary lists the runs left unreviewed and
the command that finishes them:

```bash
npx affidavit review --unreviewed
```

The same command finishes a suite captured with `run --all --no-review`, and
`review --latest` re-judges every spec's latest run, for example after
switching the backend or the model.

Signing in is saved per role. After a sign-in, the browser's session is kept
in `.affidavit/sessions/` (gitignored by `init`, readable by you only; `doctor`
checks both) and the next spec of that role starts from it. The session is
trusted only on positive evidence, because a missing login form proves nothing
on a public page: with `auth.signedInText` set (text only a signed-in user
sees, such as "Sign out"), it must be on screen; otherwise the browser opens
`auth.loginPath` and must be sent away from it. A sign-in form there means the
session expired, so it signs in right there and refreshes the saved copy. When
nothing confirms it, the browser forgets the session and signs in again (if
your app shows the signed-in page at the login URL instead of redirecting, set
`signedInText` so every spec after the first can skip the sign-in). Step 0 stays in the report
either way, with notes saying which path it took. `--fresh-sign-in` ignores
saved sessions for one run; `"reuseSession": false` turns the feature off;
deleting `.affidavit/sessions/` forgets every session.

## Writing a spec

```markdown
---
id: invoice-send
title: Send an invoice to a client
role: admin                     # reads QA_ADMIN_EMAIL / QA_ADMIN_PASSWORD; "none" = no sign-in
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

Files starting with `_` are skipped by `run --all`. Name the file after the
`id` (`invoice-send.qa.md`) so `run invoice-send` finds it; `check` warns when
they differ. Extra front-matter keys (`tags:`, `owner:`) are kept and ignored
with a warning; a near miss of a known key (`rol:`) is an error.

**No sign-in?** Use `role: none`, or set `"defaultRole": "none"` in the config
and leave `role` out. With `"auth": {"type": "none"}` credentials are never
looked up and any `role` is only a label shown in the report.

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
  "defaultRole": null,
  "auth": {
    "type": "form",
    "loginPath": "/login",
    "fields": { "email": "Email", "password": "Password" },
    "submit": "Sign in",
    "doneWhenGone": "Email",
    "signedInText": "Sign out"
  },
  "backend": { "name": "claude-cli", "model": "sonnet", "concurrency": 2 },
  "reuseSession": true,
  "leakTerms": ["postgres", "/\\btenant_id\\b/"],
  "hide": [],
  "timeouts": { "find": 15000, "gone": 20000, "signIn": 90000, "sessionCheck": 1000 },
  "allowRemote": false
}
```

- **auth**: the labels on *your* login screen. `"type": "none"` means the app
  has no sign-in: credentials are never looked up, `doctor` reports "no sign-in
  needed", and a role is only a label. `signedInText` is optional: text only a
  signed-in user sees, used to confirm a saved session.
- **defaultRole**: used by specs that leave `role` out. Unset by default on
  purpose: in an app with a login, a spec that forgot its role would otherwise
  run signed out without anyone noticing. `init --no-auth` sets it to `"none"`.
- **preset**: dev-server noise per framework, and the default `baseUrl` port
  for `init`. `next` hides the dev badge and retries the transient 404 Next.js
  shows while recompiling (always reported).
- **backend**: `claude-cli` (default; your signed-in plan, no API key) or
  `openrouter` (`OPENROUTER_API_KEY`). `reviewModel` / `exploreModel` split them.
  `concurrency` is how many reviews run at once while the browser captures the
  next spec; unset means the backend's own default. A backend is one file in
  `src/backends/`.
- **reuseSession**: save the signed-in session per role and reuse it on the
  next spec of that role (default on). The session counts only when
  `signedInText` is on screen or the login page sends the browser away;
  otherwise it signs in again.
- **leakTerms**: words a spec may not contain in this project; `/regex/` works.
- **allowRemote**: Affidavit signs in and writes data, so it refuses non-local
  hosts unless this is set.

Environment overrides use the prefix: `QA_BASE_URL`, `QA_BACKEND`, `QA_MODEL`,
`QA_REVIEW_MODEL`, `QA_EXPLORE_MODEL`, `QA_REVIEW_CONCURRENCY`, `QA_LOCALE`,
`QA_ALLOW_REMOTE=1`.

## With Claude Code

`init` installs the `affidavit` skill, so an agent building a feature writes the
spec from the requirement *before* reading its own code back, runs it, opens the
screenshots, and reports the result. It never weakens an expectation just to get
a pass. If your `.gitignore` excludes `.claude/`, init tells you how to let
`.claude/skills/` through so other checkouts get the skill too.

## Status

v0.3, early, [on npm](https://www.npmjs.com/package/affidavit). Planned: parallel
browsers with `--workers`, more framework presets, Codex / local-model backends,
and a Claude Code plugin package.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Cris Bawana
