// Pixel diff metric, crops, masks, and the self-contained drag-to-compare page.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function hasImageMagick() {
  return spawnSync('magick', ['-version'], { stdio: 'ignore' }).status === 0;
}

/**
 * The command that would install ImageMagick on this machine, or null when
 * there is nothing safe to offer.
 *
 * Only Homebrew, which is also the only thing this tool supports installing:
 * a screenshot utility has no business asking for a root password.
 */
export function imageMagickInstall() {
  const brew = spawnSync('brew', ['--version'], { stdio: 'ignore' });
  return brew.status === 0 ? 'brew install imagemagick' : null;
}

/** Runs the install, streaming brew's own output. True when magick now works. */
export function installImageMagick() {
  if (!imageMagickInstall()) {
    return false;
  }
  const result = spawnSync('brew', ['install', 'imagemagick'], {
    stdio: 'inherit'
  });
  return result.status === 0 && hasImageMagick();
}

function imageSize(file) {
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
 * How many pixels differ between two same-size PNGs, out of how many, or null
 * without magick.
 *
 * Deliberately not `compare -metric AE`. That is documented as an absolute
 * count of differing pixels, but a Q16 HDRI build — what Homebrew installs —
 * reports a normalised sum of channel errors instead: 8.47 for twelve solidly
 * repainted pixels, and 0.02 for two pixels moved by three levels. Presenting
 * either as "N px changed" would be a lie in the direction of reassurance.
 *
 * Differencing the two frames, flattening the channels to their per-pixel
 * maximum and thresholding at zero gives a mask of "this pixel moved at all";
 * its mean times its area is then an exact count.
 */
export function pixelDiff(before, after) {
  if (!hasImageMagick()) {
    return null;
  }
  const first = imageSize(before);
  const second = imageSize(after);
  // magick compares the overlapping region and says nothing about the rest, so
  // a page that grew would otherwise report a reassuring zero.
  if (first.width !== second.width || first.height !== second.height) {
    return {
      error:
        `image sizes differ: ${first.width}x${first.height} before, ` +
        `${second.width}x${second.height} after`
    };
  }
  const result = spawnSync(
    'magick',
    [
      before,
      after,
      '-compose',
      'difference',
      '-composite',
      '-separate',
      '-evaluate-sequence',
      'max',
      '-threshold',
      '0',
      '-format',
      '%[fx:mean*w*h]',
      'info:'
    ],
    { encoding: 'utf8' }
  );
  const differing = Math.round(Number.parseFloat(`${result.stdout ?? ''}`.trim()));
  if (Number.isNaN(differing)) {
    return {
      error: `${result.stderr ?? ''}`.trim().split('\n')[0] || 'compare failed'
    };
  }
  const total = second.width * second.height;
  return { differing, total, fraction: differing / total };
}

/** Mid-grey, so a masked region is obviously deliberate on a light or dark page. */
const MASK_FILL = '#808080';

/**
 * Paints `rects` over each of `files` in place, converting from CSS pixels to
 * captured ones. The same rectangles go onto every frame, which is the point:
 * a region masked in only one of them would differ from the other.
 *
 * ImageMagick's `rectangle` takes inclusive corners, hence the -1.
 */
export function maskFiles(files, rects, scale) {
  const draws = rects.flatMap((rect) => {
    const x = Math.round(rect.x * scale);
    const y = Math.round(rect.y * scale);
    const right = Math.round((rect.x + rect.w) * scale) - 1;
    const bottom = Math.round((rect.y + rect.h) * scale) - 1;
    return ['-draw', `rectangle ${x},${y} ${right},${bottom}`];
  });
  if (draws.length === 0) {
    return 0;
  }
  for (const file of files) {
    // Via a temporary file rather than in place: magick buffers the input, but
    // a failure part-way through would otherwise truncate the only copy.
    const scratch = `${file}.masking.png`;
    execFileSync('magick', [file, '-fill', MASK_FILL, ...draws, scratch]);
    renameSync(scratch, file);
  }
  return rects.length;
}

/**
 * Names the frames that captured an error overlay instead of the app.
 *
 * Worth saying loudly, because a broken page is the one failure that looks
 * like a result: both frames fail the same way, the pixel diff is 0, and
 * "identical captures" reads as "your change is invisible here" — a wrong
 * answer to a question that was never actually asked of the UI. Pass
 * `undefined` for a frame whose state is unknown, such as a before.png left by
 * an earlier run.
 */
export function brokenCaptureWarning(frames) {
  const broken = Object.entries(frames)
    .filter(([, isBroken]) => isBroken)
    .map(([name]) => name);
  if (broken.length === 0) {
    return null;
  }
  const noun = broken.length > 1 ? 'captures' : 'capture';
  return (
    `the ${broken.join(' and ')} ${noun} rendered an error page rather than the ` +
    'app, so this comparison says nothing about your change. Check that the ' +
    'dev server and the API it calls are both running, then re-run.'
  );
}

/**
 * The union of every match for a selector, converted from CSS pixels to
 * captured ones, padded, and clamped to the image. Deriving this from a live
 * rect is the whole reason --crop takes a selector: hand-written geometry has
 * to be recomputed by eye every time the layout moves.
 *
 * Returns null when the selector matched nothing, or when the element is
 * entirely outside the captured viewport.
 */
export function cropGeometry(rects, viewport, pad = 24) {
  if (!rects || rects.length === 0) {
    return null;
  }
  const { scale } = viewport;
  const imageWidth = viewport.width * scale;
  const imageHeight = viewport.height * scale;

  const left = Math.min(...rects.map((r) => r.x)) - pad;
  const top = Math.min(...rects.map((r) => r.y)) - pad;
  const right = Math.max(...rects.map((r) => r.x + r.w)) + pad;
  const bottom = Math.max(...rects.map((r) => r.y + r.h)) + pad;

  const x = Math.max(0, Math.round(left * scale));
  const y = Math.max(0, Math.round(top * scale));
  const width = Math.min(Math.round((right - left) * scale), imageWidth - x);
  const height = Math.min(Math.round((bottom - top) * scale), imageHeight - y);
  return width > 0 && height > 0 ? `${width}x${height}+${x}+${y}` : null;
}

/** `region` is an ImageMagick geometry in source pixels, e.g. "840x1000+0+120". */
export function crop(source, region, outFile) {
  execFileSync('magick', [
    source,
    '-crop',
    region,
    '+repage',
    '-strip',
    '-define',
    'png:compression-level=9',
    outFile
  ]);
  return outFile;
}

function dataUri(file) {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character]
  );
}

