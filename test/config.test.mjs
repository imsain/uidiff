// One config name, committed at the root of the repo being captured. Keying it
// off the checkout's directory name instead breaks the moment somebody clones
// into a differently-named folder, which is the failure this file pins down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, loadConfig } from '../lib/project.mjs';
import { makeRepo } from './helpers.mjs';

/** Sets UIDIFF_CONFIG for one test and puts it back afterwards. */
function withConfigEnv(t, value) {
  const previous = process.env.UIDIFF_CONFIG;
  process.env.UIDIFF_CONFIG = value;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.UIDIFF_CONFIG;
    } else {
      process.env.UIDIFF_CONFIG = previous;
    }
  });
}

const write = (path, config) => {
  writeFileSync(path, JSON.stringify(config));
};

test('finds .uidiff.json at the root of the repo being captured', (t) => {
  const { dir } = makeRepo(t);
  write(join(dir, '.uidiff.json'), { baseUrl: 'http://localhost:4000' });

  assert.equal(configPath(dir), join(dir, '.uidiff.json'));
  assert.equal(loadConfig(dir).baseUrl, 'http://localhost:4000');
});

test('UIDIFF_CONFIG outranks the in-repo file', (t) => {
  const { dir } = makeRepo(t);
  write(join(dir, '.uidiff.json'), { baseUrl: 'http://in-repo' });
  const override = join(dir, 'somewhere-else.json');
  write(override, { baseUrl: 'http://override' });
  withConfigEnv(t, override);

  assert.equal(configPath(dir), override);
  assert.equal(loadConfig(dir).baseUrl, 'http://override');
});

test('missing config names where it looked and what to copy', (t) => {
  const { dir } = makeRepo(t);

  assert.throws(
    () => loadConfig(dir),
    (error) => {
      assert.match(error.message, /No config for this repo/);
      assert.match(error.message, /\.uidiff\.json/);
      assert.match(error.message, /config\.example\.json/);
      return true;
    }
  );
  assert.equal(
    configPath(dir),
    join(dir, '.uidiff.json'),
    'and suggests the in-repo path rather than one inside the package'
  );
});

test('a malformed config says which file is broken', (t) => {
  const { dir } = makeRepo(t);
  writeFileSync(join(dir, '.uidiff.json'), '{ "baseUrl": }');

  assert.throws(() => loadConfig(dir), /\.uidiff\.json is not valid JSON/);
});

test('fills in the defaults a config may omit', (t) => {
  const { dir } = makeRepo(t);
  write(join(dir, '.uidiff.json'), {});

  const config = loadConfig(dir);
  assert.equal(config.baseUrl, 'http://localhost:3000');
  assert.equal(config.chromePort, 9222);
  assert.deepEqual(config.viewport, { width: 1440, height: 900, scale: 2 });
});

test('a partial viewport keeps the other dimensions', (t) => {
  const { dir } = makeRepo(t);
  write(join(dir, '.uidiff.json'), { viewport: { width: 375 } });

  assert.deepEqual(loadConfig(dir).viewport, {
    width: 375,
    height: 900,
    scale: 2
  });
});
