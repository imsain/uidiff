// Command-line parsing. Separated from the CLI itself so it can be tested
// without running a command, because the subtleties here are invisible at the
// call site: repeated flags, selectors full of `=`, and numbers that must not
// be allowed to become NaN.

import { UiDiffError } from './project.mjs';

/**
 * Repeated flags have to keep their order — `--click X --hover Y` is a
 * different page state from the reverse — so alongside the last-wins `flags`
 * map this returns every flag in the order it was written.
 *
 * A flag with no value is `true`, which lets `--no-open` work and lets the
 * callers below tell "absent" from "given nothing".
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const ordered = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    // First `=` only: selectors are full of them, as in --click=[data-x="1"].
    const split = body.indexOf('=');
    const name = split === -1 ? body : body.slice(0, split);
    let value = split === -1 ? undefined : body.slice(split + 1);
    if (value === undefined) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    flags[name] = value;
    ordered.push({ name, value });
  }
  return { positional, flags, ordered };
}

/**
 * A numeric flag, or a legible failure.
 *
 * Every consumer of these treats NaN as "skip" rather than as an error:
 * `if (step.wait)` is false for NaN, and setTimeout coerces it to zero. So
 * `--settle 12O00` with a letter O would silently capture a page that had not
 * finished rendering and report it as the truth. Checking here is the only
 * place that failure is still legible.
 *
 * The two values Number() is too forgiving about are both rejected explicitly:
 * a bare `--settle` arrives as `true` and converts to a plausible-looking 1ms,
 * and an empty string converts to 0 — which is what `--wait "$UNSET_VAR"`
 * produces, the same silent skip by a different route.
 */
export function numberFlag(name, value) {
  const empty = typeof value === 'boolean' || String(value).trim() === '';
  const parsed = empty ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UiDiffError(
      `--${name} needs a non-negative number, got ${JSON.stringify(value)}`
    );
  }
  return parsed;
}
