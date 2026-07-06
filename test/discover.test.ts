import { describe, expect, it } from 'vitest';
import { scanDiscoverRoots, type ScanDeps } from '../src/discover/discover.js';
import type { VaultsConfig } from '../src/contract/types.js';

// Injected fs: map a resolved root dir to its immediate subfolder names.
const depsFrom = (map: Record<string, string[]>): ScanDeps => ({
  listDirs: (dir) => map[dir] ?? [],
});

describe('scanDiscoverRoots', () => {
  it('yields account-shaped candidates for each subfolder', () => {
    const config: VaultsConfig = { version: 1, discover: [{ path: '/roots/a' }] };
    const got = scanDiscoverRoots(config, depsFrom({ '/roots/a': ['work', 'personal'] }));
    expect(got.map((c) => c.name).sort()).toEqual(['personal', 'work']);
    expect(got.find((c) => c.name === 'work')!.entry).toEqual({
      path: '/roots/a/work',
      origin: [{ remote: 'agentage' }],
      mcp: ['local'],
    });
  });

  it('skips names listed in the root ignore', () => {
    const config: VaultsConfig = {
      version: 1,
      discover: [{ path: '/roots/a', ignore: ['secret'] }],
    };
    const got = scanDiscoverRoots(config, depsFrom({ '/roots/a': ['work', 'secret'] }));
    expect(got.map((c) => c.name)).toEqual(['work']);
  });

  it('skips folder names that fail the vault-name rule', () => {
    const config: VaultsConfig = { version: 1, discover: [{ path: '/roots/a' }] };
    const got = scanDiscoverRoots(
      config,
      depsFrom({ '/roots/a': ['ok', '.hidden', 'has space', 'x'.repeat(65)] })
    );
    expect(got.map((c) => c.name)).toEqual(['ok']);
  });

  it('skips folders already registered by name or by resolved path', () => {
    const config: VaultsConfig = {
      version: 1,
      vaults: {
        work: { origin: [{ remote: 'agentage' }] }, // collides by name
        aliased: { path: '/roots/a/personal' }, // collides by resolved path
      },
      discover: [{ path: '/roots/a' }],
    };
    const got = scanDiscoverRoots(config, depsFrom({ '/roots/a': ['work', 'personal', 'notes'] }));
    expect(got.map((c) => c.name)).toEqual(['notes']);
  });

  it('autosync:false pauses the candidate with interval 0', () => {
    const config: VaultsConfig = {
      version: 1,
      discover: [{ path: '/roots/a', autosync: false }],
    };
    const got = scanDiscoverRoots(config, depsFrom({ '/roots/a': ['work'] }));
    expect(got[0]!.entry.origin).toEqual([{ remote: 'agentage', interval: 0 }]);
  });

  it('de-dupes a name discovered under two roots', () => {
    const config: VaultsConfig = {
      version: 1,
      discover: [{ path: '/roots/a' }, { path: '/roots/b' }],
    };
    const got = scanDiscoverRoots(
      config,
      depsFrom({ '/roots/a': ['work'], '/roots/b': ['work', 'extra'] })
    );
    expect(got.map((c) => c.name)).toEqual(['work', 'extra']);
  });
});
