// A wipe animation standing in for the HTML report's drag slider.
//
// GitHub strips <script>, <input type="range"> and data: image sources from
// markdown (verified against the /markdown API), so a real slider cannot
// survive in a PR body. An animated GIF is the only moving before/after a
// GitHub comment will render, and it is one <img> like any other.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIVIDER = '#4c8dff';

function identify(file) {
  const [width, height] = execFileSync(
    'magick',
    ['identify', '-format', '%w %h', file],
    { encoding: 'utf8' }
  )
    .split(' ')
    .map(Number);
  return { width, height };
}

/**
 * Sweeps a divider across `before` revealing `after`, pausing at each end so a
 * reader can take in both states, then reverses. Frames are rendered at
 * `width` CSS px rather than full capture scale: a 2x crop makes a GIF far too
 * large to attach comfortably.
 */
export function wipeGif(
  before,
  after,
  outFile,
  { width = 640, frames = 14 } = {}
) {
  const workDir = `${outFile.replace(/\.gif$/, '')}-frames`;
  mkdirSync(workDir, { recursive: true });

  const scaledBefore = join(workDir, 'before.png');
  const scaledAfter = join(workDir, 'after.png');
  const geometry = `${width}x`;
  execFileSync('magick', [before, '-resize', geometry, scaledBefore]);
  execFileSync('magick', [after, '-resize', geometry, scaledAfter]);
  const size = identify(scaledAfter);

  const sequence = [];
  for (let step = 0; step <= frames; step += 1) {
    const x = Math.round((step / frames) * size.width);
    const frame = join(workDir, `f${String(step).padStart(3, '0')}.png`);
    execFileSync('magick', [
      scaledAfter,
      '(',
      scaledBefore,
      '-crop',
      `${Math.max(x, 1)}x${size.height}+0+0`,
      '+repage',
      ')',
      '-geometry',
      '+0+0',
      '-composite',
      '-fill',
      DIVIDER,
      '-draw',
      `rectangle ${x},0 ${x + 1},${size.height}`,
      frame
    ]);
    sequence.push(frame);
  }

  const hold = (frame, times) => Array.from({ length: times }, () => frame);
  const ordered = [
    ...hold(sequence[0], 6),
    ...sequence,
    ...hold(sequence[sequence.length - 1], 6),
    ...[...sequence].reverse()
  ];

  execFileSync('magick', [
    '-delay',
    '8',
    '-loop',
    '0',
    ...ordered,
    '-layers',
    'Optimize',
    outFile
  ]);
  rmSync(workDir, { recursive: true, force: true });
  return outFile;
}
