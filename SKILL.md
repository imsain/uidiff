---
name: ui-screenshot-diff
description: >-
  Capture before/after screenshots of any route on a running local dev server
  and show the user a drag-to-compare report, using the `uidiff` CLI. Works on
  any page and any change with no per-screen setup, and refuses up front when
  the change could not alter what a page looks like. Use proactively: whenever
  an edit could change how a page looks — JSX or HTML markup, CSS, Tailwind or
  other utility classes, layout, spacing, sizing, colour, or hover and
  open/closed states — verify it and show the user the comparison without being
  asked, as long as a local dev server is running. Also use when the user asks
  to see the visual effect of a UI change, wants a before/after comparison of a
  page, asks to "screenshot this before and after", mentions a visual
  regression, or needs the on-screen geometry of an element measured to
  implement an alignment or spacing fix. macOS only.
---

# UI Screenshot Diff

Use the `uidiff` CLI — it owns Chrome, local auth, capture, the pixel diff, and
the HTML report. Do not hand-roll CDP scripts, and never inline screenshots as
base64 yourself.

```bash
uidiff() {
  local bin="$(git rev-parse --show-toplevel 2>/dev/null)/.cursor/skills/ui-screenshot-diff/bin/uidiff.mjs"
  [ -f "$bin" ] || { echo "uidiff: not in a checkout with the tool vendored (pwd: $PWD)" >&2; return 1; }
  node "$bin" "$@"
}
```

Adjust the `bin` path to wherever this tool actually lives relative to the repo
root. **Set the working directory to the frontend checkout on every call.** In
a workspace that also has a separate backend repo open, terminals frequently
start there instead, and the guard above is there so that shows up as one
legible line rather than a `Cannot find module` that looks like a broken
install.

It needs Node, Chrome, git and ImageMagick. Everything but ImageMagick you
almost certainly have; if it is missing, `compare` stops and says so rather
than silently producing a worse report — offer `uidiff install-deps`
(`brew install imagemagick`) and let the user decide.

Screenshots and the minted session cookie are written to `~/.cache/uidiff`,
deliberately outside the checkout — captures of real pages can contain real
data.

Shell calls need unrestricted execution permissions: headless Chrome needs
`--no-sandbox`, which needs an unsandboxed shell.

## Using it unprompted

A visual change the user has not seen is unverified, so capture the comparison
as part of finishing the work rather than offering to. Do it after the edit
passes lint, and report the measurements in the same message as the change.

There is nothing to set up per screen: name the route and the interactions on
the command line, so this works on the first request for any page.

Skip it, without mentioning the skill, when:

- the servers are not running, or `uidiff doctor` reports the config is missing
  for this repo — say the change is unverified, and name what has to be running
  (see Prerequisites: **both** the frontend and its backend) so the user can
  decide. Don't start either one yourself.
- the user asked for speed, said not to bother, or is mid-iteration on
  something else

You do **not** need to judge whether the change is visual — `compare` decides
that itself and refuses when it cannot be. See below.

One capture per finished change, not per intermediate edit. When several edits
land on the same screen, compare once at the end against the ref the work
started from.

## The normal flow

Make the code change first, then let the tool rebuild the "before" state from
git. One command does everything:

```bash
cd <repo> && uidiff compare /dashboard
```

That compares the working tree against `HEAD`. Pass `--before-ref HEAD~1` if
the change is already committed. It captures the current state, restores the
changed files to the ref, waits for the dev server to reload, captures again,
restores your files verbatim (uncommitted work included), then writes and opens
a report with a wipe slider per region. It prints the report path, the
pixel-diff count, and before/after `getBoundingClientRect()` values for every
`--measure` selector.

**Read those numbers instead of opening the images.** They are the cheap,
precise signal — an image read costs orders of magnitude more context. Open a
crop only when a number looks wrong or the user asks what it looks like.

If a run is interrupted mid-swap, `uidiff restore` puts the files back;
`uidiff doctor` warns when a swap is pending.

## Reaching the state you want

The flags below are applied in the order written and can each repeat, so an
arbitrary click-then-hover path through the page is expressible without saving
anything:

