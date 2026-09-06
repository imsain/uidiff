// Crop geometry is pure arithmetic against a live element rect. An off-by-one
// here silently shifts what a reviewer is looking at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropGeometry } from '../lib/report.mjs';
import { slugFor } from '../lib/project.mjs';

const viewport = { width: 800, height: 600, scale: 2 };
const rect = (x, y, w, h) => ({ x, y, w, h });

test('converts a CSS rect into a padded region in captured pixels', () => {
  // 20px of padding either side of a 240x120 box at (180,200), doubled.
  assert.equal(
    cropGeometry([rect(180, 200, 240, 120)], viewport, 20),
    '560x320+320+360'
  );
});

test('spans every match rather than picking one', () => {
  assert.equal(
    cropGeometry([rect(100, 100, 50, 50), rect(300, 200, 50, 50)], viewport, 0),
    '500x300+200+200'
  );
});

test('clamps to the image instead of asking for pixels that do not exist', () => {
  const wide = cropGeometry([rect(0, 0, 800, 600)], viewport, 50);
  assert.equal(wide, '1600x1200+0+0', 'padding cannot push past either edge');

  const corner = cropGeometry([rect(780, 580, 20, 20)], viewport, 10);
  const [size, x, y] = corner.split('+');
  const [width, height] = size.split('x').map(Number);
  assert.ok(Number(x) + width <= viewport.width * viewport.scale);
  assert.ok(Number(y) + height <= viewport.height * viewport.scale);
});

test('an element off the top-left does not produce a negative offset', () => {
  assert.match(cropGeometry([rect(5, 5, 100, 100)], viewport, 40), /\+0\+0$/);
});

test('gives up rather than guessing', () => {
  assert.equal(
    cropGeometry([], viewport, 24),
    null,
    'selector matched nothing'
  );
  assert.equal(cropGeometry(undefined, viewport, 24), null);
  assert.equal(
    cropGeometry([rect(0, 0, 0, 0)], { width: 800, height: 600, scale: 0 }, 0),
    null,
    'a zero-area region has no pixels to compare'
  );
});

test('turns a route into a directory name', () => {
  assert.equal(
    slugFor('/blog/posts/hello-world'),
    'blog-posts-hello-world'
  );
  assert.equal(slugFor('/'), 'root');
  assert.equal(slugFor(''), 'root');
  assert.equal(
    slugFor('/shop/products?tab=all'),
    'shop-products',
    'query dropped'
  );
  assert.equal(slugFor('/store/[category]/x'), 'store-category-x');
  assert.equal(slugFor('/trailing/slash/'), 'trailing-slash');
});
