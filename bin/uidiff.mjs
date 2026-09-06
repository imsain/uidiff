#!/usr/bin/env node
// uidiff — before/after UI screenshots for a local dev server.
//
//   uidiff doctor
//   uidiff compare <path> [--before-ref HEAD] [--crop <selector>]
//   uidiff markdown <path>
//   uidiff restore
//   uidiff install-deps
//
// There are no saved presets. Every run names its own route, interactions and
// regions on the command line, so any change to any screen can be compared
// without editing a config file first — and a selector that gets renamed
// breaks nothing, because nothing stored it.
//
// Output is deliberately terse plain text: it is read by an agent far more
// often than by a human, and images cost far more context than numbers.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UiDiffError,
  authCookie,
  configPath,
  loadConfig,
  outDir,
  projectName,
  readJson,
  repoRoot,
  slugFor,
  targetUrl,
  writeJson
} from '../lib/project.mjs';
import { capture, chromeStatus, ensureChrome } from '../lib/cdp.mjs';
import {
  changedAgainst,
  hasPendingSwap,
  restoreSwap,
  swapToRef
} from '../lib/gitswap.mjs';
import {
  brokenCaptureWarning,
  buildHtml,
  crop,
  cropGeometry,
  hasImageMagick,
  imageMagickInstall,
  installImageMagick,
  maskFiles,
  openInBrowser,
  pixelDiff
} from '../lib/report.mjs';
import { numberFlag, parseArgs } from '../lib/args.mjs';
import { buildMarkdown } from '../lib/markdown.mjs';
import { wipeGif } from '../lib/wipe.mjs';
import { buildRules, classifyChange } from '../lib/visual.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const STEP_FLAGS = {
  'wait-for': (value) => ({ waitFor: value }),
  click: (value) => ({ click: value }),
  hover: (value) => ({ hover: value }),
  wait: (value) => ({ wait: numberFlag('wait', value) })
};

function targetFromArgs(config, args) {
  const path = args.positional[1];
  const url = targetUrl(config, path);
  const values = (name) =>
    args.ordered
      .filter((entry) => entry.name === name)
      .map((entry) => {
        if (entry.value === true) {
          throw new UiDiffError(`--${name} needs a value`);
        }
        return String(entry.value);
      });

  const steps = args.ordered
    .filter((entry) => entry.name in STEP_FLAGS)
    .map((entry) => {
      if (entry.value === true) {
        throw new UiDiffError(`--${entry.name} needs a value`);
      }
      return STEP_FLAGS[entry.name](String(entry.value));
    });

  return {
    path,
    url,
    slug: slugFor(path),
    steps,
    measureSelectors: values('measure'),
    cropSelectors: values('crop'),
    maskSelectors: values('mask'),
    settleMs: numberFlag('settle', args.flags.settle ?? config.settleMs),
    pad: numberFlag('pad', args.flags.pad ?? 24),
    fullPage: Boolean(args.flags['full-page'] ?? config.fullPage)
  };
}

function formatRects(rects) {
  if (!rects || rects.length === 0) {
    return 'not found';
  }
  return rects
    .map((r) => `${r.w}x${r.h} at (${r.x},${r.y}) centre (${r.cx},${r.cy})`)
    .join(' | ');
}

function cropName(label, index) {
  const readable = label
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .toLowerCase();
  return `${index + 1}-${readable || 'region'}`;
}

/** The width and height named by one of our own WxH+X+Y geometries. */
function geometrySize(geometry) {
  const [width, height] = geometry.split('+')[0].split('x').map(Number);
  return { width, height };
}

