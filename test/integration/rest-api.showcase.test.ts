// SHOWCASE: /v1-shaped REST read handlers over VaultStore (the north-star-api
// contract: plain resource JSON, `{ error: { code, message } }` envelope). This
// is the consumer shape for memory-mcp's /v1 routes and the dashboard backend:
// auth resolves userId, handlers are resolve -> verb -> envelope, stats come
// from a derived view instead of a hand-rolled git walk.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createDerivedCache,
  createStatsView,
  isSafeSegment,
  type DerivedCache,
  type DerivedView,
  type VaultStats,
  type VaultStore,
} from '../../src/index.js';

// ---- the consumer template ----

interface Json {
  status: number;
  body: unknown;
}

const err = (status: number, code: string, message: string): Json => ({
  status,
  body: { error: { code, message } },
});

const createV1 = (reposRoot: string) => {
  const stores = new Map<
    string,
    { store: VaultStore; cache: DerivedCache; stats: DerivedView<VaultStats> }
  >();

  const vaultOf = (userId: string, vault: string) => {
    if (!isSafeSegment(userId) || !isSafeSegment(vault)) return undefined;
    const key = `${userId}/${vault}`;
    let entry = stores.get(key);
    if (!entry) {
      const repo = join(reposRoot, userId, `${vault}.git`);
      const store = createBareGitStore(repo);
      entry = {
        store,
        cache: createDerivedCache(store, join(reposRoot, userId, `${vault}.cache`)),
        stats: createStatsView(repo),
      };
      stores.set(key, entry);
    }
    return entry;
  };

  // GET /v1/vaults/{vault}/notes/{path} - full body + exact sizeBytes (the live
  // NOTE_READ_KEYS wire: body, frontmatter, path, sizeBytes, tags, title, updated).
  const getNote = async (userId: string, vault: string, path: string): Promise<Json> => {
    const v = vaultOf(userId, vault);
    if (!v || !(await v.store.version())) return err(404, 'not_found', 'no such vault');
    const view = await v.store.read(path, { clamp: false });
    if (!view) return err(404, 'not_found', 'no such note');
    const { path: p, title, frontmatter, body, tags, updated, sizeBytes } = view;
    return { status: 200, body: { path: p, title, frontmatter, body, tags, updated, sizeBytes } };
  };

  // GET /v1/vaults/{vault}/notes - SAME shape as memory__list (squashed): the
  // ListResult tree, cursor-drainable when the caller opts into limit/cursor.
  const getNotes = async (
    userId: string,
    vault: string,
    q: { folder?: string; depth?: number; limit?: number; cursor?: string } = {}
  ): Promise<Json> => {
    const v = vaultOf(userId, vault);
    if (!v || !(await v.store.version())) return err(404, 'not_found', 'no such vault');
    return { status: 200, body: await v.store.list(q) };
  };

  // GET /v1/vaults/{vault}/search?q=
  const search = async (userId: string, vault: string, q: string, limit = 20): Promise<Json> => {
    const v = vaultOf(userId, vault);
    if (!v || !(await v.store.version())) return err(404, 'not_found', 'no such vault');
    const res = await v.store.search({ query: q, limit });
    return { status: 200, body: res };
  };

  // GET /v1/vaults/{vault}  (stats via a derived view - cached, version-fresh)
  const getVault = async (userId: string, vault: string): Promise<Json> => {
    const v = vaultOf(userId, vault);
    if (!v || !(await v.store.version())) return err(404, 'not_found', 'no such vault');
    const stats = await v.cache.get(v.stats);
    return { status: 200, body: { name: vault, ...stats } };
  };

  // GET /v1/vaults/{vault}/notes?folder=  (UI tree - depth-limited by contract)
  const listNotes = async (userId: string, vault: string, folder?: string): Promise<Json> => {
    const v = vaultOf(userId, vault);
    if (!v || !(await v.store.version())) return err(404, 'not_found', 'no such vault');
    return { status: 200, body: await v.store.list({ folder }) };
  };

  return { getNote, getNotes, search, getVault, listNotes, _seed: vaultOf };
};

// ---- the proof ----

describe('rest /v1 showcase', () => {
  let api: ReturnType<typeof createV1>;

  beforeEach(async () => {
    api = createV1(await mkdtemp(join(tmpdir(), 'v1-showcase-')));
    const seeded = api._seed('carol03', 'main')!;
    await seeded.store.write({
      path: 'notes/alpha.md',
      body: 'galaxy one',
      frontmatter: { tags: ['t'] },
    });
    await seeded.store.write({ path: 'notes/beta.md', body: 'galaxy two galaxy' });
  });

  it('reads a note as a plain resource', async () => {
    const res = await api.getNote('carol03', 'main', 'notes/alpha.md');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      path: 'notes/alpha.md',
      title: 'alpha',
      body: 'galaxy one',
      tags: ['t'],
    });
  });

  it('404s with the error envelope: unknown vault, unknown note, hostile ids', async () => {
    expect(await api.getNote('carol03', 'nope', 'x.md')).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found' } },
    });
    expect((await api.getNote('carol03', 'main', 'nope.md')).status).toBe(404);
    expect((await api.getVault('../escape', 'main')).status).toBe(404);
  });

  it('search returns ranked results', async () => {
    const res = await api.search('carol03', 'main', 'galaxy');
    expect(res.body).toMatchObject({
      results: [
        { path: 'notes/beta.md', score: 2 },
        { path: 'notes/alpha.md', score: 1 },
      ],
    });
  });

  it('vault stats come from the derived view with true byte sizes', async () => {
    const res = await api.getVault('carol03', 'main');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'main', files: 2, empty: false });
    expect((res.body as VaultStats).sizeBytes).toBeGreaterThan(0);
  });

  it('lists the folder tree', async () => {
    const res = await api.listNotes('carol03', 'main');
    expect((res.body as { files: number }).files).toBe(2);
  });

  it('notes wire IS the memory__list shape - squashed, cursor when opted in', async () => {
    const plain = await api.getNotes('carol03', 'main');
    expect(plain.body).toEqual(await api._seed('carol03', 'main')!.store.list({})); // same object as the tool
    expect('nextCursor' in (plain.body as object)).toBe(false); // backward capable
    const p1 = await api.getNotes('carol03', 'main', { limit: 1 });
    expect((p1.body as { files: number }).files).toBe(2);
    expect((p1.body as { nextCursor?: string }).nextCursor).toBeTruthy();
    const p2 = await api.getNotes('carol03', 'main', {
      limit: 1,
      cursor: (p1.body as { nextCursor: string }).nextCursor,
    });
    expect((p2.body as { nextCursor?: string }).nextCursor).toBeUndefined();
  });

  it('note read carries the full body and exact stored size', async () => {
    const res = await api.getNote('carol03', 'main', 'notes/alpha.md');
    expect(Object.keys(res.body as object).sort()).toEqual([
      'body',
      'frontmatter',
      'path',
      'sizeBytes',
      'tags',
      'title',
      'updated',
    ]);
  });
});
