// Only the first cookie pair used to be set, and Chrome was only ever looked
// for in five fixed places. Both quietly excluded whole classes of user: apps
// that need a session plus a CSRF cookie, and anyone not on the two platforms
// the original list covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromeBinary, parseCookies } from '../lib/cdp.mjs';
import { makeRepo } from './helpers.mjs';

test('no cookie configured means no cookies to set', () => {
  assert.deepEqual(parseCookies(null), []);
  assert.deepEqual(parseCookies(''), []);
});

test('splits a header into every pair it carries', () => {
  assert.deepEqual(parseCookies('session=abc; csrf=xyz'), [
    { name: 'session', value: 'abc' },
    { name: 'csrf', value: 'xyz' }
  ]);
});

test('keeps a value that itself contains "="', () => {
  assert.deepEqual(parseCookies('session=aGVsbG8='), [
    { name: 'session', value: 'aGVsbG8=' }
  ]);
});

test('tolerates the spacing people actually write', () => {
  assert.deepEqual(parseCookies('  a=1 ;b=2;  '), [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' }
  ]);
});

test('drops fragments that are not pairs', () => {
  assert.deepEqual(parseCookies('a=1; garbage; =2'), [{ name: 'a', value: '1' }]);
});

test('an explicit chrome path is used as given', (t) => {
  const { dir } = makeRepo(t);
  const fake = join(dir, 'chrome');
  writeFileSync(fake, '');

  assert.equal(chromeBinary(fake), fake);
});

test('CHROME_PATH is honoured, as Puppeteer and Lighthouse already do', (t) => {
  const { dir } = makeRepo(t);
  const fake = join(dir, 'chrome');
  writeFileSync(fake, '');
  const previous = process.env.CHROME_PATH;
  process.env.CHROME_PATH = fake;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CHROME_PATH;
    } else {
      process.env.CHROME_PATH = previous;
    }
  });

  assert.equal(chromeBinary(), fake);
});

test('a chrome path that does not exist fails loudly', () => {
  assert.throws(
    () => chromeBinary('/nowhere/chrome'),
    /No Chrome at \/nowhere\/chrome/
  );
});