async function captureLabel({ root, config, target, label }) {
  const { port } = await ensureChrome(config.chromePort, config.chromePath);
  const cookie = authCookie(root, config);
  const dir = outDir(root, target.slug);
  const outFile = join(dir, `${label}.png`);
  // Crop and mask selectors are measured too, since that is how their regions
  // are found.
  const measure = Object.fromEntries(
    [
      ...target.measureSelectors,
      ...target.cropSelectors,
      ...target.maskSelectors
    ].map((selector) => [selector, selector])
  );
  const {
    measurements,
    finalUrl,
    devError,
    status,
    settled,
    stabilised,
    clamped,
    captured
  } = await capture({
    port,
    url: target.url,
    outFile,
    viewport: config.viewport,
    steps: target.steps,
    measure,
    cookie,
    errorSelectors: config.errorSelectors,
    settleMs: target.settleMs,
    fullPage: target.fullPage
  });
  if (settled && !settled.quiet) {
    console.log(
      `  NOTE: the page was still loading after ${settled.waitedMs}ms, so this` +
        ' capture may differ from the other for reasons unrelated to your' +
        ' change. Raise --settle if the comparison looks noisy.'
    );
  }
  if (clamped) {
    console.log(
      `  WARNING: the page is ${clamped.asked}px tall but Chrome cannot` +
        ` rasterise past ${clamped.taken}px at this scale, so the capture is` +
        ' cut off. Lower viewport.scale to fit more in.'
    );
  }
  if (new URL(finalUrl).pathname.includes('signin')) {
    console.log(
      `  WARNING: landed on ${finalUrl} — the capture is probably a sign-in page.`
    );
  }
  const failedStatus = status >= 400 ? `HTTP ${status}` : null;
  if (failedStatus) {
    console.log(
      `  WARNING: the server returned ${failedStatus}, so this capture is an` +
        ' error page rather than your UI.'
    );
  }
  if (devError) {
    console.log(
      '  WARNING: this page did not render. The capture is the dev server' +
        ' error overlay, and any geometry below is that overlay, not your UI.'
    );
    console.log(`    page says: ${devError}`);
    console.log(
      '    Most often the frontend is up but the backend API it calls is not.'
    );
  }
  return {
    outFile,
    measurements,
    captured,
    stabilised,
    devError: devError ?? failedStatus
  };
}

/**
 * Refuses, before anything is captured, a comparison that cannot show
 * anything. A screenshot pair costs half a minute and a lot of context, and an
 * unchanged image invites the reader to hunt for a difference that was never
 * there.
 */
function preflight(root, config, args, beforeRef) {
  const paths = args.flags.paths ? String(args.flags.paths).split(',') : [];
  const files = changedAgainst(root, beforeRef, paths);
  const { verdict, unclear, inert } = classifyChange(
    files,
    buildRules({ config })
  );

  if (verdict === 'nothing') {
    throw new UiDiffError(
      `nothing differs from ${beforeRef}, so there is no "before" state to build.`
    );
  }
  if (verdict === 'invisible' && !args.flags.force) {
    throw new UiDiffError(
      [
        'a screenshot of this change would show nothing.',
        '',
        `  ${inert.length} file(s) differ from ${beforeRef}, and none of them can`,
        '  affect what a page looks like:',
        ...inert.map((file) => `    ${file}`),
        '',
        '  Say the change is not visually verifiable instead of capturing it.',
        '  Pass --force if you disagree.'
      ].join('\n')
    );
  }
  if (verdict === 'unclear') {
    console.log(
      `NOTE: nothing that certainly renders differs from ${beforeRef}, so a` +
        ' visible diff is not guaranteed. Changed:'
    );
    for (const file of unclear) {
      console.log(`  ${file}`);
    }
  }
  return files;
}

/**
 * Without ImageMagick a comparison still runs, but it loses the crops, the
 * pixel count, the masks and the wipe — nearly everything a reader looks at.
 * That used to happen silently, which is the worst option: the report just
 * quietly got worse. Stop instead, and let the caller offer to install it.
 */
function requireImageMagick(args) {
  if (hasImageMagick() || args.flags['skip-crops']) {
    return;
  }
  const install = imageMagickInstall();
  throw new UiDiffError(
    [
      'ImageMagick is not installed, and without it this comparison loses the',
      '  cropped regions, the pixel-diff count and the wipe animation — most of',
      '  what makes the report worth reading.',
      '',
      ...(install
        ? [
            '  Ask the user whether to install it, and if they agree run:',
            '    uidiff install-deps',
            `  which is "${install}", nothing more.`
          ]
        : [
            '  Install Homebrew, or install ImageMagick some other way, and run',
            '  this again.'
          ]),
      '',
      '  Or pass --skip-crops to accept the full-page pair on its own.'
    ].join('\n')
  );
}

