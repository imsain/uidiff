// Artifacts are keyed by the checkout's directory name, so two worktrees on
// different branches cannot share a swap manifest or overwrite each other's
// captures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectName } from '../lib/project.mjs';

test('takes the last segment of a path, however it is written', () => {
  assert.equal(projectName('/Users/me/projects/my-app'), 'my-app');
  assert.equal(
    projectName('/Users/me/projects/my-app/'),
    'my-app',
    'a trailing slash is not a segment'
  );
  assert.equal(projectName('my-app'), 'my-app');
});
