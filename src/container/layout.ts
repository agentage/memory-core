// Where a NAME becomes a PATH. One module owns the bare layout
// <root>/<userId>/<vault>.git and its tombstone form, so nothing else in the
// engine joins a root with caller-supplied text: a path only exists once the
// name that produced it passed the segment allowlist, and the same rule holds
// for a host that computes a repo dir for git-http, backups or a disk report.

import { join } from 'node:path';
import { StoreError } from '../contract/errors.js';
import { isSafeSegment } from '../contract/paths.js';

export const REPO_SUFFIX = '.git';

// Stamps are caller-supplied text that becomes a directory name.
const SAFE_STAMP = /^[A-Za-z0-9:._-]{1,64}$/;

const invalid = (what: string, value: string): StoreError =>
  new StoreError('invalid_path', `invalid ${what}: ${JSON.stringify(value)}`);

export const assertSegment = (what: string, value: string): void => {
  if (!isSafeSegment(value)) throw invalid(what, value);
};

export const assertStamp = (stamp: string): void => {
  if (!SAFE_STAMP.test(stamp) || stamp.includes('..')) throw invalid('stamp', stamp);
};

// <root>/<userId> - everything one user owns.
export const userDir = (root: string, userId: string): string => {
  assertSegment('userId', userId);
  return join(root, userId);
};

// <root>/<userId>/<vault>.git - one vault.
export const vaultRepoDir = (root: string, userId: string, vault: string): string => {
  const dir = userDir(root, userId);
  assertSegment('vault', vault);
  return join(dir, `${vault}${REPO_SUFFIX}`);
};

// <root>/<userId>/<vault>.deleted-<stamp>.git - every byte kept, addressable as a
// vault by no one: the dots fail the segment allowlist that gates every lookup.
export const tombstoneRepoDir = (
  root: string,
  userId: string,
  vault: string,
  stamp: string
): string => {
  assertStamp(stamp);
  const dir = userDir(root, userId);
  assertSegment('vault', vault);
  return join(dir, `${vault}.deleted-${stamp}${REPO_SUFFIX}`);
};
