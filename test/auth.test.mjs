// The cookie minter runs a script in a child process that has the app's own
// `.env` loaded, so it holds real secrets. Anything from the config that
// reached that script as *source* rather than as data would be arbitrary code
// execution with those secrets in scope — so that is what these cover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authCookie } from '../lib/project.mjs';
import { makeRepo } from './helpers.mjs';

/**
 * A throwaway app for the child to run in: an `@auth/core` stub whose `encode`
 * hands the token back so a test can see exactly what it was called with, plus
 * the `.env` that `--env-file` insists on.
 */
function makeApp(root) {
  const appDir = join(root, 'app');
  const stub = join(appDir, 'node_modules', '@auth', 'core');
  mkdirSync(stub, { recursive: true });
  writeFileSync(
    join(stub, 'package.json'),
    JSON.stringify({
      name: '@auth/core',
      version: '0.0.0',
      type: 'module',
      exports: { './jwt': './jwt.js' }
    })
  );
  writeFileSync(
    join(stub, 'jwt.js'),
    `export async function encode({ token }) {
       return Buffer.from(JSON.stringify(token)).toString('base64url');
     }\n`
  );
  writeFileSync(join(appDir, '.env'), 'AUTH_SECRET=test-secret\n');
  return appDir;
}

const auth = (extra) => ({
  auth: { mode: 'nextauth-offline', appDir: 'app', envFile: '.env', ...extra }
});

/** The token the stub encoded, recovered from the `name=value` cookie. */
function tokenFrom(cookie) {
  const value = cookie.slice(cookie.indexOf('=') + 1);
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

test('a claim that looks like code is data, not code', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);
  const marker = join(tmpdir(), `uidiff-injection-${process.pid}.txt`);
  rmSync(marker, { force: true });
  t.after(() => {
    rmSync(marker, { force: true });
  });

  // Shaped like the documented `env:VAR` convention, but with an expression
  // glued on. Back when the claim was interpolated into the script's source,
  // this ran.
  const cookie = authCookie(
    dir,
    auth({
      claims: {
        role: `env:UNSET_VAR ?? (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x')`
      }
    })
  );

  assert.equal(existsSync(marker), false, 'the claim must not execute');
  assert.match(cookie, /^next-auth\.session-token=/, 'and minting still works');
});

test('an unset env-backed claim is absent rather than fatal', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);

  const token = tokenFrom(
    authCookie(dir, auth({ claims: { tenantId: 'env:DEFINITELY_NOT_SET' } }))
  );
  assert.equal(token.tenantId, undefined);
});

test('a literal claim arrives verbatim', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);

  const token = tokenFrom(
    authCookie(dir, auth({ claims: { role: 'admin', seats: 3 } }))
  );
  assert.equal(token.role, 'admin');
  assert.equal(token.seats, 3, 'a non-string claim keeps its type');
});

test('an env-backed claim is resolved in the child', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);
  process.env.UIDIFF_TEST_TENANT = 'tenant-42';
  t.after(() => {
    delete process.env.UIDIFF_TEST_TENANT;
  });

  const token = tokenFrom(
    authCookie(dir, auth({ claims: { tenantId: 'env:UIDIFF_TEST_TENANT' } }))
  );
  assert.equal(token.tenantId, 'tenant-42');
});

test('email drives both email and sub', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);

  const token = tokenFrom(authCookie(dir, auth({ email: 'dev@example.com' })));
  assert.equal(token.email, 'dev@example.com');
  assert.equal(token.sub, 'dev@example.com');
});

test('ttlSeconds sets the expiry, and a junk value is refused', (t) => {
  const { dir } = makeRepo(t);
  makeApp(dir);

  const token = tokenFrom(authCookie(dir, auth({ ttlSeconds: 3600 })));
  assert.equal(token.exp - token.iat, 3600);

  // Interpolated into the script it would have been source too; now it has to
  // survive being a number, and saying so beats an NaN expiry.
  for (const bad of ['0; evil()', '', -1, 'soon']) {
    assert.throws(
      () => authCookie(join(dir, 'other'), auth({ ttlSeconds: bad })),
      /auth\.ttlSeconds must be a positive number/,
      `rejects ${JSON.stringify(bad)}`
    );
  }
});

test('an unsupported mode is named, and "none" mints nothing', (t) => {
  const { dir } = makeRepo(t);
  assert.equal(authCookie(dir, { auth: { mode: 'none' } }), null);
  assert.equal(authCookie(dir, {}), null, 'no auth block at all');
  assert.throws(
    () => authCookie(dir, { auth: { mode: 'saml' } }),
    /Unsupported auth\.mode: saml/
  );
});
