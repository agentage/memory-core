import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CouchSync, type CouchSyncConfig, type FileStore } from '../src/channel/couch-sync.js';
import {
  createCouchState,
  type CouchState,
  type CouchSyncState,
} from '../src/channel/couch-state.js';
import type { FetchLike } from '../src/channel/http.js';

type Res = { status: number; json: unknown };
const res = (status: number, json: unknown): Res => ({ status, json });
type Handler = (url: string, method: string, body?: string) => Res;
let handler: Handler = () => res(404, {});

// Injected fetch: routes to the per-test handler and wraps the body as a FetchResponse.
let fetchMock: ReturnType<typeof vi.fn<FetchLike>>;

// A minimal in-memory FileStore - only the surface CouchSync touches. Paths are POSIX.
class FakeFileStore implements FileStore {
  private files = new Map<string, string>();
  writeCalls = 0;
  removeCalls = 0;
  constructor(init: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(init)) this.files.set(p, c);
  }
  async listMarkdown(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, body: string): Promise<void> {
    this.writeCalls++;
    this.files.set(path, body);
  }
  async remove(path: string): Promise<void> {
    if (this.files.delete(path)) this.removeCalls++;
  }
  content(path: string): string | undefined {
    return this.files.get(path);
  }
}

const throwaway = (): Promise<CouchState> =>
  createCouchState({ load: async () => null, save: async () => {} });

const backing = () => {
  let stored: CouchSyncState | null = null;
  return {
    persistence: {
      load: async () => stored,
      save: async (s: CouchSyncState) => {
        stored = s;
      },
    },
    get: () => stored,
  };
};

const makeSync = (
  store: FakeFileStore,
  state: CouchState,
  cfg: Partial<CouchSyncConfig> = {},
  onUnauthorized = vi.fn()
): CouchSync =>
  new CouchSync(
    store,
    { endpoint: 'http://couch.test', db: 'mem_x', ...cfg },
    fetchMock,
    async () => 'jwt',
    onUnauthorized,
    state
  );

const changesUrls = (): string[] =>
  fetchMock.mock.calls.map((c) => c[0]).filter((u) => u.includes('/_changes'));

beforeEach(() => {
  handler = () => res(404, {});
  fetchMock = vi.fn<FetchLike>(async (url, init) => {
    const r = handler(url, init?.method ?? 'GET', init?.body);
    return { status: r.status, json: async () => r.json };
  });
});

describe('fix 1 - a missing leaf never truncates the note', () => {
  it('aborts the pull, leaves the file untouched, and does not advance the cursor', async () => {
    const store = new FakeFileStore({ 'notes/a.md': 'ORIGINAL' });
    const state = await throwaway();
    const couch = makeSync(store, state);
    handler = (url) => {
      if (url.includes('/_changes'))
        return res(200, {
          results: [
            {
              id: 'f:notes/a.md',
              doc: {
                _id: 'f:notes/a.md',
                type: 'file',
                path: 'notes/a.md',
                size: 5,
                leaves: ['h:AAA', 'h:BBB'],
              },
            },
          ],
          last_seq: '3',
        });
      if (url.includes('h%3AAAA')) return res(200, { _id: 'h:AAA', _rev: '1-x', data: 'hello' });
      return res(404, {}); // h:BBB (and anything else) is missing
    };

    await expect(couch.pullOnce()).rejects.toThrow('missing leaf');
    expect(store.writeCalls).toBe(0);
    expect(store.content('notes/a.md')).toBe('ORIGINAL');
    expect(state.getCursor()).toBe('0'); // cursor NOT advanced -> next tick retries
  });
});

describe('fix 2 - resumable, paged pull cursor', () => {
  it('pages _changes with successive since= values and persists the cursor', async () => {
    const store = new FakeFileStore();
    const b = backing();
    const state = await createCouchState(b.persistence);
    const couch = makeSync(store, state, { pageLimit: 2 });
    handler = (url) => {
      if (url.includes('/_changes') && url.includes('since=0'))
        return res(200, {
          results: [
            {
              id: 'f:a.md',
              doc: { _id: 'f:a.md', type: 'file', path: 'a.md', size: 3, leaves: ['h:a1'] },
            },
            {
              id: 'f:b.md',
              doc: { _id: 'f:b.md', type: 'file', path: 'b.md', size: 3, leaves: ['h:b1'] },
            },
          ],
          last_seq: '2',
        });
      if (url.includes('/_changes') && url.includes('since=2'))
        return res(200, { results: [], last_seq: '2' });
      if (url.includes('h%3Aa1')) return res(200, { data: 'AAA' });
      if (url.includes('h%3Ab1')) return res(200, { data: 'BBB' });
      return res(404, {});
    };

    await couch.pullOnce();

    const changes = changesUrls();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain('since=0');
    expect(changes[1]).toContain('since=2');
    expect(changes[0]).toContain('limit=2');
    expect(store.content('a.md')).toBe('AAA');
    expect(store.content('b.md')).toBe('BBB');
    expect(state.getCursor()).toBe('2');
    expect(b.get()?.cursor).toBe('2'); // persisted -> survives a restart
  });
});