/**
 * Writes a standalone HTML page with one wipe slider per pair. Images are
 * inlined so the file can be opened from anywhere or attached elsewhere.
 */
export function buildHtml({ outDir, target, meta, pairs, measurements }) {
  const panels = pairs
    .map((pair, index) => {
      const caption = pair.label ? escapeHtml(pair.label) : `View ${index + 1}`;
      return `
    <section class="panel">
      <h2>${caption}</h2>
      <div class="frame" data-frame tabindex="0" role="slider"
           aria-label="${caption}: reveal before or after"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
           style="max-width:${pair.displayWidth}px;aspect-ratio:${pair.width} / ${pair.height}">
        <img class="after" src="${dataUri(pair.after)}" alt="After" draggable="false">
        <img class="before" src="${dataUri(pair.before)}" alt="Before" draggable="false">
        <div class="divider"></div>
        <div class="handle"></div>
        <span class="tag left">BEFORE</span>
        <span class="tag right">AFTER</span>
      </div>
    </section>`;
    })
    .join('\n');

  const measurementRows = Object.entries(measurements ?? {})
    .map(([name, values]) => {
      const format = (rects) =>
        (rects ?? [])
          .map((r) => `${r.w}x${r.h} @ ${r.x},${r.y} · centre ${r.cx},${r.cy}`)
          .join('<br>') || '—';
      return `<tr><td>${escapeHtml(name)}</td><td>${format(values.before)}</td><td>${format(values.after)}</td></tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>uidiff · ${escapeHtml(target)}</title>
<style>
  :root { color-scheme: dark light; --bg:#0f1115; --fg:#e6e6e6; --muted:#9aa0a6;
          --line:#2a2f37; --accent:#4c8dff; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { margin-bottom:24px; }
  h1 { font-size:20px; margin:0 0 6px; }
  h2 { font-size:15px; margin:0 0 4px; font-weight:600; }
  .meta { color:var(--muted); font-size:12px; font-family:ui-monospace, monospace; }
  .panel { margin:28px 0; }
  .frame { position:relative; width:100%; overflow:hidden; border:1px solid var(--line);
           border-radius:4px; cursor:ew-resize; touch-action:none; }
  .frame:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .frame img { position:absolute; inset:0; width:100%; height:100%; object-fit:fill;
               user-select:none; pointer-events:none; }
  .frame .before { clip-path: inset(0 50% 0 0); }
  .divider { position:absolute; top:0; bottom:0; left:50%; width:1px;
             background:var(--accent); pointer-events:none; }
  .handle { position:absolute; top:50%; left:50%; width:22px; height:22px;
            margin:-11px 0 0 -11px; border-radius:50%; background:var(--accent);
            border:2px solid var(--bg); pointer-events:none; }
  .tag { position:absolute; top:8px; padding:2px 6px; font:10px/1.4 ui-monospace, monospace;
         letter-spacing:.08em; background:#0008; border:1px solid var(--line);
         border-radius:3px; color:var(--fg); pointer-events:none; }
  .tag.left { left:8px; } .tag.right { right:8px; }
  table { border-collapse:collapse; margin-top:8px; font-size:13px; }
  th, td { border-bottom:1px solid var(--line); padding:6px 14px 6px 0; text-align:left;
           vertical-align:top; font-family:ui-monospace, monospace; }
  th { color:var(--muted); font-weight:500; }
  footer { margin-top:32px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(target)}</h1>
  <div class="meta">${escapeHtml(meta)}</div>
</header>
${panels}
${
  measurementRows
    ? `<section class="panel"><h2>Measured geometry (CSS px)</h2>
  <table><thead><tr><th>Element</th><th>Before</th><th>After</th></tr></thead>
  <tbody>${measurementRows}</tbody></table></section>`
    : ''
}
<footer>Drag any frame, or focus it and use the arrow keys (shift for larger steps).</footer>
<script>
for (const frame of document.querySelectorAll('[data-frame]')) {
  const before = frame.querySelector('.before');
  const divider = frame.querySelector('.divider');
  const handle = frame.querySelector('.handle');
  const tagLeft = frame.querySelector('.tag.left');
  const tagRight = frame.querySelector('.tag.right');
  let dragging = false;
  let position = 50;
  const render = () => {
    before.style.clipPath = 'inset(0 ' + (100 - position) + '% 0 0)';
    divider.style.left = position + '%';
    handle.style.left = position + '%';
    frame.setAttribute('aria-valuenow', Math.round(position));
    tagLeft.style.opacity = position > 12 ? 1 : 0;
    tagRight.style.opacity = position < 88 ? 1 : 0;
  };
  const moveTo = (clientX) => {
    const bounds = frame.getBoundingClientRect();
    position = Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100));
    render();
  };
  frame.addEventListener('pointerdown', (event) => {
    dragging = true;
    frame.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  });
  frame.addEventListener('pointermove', (event) => { if (dragging) moveTo(event.clientX); });
  frame.addEventListener('pointerup', () => { dragging = false; });
  frame.addEventListener('pointercancel', () => { dragging = false; });
  frame.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') { position = Math.max(0, position - step); render(); }
    if (event.key === 'ArrowRight') { position = Math.min(100, position + step); render(); }
  });
  render();
}
</script>
</body>
</html>
`;
  const file = join(outDir, 'compare.html');
  writeFileSync(file, html);
  return file;
}

export function openInBrowser(file) {
  spawnSync('open', [file], { stdio: 'ignore' });
  return true;
}
