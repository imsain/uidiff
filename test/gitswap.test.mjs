// The swap rewinds real files on disk to build a "before" state, so a failure
// here loses someone's uncommitted work. Every restore path gets a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  changedAgainst,
  hasPendingSwap,
  restoreSwap,
  swapToRef
} from '../lib/gitswap.mjs';
import { makeRepo, stagedContents } from './helpers.mjs';

const read = (dir, file) => readFileSync(join(dir, file), 'utf8');
const write = (dir, file, body) => writeFileSync(join(dir, file), body);

test('restores an uncommitted edit verbatim', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'committed\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write(dir, 'page.tsx', 'work in progress\n');

  const files = changedAgainst(dir, 'HEAD');
  assert.deepEqual(files, ['page.tsx']);

  const restore = swapToRef(dir, 'HEAD', files);
  assert.equal(read(dir, 'page.tsx'), 'committed\n', 'swapped to the ref');

  assert.equal(restore(), 1);
  assert.equal(
    read(dir, 'page.tsx'),
    'work in progress\n',
    'uncommitted work survived'
  );
  assert.equal(hasPendingSwap(dir), false);
});

test('removes a file that did not exist at the ref, then brings it back', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'existing.tsx', 'old\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write(dir, 'NewComponent.tsx', 'brand new\n');

  const files = changedAgainst(dir, 'HEAD');
  assert.ok(
    files.includes('NewComponent.tsx'),
    'an untracked new file is part of the change and must be swapped away'
  );

  const restore = swapToRef(dir, 'HEAD', files);
  assert.equal(
    existsSync(join(dir, 'NewComponent.tsx')),
    false,
    'the "before" state is the file not existing'
  );

  restore();
  assert.equal(read(dir, 'NewComponent.tsx'), 'brand new\n');
});

test('restores a file deleted in the working tree', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'gone.tsx', 'here\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  unlinkSync(join(dir, 'gone.tsx'));

  const files = changedAgainst(dir, 'HEAD');
  assert.deepEqual(files, ['gone.tsx']);

  const restore = swapToRef(dir, 'HEAD', files);
  assert.equal(
    existsSync(join(dir, 'gone.tsx')),
    true,
    'present again at the ref'
  );

  restore();
  assert.equal(
    existsSync(join(dir, 'gone.tsx')),
    false,
    'the deletion is the current state and must come back'
  );
});

test('leaves the staging area exactly as it found it', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'v1\n');
  write(dir, 'untouched.tsx', 'stays\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  write(dir, 'page.tsx', 'v2 staged\n');
  git('add', 'page.tsx');
  write(dir, 'page.tsx', 'v3 working tree\n');

  write(dir, 'untouched.tsx', 'staged but unrelated\n');
  git('add', 'untouched.tsx');

  const restore = swapToRef(dir, 'HEAD', ['page.tsx']);
  restore();

  assert.equal(
    read(dir, 'page.tsx'),
    'v3 working tree\n',
    'working tree restored'
  );
  assert.equal(
    stagedContents(git, 'page.tsx'),
    'v2 staged',
    'a partially staged file keeps what was staged'
  );
  assert.equal(
    stagedContents(git, 'untouched.tsx'),
    'staged but unrelated',
    'a file the swap never touched keeps its staged state'
  );
});

test('restores a file that is staged as a new addition', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'existing.tsx', 'old\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  write(dir, 'Added.tsx', 'added\n');
  git('add', 'Added.tsx');

  const restore = swapToRef(dir, 'HEAD', ['Added.tsx']);
  assert.equal(existsSync(join(dir, 'Added.tsx')), false);

  restore();
  assert.equal(read(dir, 'Added.tsx'), 'added\n');
  assert.equal(
    stagedContents(git, 'Added.tsx'),
    'added',
    'still staged for the commit'
  );
});

test('refuses to swap nothing', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'same\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  assert.deepEqual(changedAgainst(dir, 'HEAD'), []);
  assert.throws(() => swapToRef(dir, 'HEAD', []), /Nothing differs/);
});

test('refuses a second swap while one is pending, and does not disturb the first', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write(dir, 'page.tsx', 'v2\n');

  const restore = swapToRef(dir, 'HEAD', ['page.tsx']);
  assert.equal(hasPendingSwap(dir), true);
  assert.throws(() => swapToRef(dir, 'HEAD', ['page.tsx']), /was not restored/);
  assert.equal(
    read(dir, 'page.tsx'),
    'v1\n',
    'the pending swap is still in place'
  );

  restore();
  assert.equal(read(dir, 'page.tsx'), 'v2\n');
});

test('a later process can finish an interrupted swap from the manifest', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write(dir, 'page.tsx', 'v2\n');

  // Deliberately drop the returned restore function: this is the crash case.
  swapToRef(dir, 'HEAD', ['page.tsx']);
  assert.equal(read(dir, 'page.tsx'), 'v1\n');
  assert.equal(hasPendingSwap(dir), true);

  assert.equal(restoreSwap(dir), 1);
  assert.equal(read(dir, 'page.tsx'), 'v2\n');
  assert.equal(hasPendingSwap(dir), false);
});

test('restoring twice is harmless', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'page.tsx', 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  write(dir, 'page.tsx', 'v2\n');

  const restore = swapToRef(dir, 'HEAD', ['page.tsx']);
  assert.equal(restore(), 1);
  assert.equal(restoreSwap(dir), 0, 'nothing left to do');
  assert.equal(read(dir, 'page.tsx'), 'v2\n');
});

test('handles a file in a directory that the ref does not have', (t) => {
  const { dir, git } = makeRepo(t);
  write(dir, 'root.tsx', 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  mkdirSync(join(dir, 'components'), { recursive: true });
  write(dir, 'components/Card.tsx', 'card\n');

  const files = changedAgainst(dir, 'HEAD');
  assert.deepEqual(files, ['components/Card.tsx']);

  const restore = swapToRef(dir, 'HEAD', files);
  assert.equal(existsSync(join(dir, 'components/Card.tsx')), false);

  restore();
  assert.equal(
    read(dir, 'components/Card.tsx'),
    'card\n',
    'directory recreated too'
  );
});
