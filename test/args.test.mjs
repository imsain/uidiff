// A mis-parsed flag does not fail, it quietly changes what gets captured — a
// skipped wait, an unsettled page — and the screenshot still looks plausible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberFlag, parseArgs } from '../lib/args.mjs';

test('separates positionals from flags', () => {
  const args = parseArgs(['compare', '/dashboard', '--before-ref', 'HEAD']);
  assert.deepEqual(args.positional, ['compare', '/dashboard']);
  assert.equal(args.flags['before-ref'], 'HEAD');
});

test('a flag with nothing after it is true, so --no-open works', () => {
  const args = parseArgs(['markdown', '/x', '--no-open']);
  assert.equal(args.flags['no-open'], true);
});

test('a flag followed by another flag does not swallow it', () => {
  const args = parseArgs(['compare', '/x', '--force', '--before-ref', 'HEAD']);
  assert.equal(args.flags.force, true);
  assert.equal(args.flags['before-ref'], 'HEAD');
});

test('splits on the first = only, because selectors are full of them', () => {
  const args = parseArgs(['compare', '/x', '--click=[data-testid="a=b"]']);
  assert.equal(args.flags.click, '[data-testid="a=b"]');
});

test('keeps repeated flags in the order written', () => {
  // --click X --hover Y reaches a different state than the reverse, so the
  // last-wins map alone cannot express what the run should do.
  const args = parseArgs([
    'compare',
    '/x',
    '--click',
    '.first',
    '--hover',
    '.second',
    '--click',
    '.third'
  ]);
  assert.deepEqual(
    args.ordered.map((entry) => `${entry.name}:${entry.value}`),
    ['click:.first', 'hover:.second', 'click:.third']
  );
  assert.equal(args.flags.click, '.third', 'flags map still last-wins');
});

test('accepts the numbers it should', () => {
  assert.equal(numberFlag('wait', '500'), 500);
  assert.equal(numberFlag('settle', 12000), 12000);
  assert.equal(numberFlag('wait', '0'), 0);
  assert.equal(numberFlag('pad', '1.5'), 1.5);
});

test('rejects a typo instead of turning it into "skip"', () => {
  // The whole point: Number('12O00') is NaN, `if (step.wait)` is false for
  // NaN, and setTimeout(NaN) fires immediately — so without this the page is
  // captured before it finished rendering and nothing says so.
  assert.throws(
    () => numberFlag('settle', '12O00'),
    /--settle needs a non-negative number/
  );
  assert.throws(() => numberFlag('wait', 'foo'), /got "foo"/);
});

test('rejects an empty value, which Number() would read as 0', () => {
  // `--wait "$UNSET_VAR"` is the realistic way to get here, and 0 is a silent
  // skip wearing a valid number's clothes.
  assert.throws(() => numberFlag('wait', ''), /--wait/);
  assert.throws(() => numberFlag('wait', '   '), /--wait/);
});

test('rejects a bare flag, which Number() would read as 1', () => {
  // `--settle` with no value parses to true, and Number(true) is 1: a
  // perfectly plausible millisecond count that silently disables the settle.
  assert.throws(() => numberFlag('settle', true), /needs a non-negative/);
  assert.throws(() => numberFlag('settle', false), /needs a non-negative/);
});

test('rejects values that are numbers but not durations', () => {
  assert.throws(() => numberFlag('wait', '-1'), /non-negative/);
  assert.throws(() => numberFlag('settle', 'Infinity'), /non-negative/);
  assert.throws(() => numberFlag('pad', 'NaN'), /non-negative/);
});
