import { describe, it, expect, vi } from 'vitest';
import {
  createCouchState,
  type CouchStatePersistence,
  type CouchSyncState,
} from '../src/channel/couch-state.js';

// A JSON-file-like store: load reads the last saved snapshot, save records it (and counts writes).
const backing = () => {
  let stored: CouchSyncState | null = null;
  const save = vi.fn(async (s: CouchSyncState) => {
    stored = s;
  });
  const persistence: CouchStatePersistence = { load: async () => stored, save };
  return { persistence, save, get: (): CouchSyncState | null => stored };
};

describe('CouchState - pull cursor', () => {
  it('defaults to seq 0 and persists an advance', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    expect(s.getCursor()).toBe('0');
    await s.setCursor('5');
    expect(s.getCursor()).toBe('5');
    expect(b.get()?.cursor).toBe('5');
  });

  it('survives a simulated restart (a fresh instance rehydrates the saved cursor)', async () => {
    const b = backing();
    await (await createCouchState(b.persistence)).setCursor('42');
    const reloaded = await createCouchState(b.persistence);
    expect(reloaded.getCursor()).toBe('42');
  });

  it('does not write when the cursor is unchanged', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    await s.setCursor('0'); // same as default
    expect(b.save).not.toHaveBeenCalled();
  });
});

describe('CouchState - push-rev cache', () => {
  it('sets, reads, and drops a rev, persisting each real change', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    expect(s.revFor('a.md')).toBeUndefined();
    await s.setRev('a.md', 'r1');
    expect(s.revFor('a.md')).toBe('r1');
    expect(b.get()?.revs).toEqual({ 'a.md': 'r1' });
    await s.setRev('a.md', 'r1'); // no-op
    expect(b.save).toHaveBeenCalledTimes(1);
    await s.dropRev('a.md');
    expect(s.revFor('a.md')).toBeUndefined();
    await s.dropRev('a.md'); // absent -> no write
    expect(b.save).toHaveBeenCalledTimes(2);
  });

  it('rehydrates the rev map on restart', async () => {
    const b = backing();
    await (await createCouchState(b.persistence)).setRev('a.md', 'r9');
    expect((await createCouchState(b.persistence)).revFor('a.md')).toBe('r9');
  });
});

describe('CouchState - pending pushes', () => {
  it('enqueues without duplicates and dequeues, persisting real changes only', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    await s.enqueue('a.md');
    await s.enqueue('a.md'); // dup -> no write
    await s.enqueue('b.md');
    expect(s.pendingPaths().sort()).toEqual(['a.md', 'b.md']);
    expect(b.save).toHaveBeenCalledTimes(2);
    await s.dequeue('a.md');
    await s.dequeue('a.md'); // absent -> no write
    expect(s.pendingPaths()).toEqual(['b.md']);
    expect(b.save).toHaveBeenCalledTimes(3);
    expect(b.get()?.pending).toEqual(['b.md']);
  });

  it('rehydrates pending on restart', async () => {
    const b = backing();
    await (await createCouchState(b.persistence)).enqueue('x.md');
    expect((await createCouchState(b.persistence)).pendingPaths()).toEqual(['x.md']);
  });
});

describe('CouchState - pending deletions (0.3.1)', () => {
  it('enqueues without duplicates, dequeues, and persists real changes only', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    expect(s.deletionPaths()).toEqual([]);
    await s.enqueueDeletion('d.md');
    await s.enqueueDeletion('d.md'); // dup -> no write
    await s.enqueueDeletion('e.md');
    expect(s.deletionPaths().sort()).toEqual(['d.md', 'e.md']);
    expect(b.save).toHaveBeenCalledTimes(2);
    expect(b.get()?.deletions).toEqual(['d.md', 'e.md']);
    await s.dequeueDeletion('d.md');
    await s.dequeueDeletion('d.md'); // absent -> no write
    expect(s.deletionPaths()).toEqual(['e.md']);
    expect(b.save).toHaveBeenCalledTimes(3);
  });

  it('round-trips the full new shape and rehydrates deletions on restart', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    await s.setCursor('4');
    await s.setRev('a.md', 'r1');
    await s.enqueue('p.md');
    await s.enqueueDeletion('x.md');
    expect(b.get()).toEqual({
      cursor: '4',
      revs: { 'a.md': 'r1' },
      pending: ['p.md'],
      deletions: ['x.md'],
    });
    expect((await createCouchState(b.persistence)).deletionPaths()).toEqual(['x.md']);
  });

  it('loads a 0.3.0 snapshot that has no deletions field', async () => {
    const old: CouchSyncState = { cursor: '7', revs: { 'a.md': 'r' }, pending: ['p.md'] };
    const s = await createCouchState({ load: async () => old, save: async () => {} });
    expect(s.deletionPaths()).toEqual([]); // absent field -> empty set, no crash
    expect(s.getCursor()).toBe('7');
    expect(s.pendingPaths()).toEqual(['p.md']);
    expect(s.revFor('a.md')).toBe('r');
  });

  it('exposes known (rev-cached) paths as the local-deletion disambiguator', async () => {
    const b = backing();
    const s = await createCouchState(b.persistence);
    await s.setRev('a.md', 'r1');
    await s.setRev('b.md', 'r2');
    expect(s.knownPaths().sort()).toEqual(['a.md', 'b.md']);
    await s.dropRev('a.md');
    expect(s.knownPaths()).toEqual(['b.md']);
  });
});
