# uidiff — before/after UI screenshots

Captures a page on your local dev server before and after a code change, and
produces a drag-to-compare HTML report plus the `getBoundingClientRect()`
numbers for whichever elements you name. `SKILL.md` next to this file is the
agent-facing version; this one is for setting it up on your machine.

Any route, any change, nothing to configure per screen: the page and the
interactions to reach a state are command-line arguments. It also refuses to
capture a change that could not possibly look different, so a docs-only or
test-only edit does not cost you two screenshots and a shrug.

## Scope

This is deliberately narrow, and says so up front rather than half-supporting
things:

- **macOS only.** It opens the report with `open`, copies the PR body with
  `pbcopy`, and reveals images with `open -R`. On anything else it stops with
  one clear line instead of failing halfway through a run.
- **Built for a JavaScript front end** with a dev server that hot-reloads —
  Next.js, Vite and the like. The wait after a file swap is a plain sleep, so a
  stack that has to compile before it serves would photograph the old build.
- **Sign-in is either a next-auth app or a cookie you supply yourself.**

None of that is deep in the design; it is where the tool has actually been
used. See "Contributing" below.

## What you need on your machine

- **Node 21 or newer.** The tool has no dependencies — it uses the global
  `fetch` and `WebSocket` that Node 21 added, and drives Chrome directly over
  the DevTools Protocol rather than through Puppeteer.
- **Chrome or Chromium.** Found automatically in `/Applications`. Set
  `CHROME_PATH`, or `chromePath` in the config, if yours is elsewhere.
- **git.** The "before" frame is rebuilt by swapping files on disk to a ref.
- **ImageMagick** — the only thing you may not already have. You do not need to
  install it up front: `compare` stops if it is missing and offers
  `uidiff install-deps`, which is `brew install imagemagick` and nothing else.
  Declining is fine — `--skip-crops` gives you the full-page pair without the
  crops, the pixel-diff count or the wipe animation.

## Setting it up for a repo

Copy `config.example.json` to `.uidiff.json` at the root of the repo you want
to capture, then set `baseUrl` and `auth`. That file is the whole configuration
— it holds per-repo settings only, never anything about a particular screen.

```bash
uidiff() { node /path/to/uidiff/bin/uidiff.mjs "$@"; }

cd your-repo
uidiff doctor
```

`doctor` prints config, viewport, ImageMagick, Chrome, dev server and auth in
seven lines, and is the right first move whenever something looks wrong.

Start your dev server yourself; the tool never starts one and won't fight one
you already have. **If your pages fetch from a separate API, start that too** —
a route whose backend is down still produces a PNG, of an error page. Every
command warns when that has happened rather than letting you read an error
overlay as a result.

## Using it

```bash
uidiff compare /dashboard                 # working tree vs HEAD, then a report
uidiff markdown /dashboard                # PR body on the clipboard + images to drag in
```

`compare` captures the current state, restores the changed files to
`--before-ref` (`HEAD` by default), waits for the dev server to reload,
captures again, then restores your working tree verbatim — uncommitted work
included. If it is ever interrupted mid-swap, `uidiff restore` puts the files
back and `doctor` warns you that a swap is pending.

To reach a particular state, add `--wait-for`, `--click`, `--hover` and
`--wait`; they apply in the order you write them and each can repeat. Add
`--measure <selector>` for the geometry of an element and `--crop <selector>`
to compare one region closely — the crop region is computed from that element's
live position, so you never work out pixel coordinates yourself. `--mask
<selector>` paints a region flat in both frames, which is how you stop a clock
or a rotating avatar from counting as a difference. `uidiff --help` lists
everything.

For a PR, `markdown` puts the body on your clipboard and opens Finder with the
images selected — paste, then drag each image onto its `> Drop ….gif on this
line.` slot. The images go to GitHub's own attachment store, so nothing is
committed to the repo.

## Two things worth knowing about the numbers

**The pixel count is an exact count of pixels that differ in any channel.** It
is deliberately not ImageMagick's `-metric AE`, which sounds like exactly that
but reports a normalised sum of channel errors on a Q16 HDRI build — the one
Homebrew installs. On a test pair with twelve solidly repainted pixels it says
`8.47`, and for two pixels nudged by three levels it says `0.02`. Both would
read as reassuring. `pixelDiff` differences the frames and counts the mask
instead.

**Captures are quieted before the shutter.** Animations are run to their end
state rather than disabled — disabling them silently loses any element whose
resting style is `opacity: 0` — infinite ones like spinners are pinned to their
first frame, web fonts and images are awaited, and the caret is hidden. What
that cannot fix is content the page rewrites on its own, which is what
`--mask` is for.

## Running the tests

```bash
node --test test/*.test.mjs
```

Node's built-in runner, no install. They build throwaway git repos under `/tmp`
and point `UIDIFF_CACHE` at a scratch directory, so nothing touches your
`~/.cache/uidiff` or your checkout. The image tests skip themselves when
ImageMagick is absent.

Most of them cover `lib/gitswap.mjs`, which rewinds real files on disk to build
the "before" state. That is the one part of this tool that can destroy work, so
every restore path has a test: uncommitted edits, files new since the ref, files
deleted in the working tree, partially staged files, and finishing a swap that a
crash left behind.

The tests cannot reach Chrome, auth, or a running dev server. Exercise
`uidiff compare` by hand before trusting a change to `lib/cdp.mjs` or the auth
code in `lib/project.mjs`.

## Gotchas

**A refusal is usually correct.** If `compare` says a screenshot would show
nothing, the change really is tests, docs, config or migrations. `--force`
exists for when you know better — a `.ts` util that only renders on one route,
say — but reaching for it habitually defeats the point. Anything ambiguous
already runs anyway, with a note that a visible diff is not guaranteed.

**Screenshots are written outside the checkout**, to `~/.cache/uidiff`. They
are captures of live pages and can contain real data, and a stray `git add`
should not be able to reach them. Delete that directory freely; it is all
reproducible.

## Contributing

The scope above is where this has been used, not a judgement about what is
worth supporting. The most useful contributions are the obvious ones: Linux and
Windows equivalents for `open`/`pbcopy`, a readiness poll for stacks that
compile, and auth for apps that keep a token in `localStorage` rather than a
cookie.

Maintenance is best-effort. See `CONTRIBUTING.md` for the mechanics of running
tests and opening a PR.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