```bash
uidiff compare /dashboard \
  --wait-for 'button[aria-label="Collapse filters"]' \
  --click    'button[aria-label="Collapse filters"]' \
  --hover    'button[aria-label="Expand filters"]' \
  --measure  'button[aria-label="Expand filters"]' \
  --crop     'button[aria-label="Expand filters"]'
```

- Hover states, tooltips and open/closed variants do not show up in a default
  page load, so they need `--click`/`--hover` to reach. `--hover` dispatches a
  real CDP mouse move, so pointer listeners fire (including ones from libraries
  like Radix that ignore synthetic DOM events).
- **`--crop` takes a selector**, and the region is computed from that element's
  live rect (union of all matches, `--pad` px of margin, default 24). You never
  work out pixel coordinates.
- `--measure` and `--crop` are keyed and labelled by the selector itself, so
  the output says which element it is talking about.
- `--full-page` captures the whole document instead of one screenful, for a
  change that lands below the fold.
- `--settle` is a ceiling, not a wait: the page is captured as soon as it stops
  fetching, and the 12000ms default is only how long to keep waiting for that.
  A "landed on a sign-in page" warning means auth, not timing.

### When the two frames disagree for reasons that are not your change

Captures are quieted before the shutter: animations are run to their end state
(not disabled, which would lose anything revealed by one), infinite ones like
spinners are pinned to their first frame, web fonts and images are awaited, and
the caret is hidden. What that cannot fix is content the page rewrites on its
own — a clock, a relative timestamp, an avatar, seeded sample data.

```bash
uidiff compare /dashboard --mask '.last-updated'
```

**`--mask <selector>`** paints that region flat in *both* frames, so it stops
counting. It is measured on the live page like `--crop`, and applied before
anything is compared or cropped.

## It refuses a comparison that cannot show anything

Before capturing, `compare` classifies the changed files and stops when none of
them can affect rendering:

```
uidiff: a screenshot of this change would show nothing.

  2 file(s) differ from HEAD, and none of them can
  affect what a page looks like:
    docs/adr-007-caching.md
    src/lib/utils.test.ts

  Say the change is not visually verifiable instead of capturing it.
  Pass --force if you disagree.
```

**Do what it says: tell the user the change is not visually verifiable, and do
not reach for `--force`** unless you have a specific reason to believe the
classification is wrong. This exits non-zero before Chrome is even started, so
it costs nothing.

Tests, stories, Cypress specs, `.d.ts` and snapshots never render. JSX, CSS,
images, fonts and HTML always do. Markdown, docs directories, lockfiles, CI
config, `.sql` and `.tf` are inert. Everything ambiguous — plain `.ts`, JSON,
route handlers, anything that could reach the DOM through a util or a data
change — still runs, with a `NOTE:` saying a visible diff is not guaranteed.

You should not need to configure this. If a project renders a template language
the defaults don't know, `classify.renders` in the config is the override.

The pixel diff is an exact count of pixels that differ in any channel,
including by one step, so a genuine change to one component routinely reports a
percent or two rather than a tiny fraction — read it as "how much of the page
moved", and compare it against the crops rather than against an absolute
threshold.

A pixel diff of exactly 0 is called out, since that means either the change is
not visible on this route or the dev server had not rebuilt yet.

## It says when the page never rendered

A route that throws — most often because its backend is down — still produces
a PNG, of an error page. Every command checks for that and warns, naming the
frames affected:

```
  WARNING: the server returned HTTP 500, so this capture is an error page
    rather than your UI.
  WARNING: this page did not render. The capture is the dev server error
    overlay, and any geometry below is that overlay, not your UI.
    page says: A server error occurred. Reload to try again.
    Most often the frontend is up but the backend API it calls is not.
```

The HTTP status of the document is recorded during capture, so a 500 is caught
without the tool knowing anything about the framework. The overlay text is a
supplement for stacks that serve an error page with a 200; its selectors
default to Next.js and Vite and are configurable.

**Report that and stop.** Do not read the geometry — it measures the overlay —
and do not treat the pixel diff as a result. When both frames are broken the
diff is 0, which is why the innocent "identical captures" explanation is
suppressed in that case: it would send the reader hunting for an invisible
change instead of a dead server.