describe('fix 3 - unchanged pushAll performs zero HTTP', () => {
  it('skips the network entirely on the second pushAll when nothing changed', async () => {
    const store = new FakeFileStore({ 'notes/n.md': 'X' });
    const state = await throwaway();
    const couch = makeSync(store, state);
    handler = (url, method) => {
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {}); // f: GET -> not on server yet
    };

    await couch.pushAll();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);

    fetchMock.mockClear();
    await couch.pushAll();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fix 5 - a couch-rejected push is queued, not silently cached', () => {
  it('does not cache the rev on a non-2xx PUT, so the next tick retries it', async () => {
    const store = new FakeFileStore({ 'notes/n.md': 'X' });
    const state = await throwaway();
    const couch = makeSync(store, state);

    handler = (url, method) => {
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(500, {}); // couch rejects the file doc
      return res(404, {}); // f: GET -> not on server yet
    };
    await couch.pushFileLive('notes/n.md');
    expect(state.pendingPaths()).toEqual(['notes/n.md']);
    expect(state.revFor('notes/n.md')).toBeUndefined(); // NOT cached -> stays retryable

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {});
    };
    await couch.tick();
    expect(state.pendingPaths()).toEqual([]);
    expect(state.revFor('notes/n.md')).toBeDefined(); // cached only after couch accepted it
  });
});

describe('fix 4 - a failed live push is queued and retried on the next tick', () => {
  it('queues the path on a network error, then flushes it successfully on tick()', async () => {
    const store = new FakeFileStore({ 'notes/n.md': 'X' });
    const state = await throwaway();
    const couch = makeSync(store, state);

    handler = () => {
      throw new Error('network down');
    };
    await couch.pushFileLive('notes/n.md');
    expect(state.pendingPaths()).toEqual(['notes/n.md']);

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {});
    };
    await couch.tick();

    expect(state.pendingPaths()).toEqual([]);
    const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(puts.length).toBe(1);
  });
});

describe('401 handling - re-mint and retry once', () => {
  it('calls onUnauthorized and replays the request when couch returns 401', async () => {
    const store = new FakeFileStore();
    const state = await throwaway();
    const onUnauthorized = vi.fn();
    const couch = makeSync(store, state, {}, onUnauthorized);
    let first = true;
    handler = (url) => {
      if (url.includes('/_changes')) {
        if (first) {
          first = false;
          return res(401, {});
        }
        return res(200, { results: [], last_seq: '0' });
      }
      return res(404, {});
    };
    await couch.pullOnce();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(changesUrls().length).toBe(2); // original + one retry
  });
});

describe('pull applies a delete', () => {
  it('removes the file and drops its rev on a deleted change', async () => {
    const store = new FakeFileStore({ 'gone.md': 'BODY' });
    const state = await throwaway();
    const couch = makeSync(store, state);
    handler = (url) => {
      if (url.includes('/_changes'))
        return res(200, { results: [{ id: 'f:gone.md', deleted: true }], last_seq: '9' });
      return res(404, {});
    };
    await couch.pullOnce();
    expect(store.content('gone.md')).toBeUndefined();
    expect(store.removeCalls).toBe(1);
    expect(state.getCursor()).toBe('9');
  });
});

// A file doc the reconciler will read back to disambiguate a delete (content matches the cache).
const fdoc = (path: string, rev: string, leaves: string[]) => ({
  _id: `f:${path}`,
  _rev: rev,
  type: 'file',
  path,
  size: 1,
  leaves,
});

describe('delete durability - a failed tombstone is queued and eventually lands', () => {
  it('queues the deletion on a transport failure, then flushes it on tick()', async () => {
    const store = new FakeFileStore();
    const state = await throwaway();
    await state.setRev('gone.md', 'h:g1'); // we had synced this file
    const couch = makeSync(store, state);

    handler = () => {
      throw new Error('network down');
    };
    await couch.removeFile('gone.md'); // never throws
    expect(state.deletionPaths()).toEqual(['gone.md']);
    expect(state.revFor('gone.md')).toBe('h:g1'); // rev kept so the retry can disambiguate

    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '0' });
      if (url.includes('f%3Agone.md') && method === 'DELETE') return res(200, { ok: true });
      if (url.includes('f%3Agone.md')) return res(200, fdoc('gone.md', '3-r', ['h:g1']));
      return res(404, {});
    };
    await couch.tick();
    expect(state.deletionPaths()).toEqual([]); // tombstone landed -> dequeued
    expect(state.revFor('gone.md')).toBeUndefined(); // and its rev cache dropped
  });
});

