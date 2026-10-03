# Contributing to Affidavit

Thanks for wanting to help. Affidavit is small on purpose, and the rules below
keep it trustworthy.

## The one rule that cannot bend

**Nothing in the QA path may see the app's code, database or network.** The
browser acts only on what is visible, the reviewer sees only the spec and the
screenshots, and the verdict is computed rather than taken from a model. A
change that weakens any of these (even "just for debugging") will not be
merged. If you think one of them is wrong, open an issue first and make the
case.

## Getting started

```bash
git clone https://github.com/<you>/affidavit.git
cd affidavit
npm install
npm test
```

Node 20 or newer. To try it against a real app, run `node /path/to/affidavit/bin/affidavit.mjs init`
inside that app and follow the README. A local server and Google Chrome are
needed for `run`; `check` and the tests need neither.

## Making a change

1. **Open an issue first** for anything larger than a small fix, so we can agree
   on the shape before you spend time on it.
2. **Fork, branch, and open a pull request** against `main`. Direct pushes to
   `main` are blocked for everyone except the maintainer.
3. **Add or update a test** in `test/` for any change to parsing, configuration,
   the action vocabulary or the verdict. CI runs `npm test` on Node 20 and 22,
   and both must pass before a PR can be merged.
4. **Match the surrounding code**: plain ES modules, no build step, no new
   runtime dependency without discussion (today there is exactly one,
   `playwright-core`), and comments that explain *why*, not *what*.
5. **Update the README** when you change a command, an option, the spec format
   or the configuration.

## Good first contributions

- **A framework preset** in `src/presets.mjs` for a dev server you use (what
  overlay to hide, what its transient error page says).
- **A model backend** in `src/backends/`: one file that meets the `chat()`
  contract described in `src/backends/index.mjs`.
- **A new action** in the vocabulary: it must target something a person can
  see, and come with parser tests.
- Bug reports with a spec that reproduces the problem (scrub any real data
  from it first).

## Reporting a security problem

Please do not open a public issue. Use GitHub's **Report a vulnerability**
button on the repository's Security tab, so it can be fixed before it is
disclosed.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
