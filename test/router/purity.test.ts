// Two properties that keep the router a BINDING, not a layer:
// 1. createRouter does zero IO - it stores two references and returns; the vault
//    set is resolved per operation, so a router can be built per request.
// 2. It adds no policy. Guards (secret refusal, read clamp, path safety) live in
//    the store now, and enforcing them twice would be a bug - a guardless store
//    proves the router carries no copy.

import { describe, expect, it } from 'vitest';
import type { VaultContainer, VaultStore } from '../../src/index.js';
import { READ_BODY_BUDGET } from '../../src/index.js';
import { createRouter } from '../../src/router/router.js';
import { access, hostileContainer, NOW } from './harness.js';

// Accepts everything, remembers everything - it has no guards at all.
const guardlessStore = (log: string[]): { store: VaultStore; body: string } => {
  const body = 'x'.repeat(READ_BODY_BUDGET + 4096);
  return {
    body,
    store: {
      read: async (path, opts) => {
        log.push(`read:${path}:${String(opts?.clamp)}`);
        return {
          path,
          title: 'big',
          frontmatter: {},
          body,
          tags: [],
          updated: NOW,
          deleted: false,
        };
      },
      write: async (i, author) => {
        log.push(`write:${i.path}:${i.body}:${author?.id ?? '-'}`);
        return { path: i.path, rev: '1', updated: NOW };
      },
      edit: async (i) => {
        log.push(`edit:${i.path}:${i.new_str ?? i.body ?? ''}`);
        return { path: i.path, rev: '1', updated: NOW };
      },
      delete: async (path) => {
        log.push(`delete:${path}`);
        return true;
      },
      list: async (q) => {
        log.push(`list:${q.folder ?? ''}`);
        return { folder: q.folder ?? '', entries: [], truncated: false, files: 0 };
      },
      search: async (q) => {
        log.push(`search:${q.query}`);
        return { results: [] };
      },
      describe: async () => ({ files: 0, folders: 0, sizeBytes: 0, updated: null, version: null }),
      version: async () => null,
      refresh: async () => [],
      subscribe: () => () => undefined,
      capabilities: () => ({
        mutable: true,
        versioned: false,
        externallyMutable: false,
        search: 'none' as const,
      }),
    },
  };
};

const soloContainer = (store: VaultStore): VaultContainer => ({
  list: async () => ['solo'],
  open: async () => store,
  create: async () => store,
  remove: async () => true,
});

describe('router is a pure binding', () => {
  it('performs no container call at construction', () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    expect(() => createRouter(container, access(), { defaultVault: 'main' })).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('resolves the vault set on the first verb, not before', async () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    const r = createRouter(container, access());
    expect(calls).toEqual([]);
    await expect(r.read('a.md')).rejects.toThrow('container touched');
    expect(calls).toEqual(['list']);
    await expect(r.search({ query: 'x' })).rejects.toThrow('container touched');
    expect(calls).toEqual(['list', 'list']);
  });

  it('builds many routers without a single call', () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    for (let i = 0; i < 100; i++) createRouter(container, access({ userId: `u${i}` }));
    expect(calls).toEqual([]);
  });
});

describe('router adds no policy of its own', () => {
  it('does not re-run the store guards on write or edit', async () => {
    const log: string[] = [];
    const { store } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access(), { defaultVault: 'solo' });
    const secret = `api_key: sk-${'a'.repeat(24)}`;
    await expect(r.write('k.md', { body: secret })).resolves.toMatchObject({ path: 'k.md' });
    await expect(
      r.edit('k.md', { mode: 'str_replace', old_str: 'x', new_str: secret })
    ).resolves.not.toBeNull();
    expect(log).toEqual([`write:k.md:${secret}:-`, `edit:k.md:${secret}`]);
  });

  it('does not clamp a read - the body arrives exactly as the store returned it', async () => {
    const log: string[] = [];
    const { store, body } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access(), { defaultVault: 'solo' });
    const view = await r.read('big.md');
    expect(view?.body).toBe(body);
    await r.read('big.md', { clamp: false });
    expect(log).toEqual(['read:big.md:undefined', 'read:big.md:false']);
  });

  it('passes an author through to the store untouched', async () => {
    const log: string[] = [];
    const { store } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access(), { defaultVault: 'solo' });
    await r.write('a.md', { body: 'b' }, { id: 'cli', name: 'Agentage CLI' });
    expect(log).toEqual(['write:a.md:b:cli']);
  });

  it('rethrows a store failure by identity', async () => {
    const boom = new Error('store exploded');
    const { store } = guardlessStore([]);
    const failing: VaultStore = {
      ...store,
      read: async () => {
        throw boom;
      },
    };
    const r = createRouter(soloContainer(failing), access(), { defaultVault: 'solo' });
    await expect(r.read('a.md')).rejects.toBe(boom);
  });
});
