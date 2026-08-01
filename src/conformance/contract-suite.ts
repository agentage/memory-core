// The conformance kit: one shared spec every VaultStore implementation must pass.
// A store that passes is guaranteed swappable behind the contract. Run it from a
// test file: contractSuite({ name, make }).

import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreEvent, VaultStore } from '../contract/vault-store.js';

export interface ConformanceTarget {
  name: string;
  make: () => Promise<VaultStore> | VaultStore;
  // For externally-mutable stores: perform an out-of-band change, return changed paths.
  mutateExternally?: (store: VaultStore) => Promise<string[]>;
}

export const contractSuite = (t: ConformanceTarget): void => {
  describe(`${t.name}: contract`, () => {
    let store: VaultStore;
    let events: StoreEvent[];
    beforeEach(async () => {
      store = await t.make();
      // Capture the ARRAY, not the binding: a slow prior test's still-draining
      // async writes must leak into their own array, never the current test's.
      const captured: StoreEvent[] = [];
      events = captured;
      store.subscribe((e) => captured.push(e));
    });

    describe('write + read', () => {
      it('round-trips frontmatter, body, tags, title', async () => {
        await store.write({
          path: 'work/plan.md',
          body: 'Ship it #q3',
          frontmatter: { tags: ['work'] },
        });
        const view = await store.read('work/plan.md');
        expect(view).toMatchObject({
          path: 'work/plan.md',
          title: 'plan',
          body: 'Ship it #q3',
          frontmatter: { tags: ['work'] },
          deleted: false,
        });
        expect(view!.tags).toEqual(['work', 'q3']);
      });

      it('advances version on change, emits one write event with the path', async () => {
        const before = await store.version();
        const res = await store.write({ path: 'a.md', body: 'one' }, { id: 'cli', name: 'CLI' });
        expect(await store.version()).not.toBe(before);
        expect(res.rev).toBe(await store.version());
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'write', paths: ['a.md'], version: res.rev });
        expect(events[0]!.author).toMatchObject({ id: 'cli' });
      });

      it('no-op write (byte-identical) keeps the version and emits nothing', async () => {
        const first = await store.write({ path: 'a.md', body: 'same' });
        const second = await store.write({ path: 'a.md', body: 'same' });
        expect(second.rev).toBe(first.rev);
        expect(events).toHaveLength(1);
      });

      it('missing read returns null', async () => {
        expect(await store.read('nope.md')).toBeNull();
      });

      it('clamps oversized read bodies with the truncation marker', async () => {
        await store.write({ path: 'big.md', body: 'x'.repeat(70 * 1024) });
        const view = await store.read('big.md');
        expect(view!.body.length).toBeLessThan(70 * 1024);
        expect(view!.body).toContain('[Truncated for display');
        expect(view!.sizeBytes).toBe(70 * 1024); // sizeBytes reports the STORED size
      });

      it('read({clamp:false}) returns the full body for API/export flows', async () => {
        await store.write({ path: 'full.md', body: 'y'.repeat(70 * 1024) });
        const view = await store.read('full.md', { clamp: false });
        expect(view!.body).toBe('y'.repeat(70 * 1024));
        expect(view!.body).not.toContain('[Truncated for display');
        expect(view!.sizeBytes).toBe(70 * 1024);
      });
    });

    describe('edit', () => {
      beforeEach(async () => {
        await store.write({ path: 'n.md', body: 'alpha beta', frontmatter: { a: 1 } });
      });

      it('replace swaps the body, append adds a line, frontmatter shallow-merges', async () => {
        await store.edit({ path: 'n.md', mode: 'replace', body: 'new', frontmatter: { b: 2 } });
        expect(await store.read('n.md')).toMatchObject({
          body: 'new',
          frontmatter: { a: 1, b: 2 },
        });
        await store.edit({ path: 'n.md', mode: 'append', body: 'more' });
        expect((await store.read('n.md'))!.body).toBe('new\nmore');
      });

      it('str_replace: exact unique match; canonical errors otherwise', async () => {
        await store.edit({ path: 'n.md', mode: 'str_replace', old_str: 'beta', new_str: 'gamma' });
        expect((await store.read('n.md'))!.body).toBe('alpha gamma');
        await expect(
          store.edit({ path: 'n.md', mode: 'str_replace', old_str: 'zzz', new_str: 'y' })
        ).rejects.toThrow(/No replacement was performed/);
        await store.edit({ path: 'n.md', mode: 'replace', body: 'dup dup' });
        await expect(
          store.edit({ path: 'n.md', mode: 'str_replace', old_str: 'dup', new_str: 'x' })
        ).rejects.toThrow(/Multiple occurrences/);
      });

      it('editing a missing doc returns null', async () => {
        expect(await store.edit({ path: 'nope.md', mode: 'replace', body: 'x' })).toBeNull();
      });
    });

    describe('delete', () => {
      it('deletes, reports missing as false, emits event', async () => {
        await store.write({ path: 'd.md', body: 'x' });
        expect(await store.delete('d.md')).toBe(true);
        expect(await store.read('d.md')).toBeNull();
        expect(await store.delete('d.md')).toBe(false);
        expect(events.map((e) => e.type)).toEqual(['write', 'delete']);
      });
    });

    describe('list', () => {
      beforeEach(async () => {
        await store.write({ path: 'root.md', body: 'r' });
        await store.write({ path: 'work/a.md', body: 'a #x' });
        await store.write({ path: 'work/deep/b.md', body: 'b' });
      });

      it('builds the depth-2 tree with counts', async () => {
        const res = await store.list({});
        expect(res.files).toBe(3);
        const work = res.entries.find((e) => e.path === 'work');
        expect(work).toMatchObject({ type: 'folder', files: 2 });
      });

      it('depth 1 lists folders without expanding them', async () => {
        const res = await store.list({ depth: 1 });
        const work = res.entries.find((e) => e.path === 'work');
        expect(work && 'entries' in work && work.entries).toBeFalsy();
      });

      it('scopes to a folder and filters by tags', async () => {
        const scoped = await store.list({ folder: 'work' });
        expect(scoped.files).toBe(2);
        const tagged = await store.list({ tags: ['x'] });
        expect(tagged.files).toBe(1);
      });
    });

    describe('list paging (backward capable)', () => {
      beforeEach(async () => {
        for (let i = 0; i < 7; i++) {
          await store.write({ path: `bulk/n${String(i).padStart(2, '0')}.md`, body: `n${i}` });
        }
      });

      it('a plain call has NO nextCursor key - the frozen tool behavior', async () => {
        const res = await store.list({});
        expect(res.files).toBe(7);
        expect('nextCursor' in res).toBe(false);
      });

      it('opting into limit/cursor drains the vault as tree-shaped pages', async () => {
        const p1 = await store.list({ limit: 3 });
        expect(p1.files).toBe(7); // total, page-independent
        expect(p1.nextCursor).toBeTruthy();
        const seen: string[] = [];
        let cursor = p1.nextCursor;
        const collect = (r: { entries: unknown[] }): void => {
          for (const e of r.entries as Array<{ type: string; path: string; entries?: unknown[] }>)
            if (e.type === 'file') seen.push(e.path);
            else if (e.entries) collect({ entries: e.entries });
        };
        collect(p1);
        while (cursor) {
          const p = await store.list({ limit: 3, cursor });
          collect(p);
          cursor = p.nextCursor;
        }
        expect(seen.sort()).toEqual([
          'bulk/n00.md',
          'bulk/n01.md',
          'bulk/n02.md',
          'bulk/n03.md',
          'bulk/n04.md',
          'bulk/n05.md',
          'bulk/n06.md',
        ]);
      });
    });

    describe('search', () => {
      beforeEach(async () => {
        await store.write({ path: 'one.md', body: 'kiwi kiwi kiwi' });
        await store.write({ path: 'two.md', body: 'kiwi and Kiwi' });
        await store.write({ path: 'work/three.md', body: 'kiwi', frontmatter: { tags: ['w'] } });
      });

      it('ranks by occurrence count, case-insensitive', async () => {
        const res = await store.search({ query: 'kiwi', limit: 10 });
        expect(res.results.map((r) => r.path)).toEqual(['one.md', 'two.md', 'work/three.md']);
        expect(res.results[0]!.score).toBe(3);
        expect(res.results[1]!.score).toBe(2);
      });

      it('treats regex metacharacters literally', async () => {
        await store.write({ path: 'lit.md', body: 'a.b matches nothing else' });
        const res = await store.search({ query: 'a.b', limit: 10 });
        expect(res.results.map((r) => r.path)).toEqual(['lit.md']);
      });

      it('scopes by folder and tags; empty query yields nothing', async () => {
        expect(
          (await store.search({ query: 'kiwi', limit: 10, folder: 'work' })).results
        ).toHaveLength(1);
        expect(
          (await store.search({ query: 'kiwi', limit: 10, tags: ['w'] })).results
        ).toHaveLength(1);
        expect((await store.search({ query: '   ', limit: 10 })).results).toHaveLength(0);
      });

      // 55+ real writes: give slow CI runners room - a mid-test timeout would
      // leave queued writes draining into the next test.
      it('defaults the page size to 20 when limit is omitted', async () => {
        for (let i = 0; i < 25; i++) await store.write({ path: `dflt/n${i}.md`, body: 'mango' });
        const res = await store.search({ query: 'mango' });
        expect(res.results).toHaveLength(20);
        expect(res.nextCursor).toBeTruthy();
      }, 120_000);

      it('paginates with a cursor and caps the page size at 50', async () => {
        for (let i = 0; i < 55; i++) await store.write({ path: `bulk/n${i}.md`, body: 'pear' });
        const page1 = await store.search({ query: 'pear', limit: 100 });
        expect(page1.results).toHaveLength(50);
        expect(page1.nextCursor).toBeTruthy();
        const page2 = await store.search({ query: 'pear', limit: 100, cursor: page1.nextCursor });
        expect(page2.results).toHaveLength(5);
        expect(page2.nextCursor).toBeUndefined();
      }, 120_000);
    });

    describe('version + refresh + events', () => {
      it('version is null on an empty vault and stable across reads', async () => {
        expect(await store.version()).toBeNull();
        await store.write({ path: 'v.md', body: 'x' });
        const v = await store.version();
        await store.read('v.md');
        await store.list({});
        expect(await store.version()).toBe(v);
      });

      it('refresh is a no-op when nothing changed', async () => {
        await store.write({ path: 'v.md', body: 'x' });
        expect(await store.refresh()).toEqual([]);
      });

      it('a throwing observer never breaks the operation; unsubscribe works', async () => {
        const off = store.subscribe(() => {
          throw new Error('boom');
        });
        await expect(store.write({ path: 'ok.md', body: 'x' })).resolves.toBeTruthy();
        off();
        await store.write({ path: 'ok2.md', body: 'y' });
        expect(events).toHaveLength(2); // our own observer still saw both
      });

      if (t.mutateExternally) {
        it('surfaces out-of-band changes as external events via refresh', async () => {
          await store.write({ path: 'seed.md', body: 'x' });
          const changed = await t.mutateExternally!(store);
          const emitted = await store.refresh();
          expect(emitted).toHaveLength(1);
          expect(emitted[0]!.type).toBe('external');
          expect(emitted[0]!.paths).toEqual(expect.arrayContaining(changed));
          expect(await store.refresh()).toEqual([]); // idempotent
        });
      }
    });

    describe('capabilities honesty', () => {
      it('declared capabilities match behavior', async () => {
        const caps = store.capabilities();
        expect(caps.mutable).toBe(true); // conformance targets are writable by definition
        if (!t.mutateExternally) expect(caps.externallyMutable).toBe(false);
        if (caps.search !== 'none') {
          await store.write({ path: 'cap.md', body: 'findme' });
          expect((await store.search({ query: 'findme', limit: 5 })).results).toHaveLength(1);
        }
      });
    });
  });
};
