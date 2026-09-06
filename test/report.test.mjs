import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  brokenCaptureWarning,
  buildHtml,
  hasImageMagick,
  maskFiles,
  pixelDiff
} from '../lib/report.mjs';

// The image operations are ImageMagick's, so without it there is nothing here
// to test rather than something failing.
const needsMagick = { skip: hasImageMagick() ? false : 'ImageMagick not installed' };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'uidiff-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const rgb = ([r, g, b]) => `rgb(${r},${g},${b})`;

/** Writes a solid PNG with an optional differently-coloured rectangle. */
function writePng(file, { width, height, colour, rect }) {
  execFileSync('magick', [
    '-size',
    `${width}x${height}`,
    `xc:${rgb(colour)}`,
    ...(rect
      ? [
          '-fill',
          rgb(rect.colour),
          '-draw',
          `rectangle ${rect.x},${rect.y} ${rect.x + rect.w - 1},${rect.y + rect.h - 1}`
        ]
      : []),
    file
  ]);
  return file;
}

/** The RGB of one pixel, read back through magick rather than a decoder. */
function pixelAt(file, x, y) {
  const text = execFileSync(
    'magick',
    [file, '-format', '%[pixel:p{' + x + ',' + y + '}]', 'info:'],
    { encoding: 'utf8' }
  ).trim();
  return text;
}

test('says nothing when both frames rendered the app', () => {
  assert.equal(brokenCaptureWarning({ before: false, after: false }), null);
});

test('names a single broken frame, in the singular', () => {
  const warning = brokenCaptureWarning({ before: false, after: true });
  assert.match(warning, /the after capture rendered an error page/);
  assert.doesNotMatch(warning, /before/);
});

test('names both broken frames, in the plural', () => {
  const warning = brokenCaptureWarning({ before: true, after: true });
  assert.match(warning, /the before and after captures rendered an error page/);
});

test('tells the reader to check both servers, not just the dev server', () => {
  const warning = brokenCaptureWarning({ before: true, after: true });
  // The whole point: a missing API is the usual cause, and a message that
  // mentions only the dev server sends people to look at one that is fine.
  assert.match(warning, /dev server and the API it calls/);
});

test('an unknown frame is not reported as broken', () => {
  // before.png left by an earlier run: its state was never observed, so
  // claiming it rendered an error would be inventing a fact.
  assert.equal(brokenCaptureWarning({ before: undefined, after: false }), null);
  const warning = brokenCaptureWarning({ before: undefined, after: true });
  assert.match(warning, /the after capture/);
  assert.doesNotMatch(warning, /before/);
});

test('the pixel diff counts and proportions', needsMagick, (t) => {
  const dir = scratch(t);
  const before = join(dir, 'before.png');
  const after = join(dir, 'after.png');
  const base = { width: 40, height: 20, colour: [10, 20, 30] };
  writePng(before, base);
  writePng(after, {
    ...base,
    rect: { x: 5, y: 5, w: 4, h: 3, colour: [200, 200, 200] }
  });

  const metric = pixelDiff(before, after);
  assert.equal(metric.differing, 12, 'an exact count, not a channel-error sum');
  assert.equal(metric.total, 800);
  assert.equal(metric.fraction, 12 / 800);
});

test('a change in one channel still counts as a changed pixel', needsMagick, (t) => {
  const dir = scratch(t);
  const base = { width: 10, height: 10, colour: [100, 100, 100] };
  const before = writePng(join(dir, 'before.png'), base);
  const after = writePng(join(dir, 'after.png'), {
    ...base,
    rect: { x: 0, y: 0, w: 2, h: 1, colour: [103, 100, 100] }
  });

  // ImageMagick's own AE metric calls this 0.02 on an HDRI build. Two pixels
  // moved, so the answer is two.
  assert.equal(pixelDiff(before, after).differing, 2);
});

test('identical frames report zero rather than an error', needsMagick, (t) => {
  const dir = scratch(t);
  const before = writePng(join(dir, 'before.png'), {
    width: 8,
    height: 8,
    colour: [0, 0, 0]
  });
  const after = writePng(join(dir, 'after.png'), {
    width: 8,
    height: 8,
    colour: [0, 0, 0]
  });

  assert.equal(pixelDiff(before, after).differing, 0);
});

test('mismatched captures report the reason instead of throwing', needsMagick, (t) => {
  const dir = scratch(t);
  const before = writePng(join(dir, 'before.png'), {
    width: 8,
    height: 8,
    colour: [0, 0, 0]
  });
  const after = writePng(join(dir, 'after.png'), {
    width: 8,
    height: 9,
    colour: [0, 0, 0]
  });

  // A full-page capture of a page that grew is the ordinary way to get here,
  // and it must not take the whole comparison down with it.
  // magick compares only the overlapping region and reports a contented zero,
  // so the size check has to happen before it is asked.
  const metric = pixelDiff(before, after);
  assert.match(metric.error, /image sizes differ/);
  assert.equal(metric.differing, undefined);
});

test('masking is applied to every frame, in captured pixels', needsMagick, (t) => {
  const dir = scratch(t);
  const before = join(dir, 'before.png');
  const after = join(dir, 'after.png');
  const base = { width: 40, height: 40, colour: [10, 20, 30] };
  // A clock that reads differently in each frame.
  writePng(before, {
    ...base,
    rect: { x: 4, y: 4, w: 8, h: 4, colour: [0, 0, 0] }
  });
  writePng(after, {
    ...base,
    rect: { x: 4, y: 4, w: 8, h: 4, colour: [255, 255, 255] }
  });
  assert.equal(pixelDiff(before, after).differing, 32);

  // The selector was measured in CSS pixels at scale 2, so the rect is half
  // the size of the region it has to cover in the image.
  assert.equal(maskFiles([before, after], [{ x: 2, y: 2, w: 4, h: 2 }], 2), 1);
  assert.equal(
    pixelDiff(before, after).differing,
    0,
    'the region that disagreed is painted flat in both'
  );
  assert.match(
    pixelAt(before, 0, 0),
    /srgb\(10,20,30\)/,
    'and the rest of the frame is untouched'
  );
});

test('the report inlines both frames and labels them', needsMagick, (t) => {
  const dir = scratch(t);
  const one = writePng(join(dir, 'one.png'), {
    width: 4,
    height: 4,
    colour: [0, 0, 0]
  });
  const two = writePng(join(dir, 'two.png'), {
    width: 4,
    height: 4,
    colour: [255, 255, 255]
  });

  const html = readFileSync(
    buildHtml({
      outDir: dir,
      target: '/x',
      meta: '',
      pairs: [
        { before: one, after: two, width: 4, height: 4, displayWidth: 100 }
      ]
    }),
    'utf8'
  );
  assert.match(html, /class="tag left">BEFORE</);
  assert.match(html, /class="tag right">AFTER</);
  // Inlined, so the file can be moved or attached without losing its images.
  assert.match(html, /src="data:image\/png;base64,/);
});