async function commandCompare(root, config, args) {
  const target = targetFromArgs(config, args);
  const dir = outDir(root, target.slug);
  // The "before" state is always rebuilt from git, so a ref is always needed.
  // HEAD is the answer nearly every time: it compares the working tree with
  // the last commit, which is the change you are in the middle of making.
  const beforeRef = args.flags['before-ref'] ?? 'HEAD';
  // After the preflight: no point asking anyone to install a dependency for a
  // comparison that is about to be refused anyway.
  const files = preflight(root, config, args, beforeRef);
  requireImageMagick(args);
  const magick = hasImageMagick();
  const reloadWait = numberFlag(
    'reload-wait',
    args.flags['reload-wait'] ?? config.reloadWaitMs
  );
  const measurements = {};

  const after = await captureLabel({ root, config, target, label: 'after' });
  measurements.after = after.measurements;
  console.log(`captured after -> ${after.outFile}`);

  let beforeFile;
  let beforeDevError;
  console.log(
    `swapping ${files.length} file(s) to ${beforeRef}: ${files.join(', ')}`
  );
  const restore = swapToRef(root, beforeRef, files);
  try {
    await sleep(reloadWait);
    const before = await captureLabel({ root, config, target, label: 'before' });
    beforeFile = before.outFile;
    measurements.before = before.measurements;
    beforeDevError = Boolean(before.devError);
    console.log(`captured before -> ${beforeFile}`);
  } finally {
    const count = restore();
    console.log(`restored ${count} file(s) to their pre-swap contents`);
  }
  await sleep(reloadWait);

  // Masks go on before anything is measured or cropped, and onto both frames,
  // so content that rewrites itself between the two captures stops counting.
  if (target.maskSelectors.length > 0 && magick) {
    const maskRects = target.maskSelectors.flatMap((selector) => [
      ...(measurements.before?.[selector] ?? []),
      ...(measurements.after?.[selector] ?? [])
    ]);
    if (maskRects.length === 0) {
      console.log('  WARNING: --mask matched nothing, so nothing was masked out.');
    } else {
      maskFiles([beforeFile, after.outFile], maskRects, config.viewport.scale);
      console.log(`masked ${maskRects.length} region(s) in both frames`);
    }
  }

  const metric = pixelDiff(beforeFile, after.outFile);
  if (metric?.error) {
    console.log(
      `  WARNING: could not measure the pixel diff (${metric.error}).` +
        ' The captures are fine; only the number is missing.'
    );
  }
  const broken = brokenCaptureWarning({
    before: beforeDevError,
    after: Boolean(after.devError)
  });
  if (metric?.differing !== undefined) {
    console.log(
      `pixel diff: ${metric.differing} of ${metric.total} px ` +
        `(${(metric.fraction * 100).toFixed(3)}%)`
    );
    // A broken page explains an identical pair; don't also offer the innocent
    // explanations, which would send the reader looking in the wrong place.
    if (metric.differing === 0 && !broken) {
      console.log(
        '  WARNING: identical captures — the change may not be visible here, or' +
          ' the dev server may not have reloaded yet.'
      );
    }
  }
  if (broken) {
    console.log(`  WARNING: ${broken}`);
  }

  // A full-page capture is taller than the viewport, and a crop has to be
  // clamped to the image that actually exists rather than to one screenful.
  const frame = { ...config.viewport, height: after.captured.height };

  const regions = [];
  if (magick) {
    target.cropSelectors.forEach((selector, index) => {
      // One region for both frames — a wipe between differently-cropped images
      // compares different parts of the page — but spanning where the element
      // was *and* where it ended up. Deriving it from "after" alone clips the
      // before frame whenever something moved further than --pad, which is
      // exactly what an alignment fix does.
      const geometry = cropGeometry(
        [
          ...(measurements.before?.[selector] ?? []),
          ...(after.measurements[selector] ?? [])
        ],
        frame,
        target.pad
      );
      if (!geometry) {
        console.log(
          `  WARNING: --crop ${selector} matched nothing; skipping it.`
        );
        return;
      }
      regions.push({ name: cropName(selector, index), label: selector, geometry });
    });
  }

  const pairs = regions.map((region) => {
    const { width, height } = geometrySize(region.geometry);
    return {
      label: region.label,
      before: crop(
        beforeFile,
        region.geometry,
        join(dir, `${region.name}-before.png`)
      ),
      after: crop(
        after.outFile,
        region.geometry,
        join(dir, `${region.name}-after.png`)
      ),
      width,
      height,
      displayWidth: 720
    };
  });
  pairs.push({
    label: target.fullPage ? 'Full page' : 'Viewport',
    before: beforeFile,
    after: after.outFile,
    width: frame.width * frame.scale,
    height: frame.height * frame.scale,
    displayWidth: 900
  });

  const pairedMeasurements = {};
  for (const selector of new Set([
    ...Object.keys(measurements.before ?? {}),
    ...Object.keys(measurements.after ?? {})
  ])) {
    pairedMeasurements[selector] = {
      before: measurements.before?.[selector],
      after: measurements.after?.[selector]
    };
  }

  const meta = `${projectName(root)} · ${target.url} · ${config.viewport.width}x${config.viewport.height} @${config.viewport.scale}x · before = ${beforeRef}`;
  const html = buildHtml({
    outDir: dir,
    target: target.path,
    meta,
    pairs,
    measurements: pairedMeasurements
  });
  console.log(`report: ${html}`);

  // "uidiff markdown" runs later, against these captures rather than the page,
  // so the regions and numbers this run chose have to outlive the process.
  writeJson(join(dir, 'run.json'), {
    target: target.path,
    meta,
    metric,
    measurements: pairedMeasurements,
    regions: regions.map(({ name, label }) => ({ name, label }))
  });

  for (const [selector, values] of Object.entries(pairedMeasurements)) {
    console.log(`  ${selector}:`);
    console.log(`    before ${formatRects(values.before)}`);
    console.log(`    after  ${formatRects(values.after)}`);
  }

  if (!args.flags['no-open']) {
    openInBrowser(html);
  }
}

