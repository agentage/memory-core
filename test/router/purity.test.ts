// Two properties that keep the router a BINDING, not a layer:
// 1. createRouter does zero IO - it stores two references and returns; the vault
//    set is resolved per operation, so a router can be built per request.
// 2. It adds no policy. Guards (secret refusal, read clamp, path safety) live in
//    the store now, and enforcing them twice would be a bug - a guardless store
//    proves the router carries no copy.

import { describe, expect, it } from 'vitest';
import type { RoutedContainer, VaultStore } from '../../src/index.js';
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
      readMany: async (paths, opts) => {
        log.push(`readMany:${paths.join('|')}:${String(opts?.clamp)}`);
        return paths.map((path) => ({
          path,
          title: 'big',
          frontmatter: {},
          body,
          tags: [],
          updated: NOW,
          deleted: false,
        }));
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

const soloContainer = (store: VaultStore): RoutedContainer => ({
  list: async () => ['solo'],
  open: async () => store,
  create: async () => store,
  remove: async () => true,
});

describe('router is a pure binding', () => {
  it('performs no container call at construction', () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    expect(() => createRouter(container, access())).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('resolves the vault set on the first verb, not before', async () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    const r = createRouter(container, access());
    expect(calls).toEqual([]);
    await expect(r.read('@main/a.md')).rejects.toThrow('container touched');
    expect(calls).toEqual(['list']);
    await expect(r.search({ query: 'x' })).rejects.toThrow('container touched');
    expect(calls).toEqual(['list', 'list']);
  });

  it('refuses an ungranted vault without reaching the container at all', async () => {
    const calls: string[] = [];
    const { container } = hostileContainer(calls);
    const r = createRouter(container, access({ vaults: new Set(['main']) }));
    await expect(r.read('@other/a.md')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.readMany(['@main/a.md', '@other/a.md'])).rejects.toMatchObject({
      code: 'forbidden',
    }); // one ungranted ref refuses the batch, and the granted one costs no IO
    await expect(r.write('@other/a.md', { body: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(r.edit('@other/a.md', { mode: 'append', body: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(r.delete('@other/a.md')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.list({ ref: '@other' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(r.search({ query: 'x', folder: '@other' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(calls).toEqual([]);
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
    const r = createRouter(soloContainer(store), access({ vaults: new Set(['solo']) }));
    const secret = `api_key: sk-${'a'.repeat(24)}`;
    await expect(r.write('@solo/k.md', { body: secret })).resolves.toMatchObject({
      path: '@solo/k.md',
    });
    await expect(
      r.edit('@solo/k.md', { mode: 'str_replace', old_str: 'x', new_str: secret })
    ).resolves.not.toBeNull();
    expect(log).toEqual([`write:k.md:${secret}:-`, `edit:k.md:${secret}`]);
  });

  it('does not clamp a read - the body arrives exactly as the store returned it', async () => {
    const log: string[] = [];
    const { store, body } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access({ vaults: new Set(['solo']) }));
    const view = await r.read('@solo/big.md');
    expect(view?.body).toBe(body);
    await r.read('@solo/big.md', { clamp: false });
    expect(log).toEqual(['read:big.md:undefined', 'read:big.md:false']);
  });

  it('bulk-reads through ONE store call per vault, unclamped and untouched', async () => {
    const log: string[] = [];
    const { store, body } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access({ vaults: new Set(['solo']) }));
    const views = await r.readMany(['@solo/a.md', '@solo/dir/b.md'], { clamp: false });
    expect(views.map((v) => v?.path)).toEqual(['@solo/a.md', '@solo/dir/b.md']);
    expect(views[0]?.body).toBe(body);
    expect(log).toEqual(['readMany:a.md|dir/b.md:false']); // one call, in-vault paths
  });

  it('passes an author through to the store untouched', async () => {
    const log: string[] = [];
    const { store } = guardlessStore(log);
    const r = createRouter(soloContainer(store), access({ vaults: new Set(['solo']) }));
    await r.write('@solo/a.md', { body: 'b' }, { id: 'cli', name: 'Agentage CLI' });
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
    const r = createRouter(soloContainer(failing), access({ vaults: new Set(['solo']) }));
    await expect(r.read('@solo/a.md')).rejects.toBe(boom);
  });
});
