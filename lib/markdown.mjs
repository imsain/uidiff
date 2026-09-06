// GitHub-flavoured markdown for a PR body, with slots for pasted images.
//
// Nothing here hosts an image. Dragging a file into a GitHub comment box
// uploads it to GitHub's own store, which costs nothing, stays readable to
// exactly the people who can see the PR, and leaves no trace in the
// repository's history — a real consideration when a capture of a live page
// contains real people's data. So the body carries the parts that need no
// hosting, the numbers, and marks where each picture goes.
//
// The slot is a blockquote rather than an HTML comment so it is visible in the
// rendered preview: an invisible marker is impossible to aim at.

export const MARKER = '<!-- uidiff -->';
const MARKER_END = '<!-- /uidiff -->';

const escapeCell = (value) => String(value).replace(/\|/g, '\\|');

function rectList(rects) {
  if (!rects || rects.length === 0) {
    return '—';
  }
  return rects
    .map((r) => `${r.w}×${r.h} @ ${r.x},${r.y} · centre ${r.cx},${r.cy}`)
    .join('<br>');
}

function measurementTable(measurements) {
  const entries = Object.entries(measurements ?? {});
  if (entries.length === 0) {
    return '';
  }
  const rows = entries
    .map(
      ([name, values]) =>
        `| \`${escapeCell(name)}\` | ${escapeCell(rectList(values.before))} | ${escapeCell(rectList(values.after))} |`
    )
    .join('\n');
  return [
    '#### Measured geometry (CSS px)',
    '',
    '| element | before | after |',
    '| --- | --- | --- |',
    rows,
    ''
  ].join('\n');
}

export function buildMarkdown({ target, meta, metric, pairs, measurements }) {
  const lines = [
    MARKER,
    `### Before / after — \`${target}\``,
    '',
    `\`${meta}\``,
    ''
  ];

  if (metric?.differing !== undefined) {
    const percent = (metric.fraction * 100).toFixed(3);
    const differing = metric.differing.toLocaleString();
    lines.push(
      `Pixel diff: **${differing}** of ${metric.total.toLocaleString()} px (${percent}%).`,
      ''
    );
  }
  pairs.forEach((pair, index) => {
    lines.push(`#### ${index + 1}. \`${pair.label}\``, '');
    lines.push(`> Drop \`${pair.name}\` on this line.`, '');
  });
  lines.push(measurementTable(measurements));
  lines.push(MARKER_END);
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