async function commandMarkdown(root, config, args) {
  const path = args.positional[1];
  targetUrl(config, path);
  const dir = outDir(root, slugFor(path));
  const beforeFile = join(dir, 'before.png');
  const afterFile = join(dir, 'after.png');
  if (!existsSync(beforeFile) || !existsSync(afterFile)) {
    throw new UiDiffError(
      `no captures for ${path}. Run ` +
        `"uidiff compare ${path} --before-ref HEAD" first.`
    );
  }
  const run = readJson(join(dir, 'run.json'), {});
  const pairs = [];

  for (const region of hasImageMagick() ? (run.regions ?? []) : []) {
    const before = join(dir, `${region.name}-before.png`);
    const after = join(dir, `${region.name}-after.png`);
    if (!existsSync(before) || !existsSync(after)) {
      continue;
    }
    const name = `${region.name}-wipe.gif`;
    pairs.push({
      label: region.label,
      file: wipeGif(before, after, join(dir, name), { width: 640 }),
      name
    });
  }

  // One picture per region keeps the paste step trivial. With no regions the
  // full-page pair IS the comparison rather than the footnote it would
  // otherwise be.
  if (pairs.length === 0) {
    pairs.push(
      { label: 'Before', file: beforeFile, name: 'before.png' },
      { label: 'After', file: afterFile, name: 'after.png' }
    );
  }

  const markdown = buildMarkdown({
    target: run.target ?? path,
    meta: run.meta ?? `${projectName(root)} · ${targetUrl(config, path)}`,
    metric: run.metric ?? pixelDiff(beforeFile, afterFile),
    pairs,
    measurements: run.measurements
  });
  const file = join(dir, 'body.md');
  writeFileSync(file, markdown);

  const copied = spawnSync('pbcopy', { input: markdown }).status === 0;
  if (!args.flags['no-open']) {
    // -R reveals the file with it already selected, so the drag is the very
    // next thing the hands do.
    spawnSync('open', ['-R', pairs[0].file], { stdio: 'ignore' });
  }

  console.log(`markdown: ${file}`);
  console.log('');
  console.log(
    copied
      ? '1. The body is on your clipboard — paste it into the PR description.'
      : `1. Copy the body from ${file} into the PR description.`
  );
  console.log(
    `2. Drag ${pairs.length === 1 ? 'this file' : 'these files'} from Finder onto the` +
      ' matching "Drop ..." line, which replaces it:'
  );
  for (const pair of pairs) {
    console.log(`     ${pair.file}`);
  }
  console.log('');
  console.log(markdown);
}

