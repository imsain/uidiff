// Project resolution, config loading, and auth cookie minting.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Screenshots, swap backups and the minted session cookie stay outside any
 * checkout: they contain real page data and a valid token, and nothing
 * gitignored-by-luck should be the only thing keeping them out of a commit.
 *
 * Read per call rather than frozen at import so tests can point it somewhere
 * disposable without depending on module load order.
 */
export function artifactsDir() {
  return process.env.UIDIFF_CACHE || join(homedir(), '.cache', 'uidiff');
}
const COOKIE_TTL_MS = 6 * 24 * 3600 * 1000;

export class UiDiffError extends Error {}

export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8'
    }).trim();
  } catch {
    throw new UiDiffError(`Not inside a git repository: ${cwd}`);
  }
}

export function projectName(root) {
  return basename(root);
}

/**
 * Where a project's config may live: one committed file at the root of the
 * repo being captured, and an environment variable to point somewhere else.
 *
 * One name rather than several. Keying config off the checkout's directory
 * name — the obvious alternative when the tool is vendored — breaks the moment
 * somebody clones into a differently-named folder, and settings that belong to
 * a repository should travel with it.
 */
export function configCandidates(root) {
  return [
    ...(process.env.UIDIFF_CONFIG ? [resolve(process.env.UIDIFF_CONFIG)] : []),
    join(root, '.uidiff.json')
  ];
}

export function configPath(root) {
  const paths = configCandidates(root);
  return paths.find(existsSync) ?? paths[0];
}

export function loadConfig(root) {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new UiDiffError(
      [
        'No config for this repo. Looked for:',
        ...configCandidates(root).map((candidate) => `  ${candidate}`),
        '',
        `Create it from ${join(ROOT, 'config.example.json')}`
      ].join('\n')
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UiDiffError(`${path} is not valid JSON: ${error.message}`);
  }
  config.baseUrl ??= 'http://localhost:3000';
  config.viewport = { width: 1440, height: 900, scale: 2, ...config.viewport };
  config.chromePort ??= 9222;
  config.reloadWaitMs ??= 4000;
  config.settleMs ??= 12000;
  return config;
}

export function outDir(root, slug) {
  const dir = join(artifactsDir(), 'out', projectName(root), slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateDir(root) {
  const dir = join(artifactsDir(), 'state', projectName(root));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

/**
 * One `auth.claims` entry as data: either the name of an environment variable
 * for the child to read, or a literal value. `env:VAR_NAME` is the config
 * convention for the former.
 */
function claimSource(value) {
  return typeof value === 'string' && value.startsWith('env:')
    ? { env: value.slice(4).trim() }
    : { value };
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

function tokenTtl(value) {
  if (value === undefined) {
    return DEFAULT_TTL_SECONDS;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UiDiffError(
      `auth.ttlSeconds must be a positive number of seconds, got ${JSON.stringify(value)}`
    );
  }
  return seconds;
}

/**
 * Mints the cookie in a child process, because the secret and any env-backed
 * claims only exist there — once `--env-file` has loaded the app's own `.env`.
 *
 * Fixed source, with the config arriving as JSON in UIDIFF_TOKEN_SPEC. Nothing
 * from the config is ever interpolated into this text: when it was, a claim
 * value like `env:X ?? somethingElse()` smuggled its own JavaScript into a
 * process holding the app's secrets.
 */
const MINT_SCRIPT = `
const { encode } = await import('@auth/core/jwt');
const spec = JSON.parse(process.env.UIDIFF_TOKEN_SPEC);
const now = Math.floor(Date.now() / 1000);
const claims = {};
for (const [key, claim] of Object.entries(spec.claims)) {
  claims[key] = 'env' in claim ? process.env[claim.env] : claim.value;
}
const token = await encode({
  secret: process.env[spec.secretEnvVar],
  salt: spec.cookieName,
  token: {
    name: 'uidiff',
    email: spec.email,
    sub: spec.email,
    iat: now,
    exp: now + spec.ttlSeconds,
    jti: crypto.randomUUID(),
    ...claims
  }
});
process.stdout.write(spec.cookieName + '=' + token);
`;

/** A minted cookie, reused until it nears expiry. */
function cachedCookie(root, mint) {
  const cachePath = join(stateDir(root), 'cookie.json');
  const hit = readJson(cachePath);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.cookie;
  }
  const cookie = mint();
  if (!cookie.includes('=')) {
    throw new UiDiffError(
      `Minted cookie looks malformed: ${cookie.slice(0, 40)}`
    );
  }
  writeJson(cachePath, { cookie, expiresAt: Date.now() + COOKIE_TTL_MS });
  return cookie;
}

function nextAuthCookie(root, auth) {
  const appDir = resolve(root, auth.appDir ?? '.');
  const envFile = auth.envFile ?? '.env';
  const spec = {
    cookieName: auth.cookieName ?? 'next-auth.session-token',
    secretEnvVar: auth.secretEnvVar ?? 'AUTH_SECRET',
    email: auth.email ?? 'user@example.com',
    ttlSeconds: tokenTtl(auth.ttlSeconds),
    claims: Object.fromEntries(
      Object.entries(auth.claims ?? {}).map(([key, value]) => [
        key,
        claimSource(value)
      ])
    )
  };

  let cookie;
  try {
    cookie = execFileSync(
      process.execPath,
      [`--env-file=${envFile}`, '--input-type=module'],
      {
        cwd: appDir,
        input: MINT_SCRIPT,
        encoding: 'utf8',
        env: { ...process.env, UIDIFF_TOKEN_SPEC: JSON.stringify(spec) }
      }
    ).trim();
  } catch (error) {
    throw new UiDiffError(
      `Failed to mint an auth cookie in ${appDir}: ${error.stderr || error.message}`
    );
  }
  return cookie;
}

/**
 * A `name=value` cookie string, or null when the config declares no auth.
 * Several pairs separated by `; ` are fine — apps that need a session and a
 * CSRF cookie together were previously unable to authenticate at all.
 */
export function authCookie(root, config) {
  const auth = config.auth ?? { mode: 'none' };
  switch (auth.mode) {
    case 'none':
      return null;
    case 'env': {
      const name = auth.envVar ?? 'UIDIFF_COOKIE';
      const value = process.env[name];
      if (!value) {
        throw new UiDiffError(`auth.mode is "env" but ${name} is not set`);
      }
      return value;
    }
    case 'nextauth-offline':
      return cachedCookie(root, () => nextAuthCookie(root, auth));
    default:
      throw new UiDiffError(`Unsupported auth.mode: ${auth.mode}`);
  }
}

export function targetUrl(config, path) {
  if (!path) {
    throw new UiDiffError(
      'Which page? Pass a route, e.g. "uidiff compare /dashboard"'
    );
  }
  return new URL(path, config.baseUrl).href;
}

/** A filesystem-safe name for a route, used for this run's output directory. */
export function slugFor(path) {
  const trimmed = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  return trimmed ? trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-') : 'root';
}
