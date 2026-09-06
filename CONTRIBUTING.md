# Contributing

See the "Contributing" section in `README.md` for what kinds of changes are
actually useful — this file is just the mechanics.

## Setup

No install step: the tool has zero runtime dependencies.

```bash
git clone https://github.com/imsain/uidiff.git
cd uidiff
node --test test/*.test.mjs
```

Node 21+ and git are all you need for the test suite. ImageMagick is optional
for it — the image tests skip themselves when it is absent — but install it
(`brew install imagemagick`) if you're touching `lib/report.mjs` or
`lib/wipe.mjs`, and run `uidiff compare` by hand for anything touching
`lib/cdp.mjs` or the auth code in `lib/project.mjs`, since the automated tests
can't reach Chrome, auth, or a dev server.

## Before opening a PR

- `node --test test/*.test.mjs` passes. CI runs this on macOS on every PR.
- `npx prettier --check .` if you touched formatting-sensitive files.
- If you changed behaviour a human would notice (a new flag, a changed
  default, a different report), update `README.md` and/or `SKILL.md` in the
  same PR. They're the only docs this project has.
- Keep the scope narrow. This is a deliberately small, macOS-only tool — see
  `README.md`'s "Scope" section before adding a new platform, framework, or
  dependency.

## Reporting a bug

Include your OS/Chrome/Node versions, the command you ran, and — if it's
about a diff being wrong or missed — the two PNGs from `~/.cache/uidiff` if
you're comfortable sharing them.

## Licensing

By contributing, you agree your contribution is licensed under Apache-2.0,
the same as the rest of the project.