async function commandDoctor(root, config) {
  console.log(`repo: ${root}`);
  console.log(`config: ${configPath(root)}`);
  console.log(
    `viewport: ${config.viewport.width}x${config.viewport.height} @${config.viewport.scale}x`
  );
  console.log(
    `imagemagick: ${
      hasImageMagick()
        ? 'installed'
        : 'missing — run "uidiff install-deps" to add it'
    }`
  );
  const status = await chromeStatus(config.chromePort);
  console.log(
    `chrome: ${status.running ? `running (${status.browser})` : 'not running'} on port ${status.port}`
  );
  try {
    const response = await fetch(config.baseUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000)
    });
    console.log(`dev server: ${config.baseUrl} -> HTTP ${response.status}`);
  } catch (error) {
    console.log(`dev server: ${config.baseUrl} unreachable (${error.message})`);
  }
  const cookie = authCookie(root, config);
  console.log(
    `auth: ${cookie ? `${cookie.split('=')[0]} minted` : 'none configured'}`
  );
  if (hasPendingSwap(root)) {
    console.log(
      'WARNING: an unrestored git swap exists. Run "uidiff restore".'
    );
  }
}

const HELP = `uidiff — before/after UI screenshots for a local dev server

  uidiff doctor                      check config, chrome, dev server, auth
  uidiff compare <path> [--before-ref <ref>]
  uidiff markdown <path> [--no-open]
  uidiff restore                     undo an interrupted --before-ref swap
  uidiff install-deps                brew install imagemagick, with consent

  <path> is a route on the dev server, e.g. /dashboard

  Reaching the state you want, applied in the order written, repeatable:
    --wait-for <selector>            block until it exists
    --click <selector>
    --hover <selector>               a real mouse move, so Radix-style code reacts
    --wait <ms>
    --settle <ms>                    how long to keep waiting for the page to
                                     stop fetching, not a fixed wait (default 12000)

  What to look at, repeatable:
    --measure <selector>             report getBoundingClientRect, before vs after
    --crop <selector>                compare one region closely
    --mask <selector>                paint a region flat in both frames, so
                                     content that changes on its own (clocks,
                                     avatars, sample data) stops counting
    --pad <px>                       padding around a --crop selector (default 24)
    --full-page                      capture the whole document, not one screenful

  compare only:
    --before-ref <ref>               the git ref to rebuild "before" from
                                     (default HEAD)
    --paths a,b                      limit the git swap to these files
    --reload-wait <ms>               how long the dev server needs after a swap
    --force                          capture even when no visual change is detected
    --skip-crops                     proceed without imagemagick, full page only
    --no-open
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  if (!command || command === 'help' || args.flags.help) {
    console.log(HELP);
    return;
  }

  // Said once, plainly, rather than failing later inside `open` or `pbcopy`.
  if (process.platform !== 'darwin') {
    throw new UiDiffError(
      `this build is macOS only, and this is ${process.platform}.`
    );
  }

  if (command === 'install-deps') {
    if (hasImageMagick()) {
      console.log('imagemagick: already installed, nothing to do');
      return;
    }
    const install = imageMagickInstall();
    if (!install) {
      throw new UiDiffError(
        'no Homebrew here. Install ImageMagick some other way and run this again.'
      );
    }
    if (!installImageMagick()) {
      throw new UiDiffError(`"${install}" did not leave a working "magick".`);
    }
    console.log('imagemagick: installed');
    return;
  }

  const root = repoRoot();

  if (command === 'restore') {
    const count = restoreSwap(root);
    console.log(count ? `restored ${count} file(s)` : 'nothing to restore');
    return;
  }

  const config = loadConfig(root);

  switch (command) {
    case 'doctor':
      await commandDoctor(root, config);
      return;
    case 'compare':
      await commandCompare(root, config, args);
      return;
    case 'markdown':
      await commandMarkdown(root, config, args);
      return;
    default:
      throw new UiDiffError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch((error) => {
  if (error instanceof UiDiffError) {
    console.error(`uidiff: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
