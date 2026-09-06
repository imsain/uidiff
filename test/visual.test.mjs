// The classifier decides whether a comparison runs at all, so a wrong answer
// either wastes a capture or, worse, hides a real regression behind a refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../lib/visual.mjs';

const verdict = (...files) => classifyChange(files).verdict;

test('files that render', () => {
  const renders = [
    'src/components/ui/button.tsx',
    'src/app/blog/[slug]/page.jsx',
    'src/styles/globals.css',
    'src/styles/print.scss',
    'tailwind.config.ts',
    'public/icons/chevron.svg',
    'public/hero.png'
  ];
  for (const file of renders) {
    assert.equal(verdict(file), 'visual', file);
  }
});

test('files that cannot render', () => {
  const inert = [
    'src/lib/utils.test.ts',
    'src/components/ui/button.test.tsx',
    'src/components/ui/button.stories.tsx',
    'src/__tests__/thing.ts',
    'cypress/e2e/login.cy.ts',
    'src/types/api.d.ts',
    'docs/adr-007-caching.md',
    'CONTRIBUTING.md',
    '.github/workflows/deploy.yml',
    '.cursor/skills/ui-screenshot-diff/bin/uidiff.mjs',
    'drizzle/0001_init.sql',
    'infrastructure/main.tf',
    'yarn.lock',
    '.gitignore'
  ];
  for (const file of inert) {
    assert.equal(verdict(file), 'invisible', file);
  }
});

test('a test file beats its own .tsx extension', () => {
  // Checked before the extension rules on purpose: a .tsx under __tests__ or a
  // .stories.tsx is not application UI, and getting this backwards would make
  // the refusal never fire on the most common non-visual change of all.
  assert.equal(verdict('src/components/Card.test.tsx'), 'invisible');
  assert.equal(verdict('src/components/Card.stories.tsx'), 'invisible');
  assert.equal(verdict('src/components/Card.tsx'), 'visual');
});

test('anything that might reach the DOM still runs', () => {
  const ambiguous = [
    'src/lib/format.ts',
    'src/app/api/summary/route.ts',
    'messages/en.json',
    'src/content/help.mdx'
  ];
  for (const file of ambiguous) {
    assert.equal(verdict(file), 'unclear', file);
  }
});

test('one rendering file is enough to outvote a pile of inert ones', () => {
  assert.equal(
    verdict(
      'docs/notes.md',
      'src/lib/utils.test.ts',
      'src/components/Card.tsx',
      '.github/workflows/ci.yml'
    ),
    'visual'
  );
});

test('an empty change is its own verdict', () => {
  assert.equal(verdict(), 'nothing');
});

test('reports which files landed in which bucket', () => {
  const result = classifyChange([
    'src/components/Card.tsx',
    'src/lib/format.ts',
    'docs/notes.md'
  ]);
  assert.deepEqual(result.renders, ['src/components/Card.tsx']);
  assert.deepEqual(result.unclear, ['src/lib/format.ts']);
  assert.deepEqual(result.inert, ['docs/notes.md']);
});
