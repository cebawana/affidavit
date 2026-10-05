---
name: affidavit
description: Visual-only QA with Affidavit. Write a spec (qa/specs/*.qa.md) for a user-facing flow in on-screen language, run it, and read the screenshot report and ledger. Use whenever you build or change a user-facing flow, or when asked to "QA", "test the flow", "write the QA process / success criteria", or "show the QA ledger".
---

# Affidavit: visual QA

Affidavit judges the app **only by what is on screen**. You write the spec; a
browser runs it by visible text; a separate reviewer model that sees only the
screenshots testifies to what they show. Nothing in the QA path reads the code,
the database or the network. The project's settings are in
`affidavit.config.json` (base URL, sign-in screen, roles, screen sizes).

Setting a project up for the first time? Run `npx affidavit init --no-auth`
when the app has no sign-in, or `npx affidavit init` when it has a login
screen. Without `--no-auth`, `init` assumes a login screen, because you cannot
answer its question from a script.

## When you build or change a user-facing flow

1. **Write the spec from the requirement first**, before reading your own
   implementation back. Criteria written after the code tend to describe the
   code. File: `<specs>/<feature>-<flow>.qa.md`.
2. **Use only on-screen language:** button labels, headings, field labels, the
   text in a row. No selectors, API routes, file names, table names or
   permission names; `npx affidavit check` rejects them. Look at the running
   app (or a screenshot) to get labels exactly right.
3. **Cover the roles.** One spec per role that sees the flow differently, and
   put what a role must *not* see under `## Failure signals`. For a page that
   needs no sign-in use `role: none`. If the app has no sign-in at all
   (`"auth": {"type": "none"}` in the config), every spec is `role: none`;
   `defaultRole` in the config lets you leave `role` out.
4. **Make persistence visible.** After a write, `reload` and expect the data to
   still be on screen. After a navigation, `wait for` something the next screen
   must show, or the screenshot may catch a loading state.
5. **Use `{run}` in every name you type**, and delete what you created as the
   last steps.
6. **Pick the screen size on purpose**: `viewport: desktop` / `phone` /
   `tablet` (or `WIDTHxHEIGHT`). Layout bugs are usually phone bugs.
7. **Unsure of the steps?** Write only `## Goal` and `## Success criteria` and
   run it. Explore mode finds a path and saves `recorded.qa.md` in the run
   folder. Remove detours and keep it as the scripted spec. An exploration that
   gets lost is a UX finding. Report it; do not paper over it with a hint.

## Spec format

```markdown
---
id: invoice-send                # unique, kebab-case, same as the file name
title: Send an invoice to a client
role: admin                     # a role with <PREFIX><ROLE>_EMAIL/_PASSWORD, or "none" (no sign-in)
viewport: phone                 # desktop · phone · tablet · 390x844
start: /invoices                # optional; opened right after sign-in
---
## Goal
One or two sentences in product language.

## Preconditions
- What must already be true.

## Steps
### 1. Open the invoice
- do: click "INV-0042"
- do: wait for "Send invoice"
- expect: The invoice INV-0042 is open with its total shown as money.

## Success criteria
- Outcomes judged across the whole run.

## Failure signals
- Things that must never be seen (error codes, "Something went wrong", a stuck "Saving…").

## Out of scope
- What the reviewer should not judge.
```

Actions:

```
open "/path"                      click "Text"
click "Text" near "Row text"      fill "Label" with "value"
select "Label" option "Option"    check "Label" / uncheck "Label"
press "Escape"                    wait for "Text"
wait until gone "Text"            scroll to "Text"
reload
```

For an icon-only button, target the name its tooltip or screen reader gives it
(`click "Edit INV-0042"`). `{run}` is a short unique id per run and `{today}` is
`YYYY-MM-DD`.

## Run it and read the evidence

```bash
npx affidavit doctor                   # browser, reviewer, roles, and which app answers at baseUrl
npx affidavit check                    # parse every spec, no browser; unreadable lines get a "did you mean"

npx affidavit run <id-or-path>         # one spec
npx affidavit run --all                # every spec
npx affidavit run <id> --no-review     # screenshots only, while iterating
npx affidavit ledger                   # one page: every spec, latest result, history
```

The app's server must be running; `doctor` shows the title of the page at
`baseUrl`, so check it is *this* app. Each run writes
`<runs>/<time>-<id>/report.html`, `result.json` and one `step-NN.png` per step.
**Open the screenshots yourself.** The report is the evidence, and the
reviewer can be wrong.

- `pass`: every step and criterion was visibly met.
- `fail`: a real defect, or a wrong spec. Check the screenshot before deciding
  which. **Never weaken an expectation just to get a pass.**
- `blocked`: the browser could not see something the spec named. Either the
  label in the spec is wrong or the UI does not show it; the screenshot says
  which.
- `needs_human`: something was `unclear` (a toast that faded, content below the
  fold). Say which step and why.

Report the result, the report path, and every defect with the step it appeared
in. Do not describe a flow as working when its QA run did not pass. When asked
for an overview, run `npx affidavit ledger` (`--notes <file.md>` adds your own
"what changed / still open" panels) and share that page.
