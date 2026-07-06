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