## Putting the comparison in a PR

```bash
uidiff markdown /dashboard
```

Two steps, and the tool sets up both:

1. The PR body lands **on your clipboard** — paste it into the description.
2. Finder opens with the images selected — **drag each one onto its
   `> Drop ….gif on this line.` slot**, which replaces the line with the
   uploaded picture.

There is one image per `--crop`, so two crops is two drags. The pixel diff and
the measurement table are already in the pasted text, since numbers need no
hosting.

`markdown` takes the same route as `compare` and reads the captures that run
left behind, including which regions it cropped — it does not re-open the page,
so it works after the dev server is gone. Pass `--no-open` to skip the Finder
step.

### Why dragging rather than uploading for you

Dropping a file into a GitHub comment box puts it in GitHub's own attachment
store: free, visible to exactly the people who can already see the PR, and
**gone from the repository's history entirely**. Anything the tool could host
itself would instead live in the repo forever, and a capture of a live page can
contain real data. The drag is one gesture; it is not worth automating away.

It also means no `gh` CLI and no network access are needed to produce the body.

The moving comparison is an animated GIF because a slider cannot survive in
markdown — GitHub strips `<script>`, `<input type="range">` and `data:` image
sources. For the real drag-to-compare slider, open the HTML report from
`compare`.

## Other commands

```bash
uidiff doctor                    # config, imagemagick, chrome, dev server, auth
uidiff restore                   # undo an interrupted swap
uidiff install-deps              # brew install imagemagick, with consent
```

`uidiff --help` is the full flag list, and is worth reading once.

To get the geometry of an element without a comparison — the first move when
implementing an alignment or spacing fix — run `compare` with `--measure` and
read the "before" column, or just query the page yourself if no capture is
wanted.

If you change the tool itself, run its tests — `node --test test/*.test.mjs`.
They need no install, and they cover the file-swapping that can destroy
uncommitted work. They cannot reach Chrome, auth or a dev server, so exercise
those paths by hand against a real route before trusting a change to
`lib/cdp.mjs` or the auth code in `lib/project.mjs`.

## Configuration

`.uidiff.json` at the root of the repo being captured holds **only** per-repo
settings — `baseUrl`, `viewport`, `settleMs`, `reloadWaitMs`, `fullPage`,
`classify`, `errorSelectors`, `chromePath`, `auth`. Nothing about any
particular screen is stored, so there is no file to edit before comparing
something new and nothing to go stale when a selector is renamed.

`UIDIFF_CONFIG` overrides it. For a new repo, copy `config.example.json` to
`.uidiff.json` and set `baseUrl` and `auth`. A missing config makes `doctor`
say so and name the path it wanted.

For pages behind sign-in, `auth.mode` is one of `none`, `env` (reads a cookie
from `UIDIFF_COOKIE`), or `nextauth-offline` (mints one itself with a Next.js
app's own `@auth/core/jwt`). A cookie value is sent as a whole header, so
`"session=a; csrf=b"` sets both.

## Showing the user

Tell them the route, what the pixel diff and measurements say, and link the
report path. If you have a way to open it automatically for them, do so.
Embed a crop in chat only when a still image is the point — the interactive
wipe is better for "show me what changed".

## Prerequisites

**Both the frontend and its backend must be running, if the pages you're
capturing call one.** A route that fetches through an API on a port nothing is
listening on returns a server error, and the capture is your framework's error
overlay instead of the app.

- **Frontend** — whatever starts your dev server, e.g. `yarn dev`.
- **Backend** — whatever API your frontend talks to locally, on whatever port
  your frontend expects.
- Check before assuming, and don't start a second one:
  `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':3000|:8000'` (adjust ports), or check
  your terminals.
- Chrome or Chromium installed. The tool looks in `/Applications`, and honours
  `CHROME_PATH` or a `chromePath` config key when yours lives somewhere else.

**Ask the user to start them; don't start either yourself.** If your backend
talks to a real data source, captures can contain real data — that is the
user's call to make.
