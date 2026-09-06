// Temporarily puts the working tree back to an earlier revision so a "before"
// capture can be taken after the change was already made.
//
// Current file contents are copied aside and restored verbatim afterwards, so
// uncommitted work survives — `git checkout <ref> -- <file>` alone would
// destroy it.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { UiDiffError, readJson, stateDir, writeJson } from './project.mjs';

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function manifestPath(root) {
  return join(stateDir(root), 'swap-manifest.json');
}

const lines = (output) => (output ? output.split('\n').filter(Boolean) : []);

/**
 * Every file that differs from `ref`, including ones git does not track yet.
 * A brand-new component is invisible to `git diff`, so without the second
 * command it would survive the swap and appear in the "before" capture too —
 * and a change that only adds files would look like no change at all.
 */
export function changedAgainst(root, ref, paths = []) {
  const tracked = git(root, ['diff', '--name-only', ref, '--', ...paths]);
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...paths
  ]);
  return [...new Set([...lines(tracked), ...lines(untracked)])].sort();
}

/**
 * Swaps `files` to their contents at `ref`. Returns a restore function; also
 * leaves a manifest behind so `uidiff restore` can recover from a crash.
 */
export function swapToRef(root, ref, files) {
  if (files.length === 0) {
    throw new UiDiffError(
      `Nothing differs from ${ref} — no "before" state to build`
    );
  }
  if (readJson(manifestPath(root))?.files?.length) {
    throw new UiDiffError(
      `A previous swap was not restored. Run "uidiff restore" first.`
    );
  }

  const backupDir = join(stateDir(root), 'swap-backup');
  rmSync(backupDir, { recursive: true, force: true });

  const entries = files.map((file) => {
    const absolute = join(root, file);
    const backup = join(backupDir, file);
    const existedBefore = existsSync(absolute);
    if (existedBefore) {
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(absolute, backup);
    }
    return { file, backup, existedBefore };
  });

  // Recorded before anything moves: `git checkout <ref> -- <file>` overwrites
  // the index too, so this is the only chance to learn what was staged.
  const index = lines(
    git(root, ['-c', 'core.quotePath=false', 'ls-files', '-s', '--', ...files])
  );
  writeJson(manifestPath(root), { ref, files: entries, index });

  for (const { file, existedBefore } of entries) {
    const existsAtRef =
      git(root, ['ls-tree', '--name-only', ref, '--', file]).length > 0;
    if (existsAtRef) {
      git(root, ['checkout', ref, '--', file]);
    } else if (existedBefore) {
      // File is new since `ref`: the "before" state is its absence.
      unlinkSync(join(root, file));
    }
  }

  return () => restoreSwap(root);
}

export function restoreSwap(root) {
  const manifest = readJson(manifestPath(root));
  if (!manifest?.files?.length) {
    return 0;
  }
  for (const { file, backup, existedBefore } of manifest.files) {
    const absolute = join(root, file);
    if (existedBefore) {
      mkdirSync(dirname(absolute), { recursive: true });
      copyFileSync(backup, absolute);
    } else if (existsSync(absolute)) {
      unlinkSync(absolute);
    }
  }
  const restored = manifest.files.length;
  writeJson(manifestPath(root), {});
  rmSync(join(stateDir(root), 'swap-backup'), { recursive: true, force: true });
  restoreIndex(root, manifest);
  return restored;
}

/**
 * Puts back the exact index entries the swap disturbed. Copying file contents
 * is not enough: `git checkout <ref> -- <file>` stages the ref's blob, so a
 * half-staged file would come back with the staged half silently replaced.
 * Rewriting only the recorded paths also leaves the rest of the index alone.
 */
function restoreIndex(root, manifest) {
  const entries = manifest.index ?? [];
  const staged = new Set(
    entries.map((line) => line.slice(line.indexOf('\t') + 1))
  );
  const unstage = manifest.files
    .map((entry) => entry.file)
    .filter((file) => !staged.has(file));
  try {
    if (entries.length > 0) {
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: root,
        input: `${entries.join('\n')}\n`,
        encoding: 'utf8'
      });
    }
    if (unstage.length > 0) {
      git(root, ['update-index', '--force-remove', '--', ...unstage]);
    }
  } catch {
    // An odd index state is not worth failing over — the working tree, which
    // holds the actual work, is already back.
  }
}

export function hasPendingSwap(root) {
  return (readJson(manifestPath(root))?.files?.length ?? 0) > 0;
}
