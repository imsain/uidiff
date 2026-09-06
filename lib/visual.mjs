// Decides whether a set of changed files could possibly alter what a page
// looks like, so a comparison that is guaranteed to show nothing can be
// refused before spending thirty seconds and two screenshots on it.
//
// The classification is deliberately coarse. Being wrong in the cautious
// direction costs a capture; being wrong the other way hides a real
// regression, so anything that might reach the DOM counts as "unclear" and
// still runs.
//
// The extension lists describe a JavaScript front end — JSX, CSS, images,
// fonts. A project that renders something else adds it through
// `classify.renders` rather than by editing this file.

/**
 * Never renders, and this beats a render match — a `.tsx` under `__tests__` or
 * a `.stories.tsx` is not application UI, and getting that backwards would
 * stop the refusal ever firing on the most common non-visual change there is.
 */
const ALWAYS_INERT = [
  /\.(test|spec)\.[jt]sx?$/,
  /\.stories\.[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__|__snapshots__)\//,
  /(^|\/)cypress\//,
  /\.cy\.[jt]sx?$/,
  /\.snap$/,
  /\.d\.ts$/
];

/**
 * Inert unless something says otherwise. A render match wins here, so a
 * project whose markdown *is* the page can opt its content back in through
 * `classify.renders` without also un-refusing its test suite.
 */
const SOFT_INERT = [
  /\.mdc?$/,
  /(^|\/)docs?\//,
  /(^|\/)\.(github|husky|cursor|claude|vscode|idea)\//,
  /\.sql$/,
  /\.(tf|tfvars)$/,
  /\.(ya?ml|toml|ini|lock)$/,
  /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/,
  /(^|\/)\.[a-z]*ignore$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)makefile$/i,
  /\.env(\.|$)/
];

/** Changes pixels: markup, styles, and the assets they pull in. */
const RENDERS = [
  /\.(tsx|jsx|mjsx)$/,
  /(^|\/)tailwind\.config\.[jt]s$/,
  /\.(css|scss|sass|less|styl)$/,
  /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp)$/,
  /\.(woff2?|ttf|otf|eot)$/,
  /\.html?$/
];

const toRegExp = (pattern) =>
  pattern instanceof RegExp ? pattern : new RegExp(pattern);

/** The rule set for one repo: the defaults, plus whatever its config adds. */
export function buildRules({ config } = {}) {
  const classify = config?.classify ?? {};
  return {
    alwaysInert: [
      ...ALWAYS_INERT,
      ...(classify.neverVisual ?? []).map(toRegExp)
    ],
    renders: [...RENDERS, ...(classify.renders ?? []).map(toRegExp)],
    softInert: SOFT_INERT
  };
}

const matches = (patterns, file) =>
  patterns.some((pattern) => pattern.test(file));

/**
 * Sorts `files` into the ones that render, the ones that cannot, and the
 * ambiguous middle — plain `.ts`, `.json` and the like, which reach the screen
 * often enough (a util, a hook, a view model, a translation string) that
 * refusing to capture would be wrong.
 *
 * verdict is one of:
 *   nothing   — no files changed at all
 *   invisible — every changed file is in the cannot-render set
 *   unclear   — nothing obviously renders, but something might
 *   visual    — at least one file definitely renders
 */
export function classifyChange(files, rules = buildRules()) {
  const renders = [];
  const inert = [];
  const unclear = [];

  for (const file of files) {
    if (matches(rules.alwaysInert, file)) {
      inert.push(file);
    } else if (matches(rules.renders, file)) {
      renders.push(file);
    } else if (matches(rules.softInert, file)) {
      inert.push(file);
    } else {
      unclear.push(file);
    }
  }

  const verdict = (() => {
    if (files.length === 0) {
      return 'nothing';
    }
    if (renders.length > 0) {
      return 'visual';
    }
    return unclear.length > 0 ? 'unclear' : 'invisible';
  })();

  return { verdict, renders, unclear, inert };
}
