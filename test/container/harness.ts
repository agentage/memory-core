// Shared container fixtures: a real temp root (the container talks to the fs on
// every verb) with in-memory stores, so semantics are proven without git spawns.

import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTILE_PATHS } from '../../src/conformance/index.js';
import {
  createMemoryStore,
  createVaultContainer,
  ObjectCache,
  type Access,
  type VaultContainer,
  type VaultStore,
} from '../../src/index.js';

export const access = (over: Partial<Access> = {}): Access => ({
  userId: 'alice01',
  vaults: new Set(['main', 'work']),
  canCreate: true,
  canDelete: true,
  ...over,
});

export const makeRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'container-'));

export const mkdirp = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

export const containerAt = (
  root: string,
  over: {
    cache?: ObjectCache<VaultStore>;
    store?: (dir: string) => VaultStore;
    provision?: (dir: string) => Promise<void>;
  } = {}
): VaultContainer =>
  createVaultContainer({
    root,
    store: over.store ?? ((): VaultStore => createMemoryStore()),
    provision: over.provision ?? mkdirp,
    cache: over.cache ?? new ObjectCache<VaultStore>({ max: 16 }),
  });

// Recursive fs snapshot - the no-provision proof compares two of these.
export const treeOf = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true });
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${rel}/` : rel);
      if (e.isDirectory()) await walk(join(at, e.name), rel);
    }
  };
  await walk(dir, '');
  return out;
};

// The doc-path corpus plus the segment-only shapes an id must also refuse.
export const HOSTILE_IDS: string[] = [
  ...new Set([
    ...HOSTILE_PATHS,
    '.',
    '..',
    '../b',
    './b',
    'a/b',
    'a\\b',
    'main.git',
    'main.deleted-1.git',
    'ünicode',
    'e'.repeat(65),
    'has space',
    'tab\tid',
    'null\u0000byte',
    'main;rm -rf /',
    '-',
    '--upload-pack=x',
  ]),
];
