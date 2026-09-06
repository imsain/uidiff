import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway git repo plus a disposable artifacts directory, so tests never
 * touch the real ~/.cache/uidiff or the checkout they run from.
 */
export function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'uidiff-test-'));
  const cache = mkdtempSync(join(tmpdir(), 'uidiff-cache-'));
  const previousCache = process.env.UIDIFF_CACHE;
  process.env.UIDIFF_CACHE = cache;

  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'uidiff test');
  git('config', 'commit.gpgsign', 'false');

  t.after(() => {
    if (previousCache === undefined) {
      delete process.env.UIDIFF_CACHE;
    } else {
      process.env.UIDIFF_CACHE = previousCache;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  return { dir, git };
}

/** Contents of a path as git has it staged, or null when it is not in the index. */
export function stagedContents(git, file) {
  try {
    return git('show', `:${file}`);
  } catch {
    return null;
  }
}