describe('local-deletion reconciliation via the rev cache', () => {
  it('tombstones a known path absent from the file set, leaving present files untouched', async () => {
    const store = new FakeFileStore({ 'keep.md': 'K' }); // present
    const state = await throwaway();
    await state.setRev('gone.md', 'h:g1'); // known but absent -> a local deletion
    const couch = makeSync(store, state);

    const deleted: string[] = [];
    handler = (url, method) => {
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3Agone.md') && method === 'DELETE') {
        deleted.push('gone.md');
        return res(200, { ok: true });
      }
      if (url.includes('f%3Agone.md')) return res(200, fdoc('gone.md', '2-x', ['h:g1']));
      if (url.includes('f%3Akeep.md') && method === 'PUT') return res(200, { ok: true });
      return res(404, {}); // keep.md GET -> not on server yet
    };
    await couch.pushAll();
    expect(deleted).toEqual(['gone.md']); // known-but-absent -> tombstoned
    expect(state.revFor('gone.md')).toBeUndefined(); // rev-cache entry dropped
    expect(state.revFor('keep.md')).toBeDefined(); // present file kept (pushed, not deleted)
  });
});

describe('pull-delete does not resurface as a phantom local deletion', () => {
  it('a pull-applied delete drops the rev so the next pushAll issues no tombstone', async () => {
    const store = new FakeFileStore({ 'gone.md': 'BODY' });
    const state = await throwaway();
    await state.setRev('gone.md', 'h:old'); // we had synced it
    const couch = makeSync(store, state);

    handler = (url) => {
      if (url.includes('/_changes'))
        return res(200, { results: [{ id: 'f:gone.md', deleted: true }], last_seq: '5' });
      return res(404, {});
    };
    await couch.pullOnce();
    expect(store.content('gone.md')).toBeUndefined();
    expect(state.revFor('gone.md')).toBeUndefined(); // pull dropped the rev cache

    let deleteCalls = 0;
    handler = (url, method) => {
      if (url.includes('/_changes')) return res(200, { results: [], last_seq: '5' });
      if (method === 'DELETE') deleteCalls++;
      return res(404, {});
    };
    await couch.pushAll();
    expect(deleteCalls).toBe(0); // not re-detected as a local deletion
  });
});

describe('tombstone-409 - edit wins over a stale delete', () => {
  it('abandons the deletion on a 409 and lets the next pull restore the newer doc', async () => {
    const store = new FakeFileStore(); // file already gone locally
    const state = await throwaway();
    await state.setRev('race.md', 'h:v1'); // we knew v1
    const couch = makeSync(store, state);

    handler = (url, method) => {
      if (url.includes('f%3Arace.md') && method === 'DELETE')
        return res(409, { error: 'conflict' });
      if (url.includes('f%3Arace.md')) return res(200, fdoc('race.md', '2-a', ['h:v1']));
      return res(404, {});
    };
    await couch.pushAll();
    expect(state.deletionPaths()).toEqual([]); // 409 is terminal -> never queued
    expect(state.revFor('race.md')).toBeUndefined(); // rev dropped -> not re-detected

    handler = (url) => {
      if (url.includes('/_changes'))
        return res(200, {
          results: [{ id: 'f:race.md', doc: fdoc('race.md', '3-b', ['h:v2']) }],
          last_seq: '7',
        });
      if (url.includes('h%3Av2')) return res(200, { data: 'NEW' });
      return res(404, {});
    };
    await couch.pullOnce();
    expect(store.content('race.md')).toBe('NEW'); // newer edit restored, not force-deleted
  });
});

describe('syncNow is resilient like tick()', () => {
  it('records a pull failure instead of throwing, and reports push/pull status', async () => {
    const store = new FakeFileStore({ 'n.md': 'X' });
    const state = await throwaway();
    const couch = makeSync(store, state);
    handler = (url, method) => {
      if (url.includes('/_changes')) throw new Error('pull boom'); // pull fails
      if (url.includes('_bulk_docs')) return res(200, []);
      if (url.includes('f%3A') && method === 'PUT') return res(200, { ok: true });
      return res(404, {}); // f: GET -> not on server yet
    };
    const result = await couch.syncNow(); // must not throw
    expect(result.pushed).toBe(true);
    expect(result.pulled).toBe(false);
    expect(result.error).toBe('pull boom');
  });
});
