// The conformance kit: one shared spec every VaultStore implementation must pass.
// A store that passes is guaranteed swappable behind the contract. Run it from a
// test file: contractSuite({ name, make }).

import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreEvent, VaultStore } from '../contract/vault-store.js';
import { createRouter, type Router } from '../router/router.js';

export interface ConformanceTarget {
  name: string;
  make: () => Promise<VaultStore> | VaultStore;
  // For externally-mutable stores: perform an out-of-band change, return changed paths.
  mutateExternally?: (store: VaultStore) => Promise<string[]>;
  // Another live instance over the SAME storage (a restart, a second process).
  // Lets the kit hold a store that FOLLOWED the changes against one that just
  // built its view from scratch - they must be indistinguishable.
  reopen?: (store: VaultStore) => Promise<VaultStore> | VaultStore;
  // For process-backed stores: the same store plus a live count of the round trips
  // (subprocesses, HTTP calls) it makes, so budget claims are PROVEN by the kit
  // instead of asserted by the implementation's own tests.
  makeCounted?: () => Promise<CountedStore> | CountedStore;
}

export interface CountedStore {
  store: VaultStore;
  // Round trips since the last reset.
  trips: () => number;
  reset: () => void;
}

// A key PRESENT holding `undefined` is not a JSON value: stringify drops it, so the
// wire shape differs from the in-process one and MCP output-schema validation
// rejects the result. Returns the dotted path of every such key found.
const undefinedKeys = (value: unknown, at = '$'): string[] => {
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedKeys(v, `${at}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    v === undefined ? [`${at}.${k}`] : undefinedKeys(v, `${at}.${k}`)
  );
};

// Hosted clients read every result through the router, so a store's outputs are
// scanned as the router tags them, not only as the store returns them.
const ROUTED_VAULT = 'main';
const routedOver = (store: VaultStore): Router =>
  createRouter(
    {
      list: async () => [ROUTED_VAULT],
      open: async () => store,
      create: async () => store,
      remove: async () => false,
    },
    { userId: 'conformance', vaults: '*', canCreate: false, canDelete: false }
  );

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

    // readMany is the BULK SHAPE of read, nothing else: the contract only holds if
    // its answer is indistinguishable from the N reads it replaces - same order,
    // same nulls, same clamp - while costing one storage round trip.
    describe('readMany', () => {
      const PATHS = ['a.md', 'work/b.md', 'work/deep/c.md'];
      beforeEach(async () => {
        for (const path of PATHS) await store.write({ path, body: `body of ${path} #bulk` });
      });

      it('answers in request order, with a null in place of every miss', async () => {
        const asked = ['work/b.md', 'missing.md', 'a.md', 'work/deep/c.md'];
        const views = await store.readMany(asked);
        expect(views).toHaveLength(asked.length);
        expect(views.map((v) => v?.path ?? null)).toEqual([
          'work/b.md',
          null,
          'a.md',
          'work/deep/c.md',
        ]);
      });

      it('is element-wise equal to the same N reads', async () => {
        const asked = [...PATHS, 'missing.md'];
        expect(await store.readMany(asked)).toEqual(
          await Promise.all(asked.map((p) => store.read(p)))
        );
      });

      it('repeats a duplicated path in place instead of collapsing it', async () => {
        const views = await store.readMany(['a.md', 'a.md', 'missing.md', 'a.md']);
        expect(views.map((v) => v?.path ?? null)).toEqual(['a.md', 'a.md', null, 'a.md']);
        expect(views[0]).toEqual(views[3]);
      });

      it('clamps exactly as read does, opt-out included', async () => {
        await store.write({ path: 'big.md', body: 'z'.repeat(70 * 1024) });
        const [clamped] = await store.readMany(['big.md']);
        expect(clamped!.body).toContain('[Truncated for display');
        expect(clamped!.sizeBytes).toBe(70 * 1024);
        const [full] = await store.readMany(['big.md'], { clamp: false });
        expect(full!.body).toBe('z'.repeat(70 * 1024));
      });

      it('an empty request is an empty answer', async () => {
        expect(await store.readMany([])).toEqual([]);
      });

      it('an unreadable path answers null, exactly as read does', async () => {
        expect(await store.readMany(['../escape.md', '.git/config', 'a.md'])).toEqual([
          null,
          null,
          await store.read('a.md'),
        ]);
      });

      it('never mutates: version holds and nothing is emitted', async () => {
        const version = await store.version();
        const seen = events.length;
        await store.readMany([...PATHS, 'missing.md', '../escape.md']);
        expect(await store.version()).toBe(version);
        expect(events).toHaveLength(seen);
      });

      it('through the router: same order, same nulls, every path tagged', async () => {
        const r = routedOver(store);
        const refs = PATHS.map((p) => `@${ROUTED_VAULT}/${p}`);
        const views = await r.readMany([...refs, `@${ROUTED_VAULT}/missing.md`]);
        expect(views.map((v) => v?.path ?? null)).toEqual([...refs, null]);
        expect(views[0]).toEqual(await r.read(refs[0]!));
        expect(undefinedKeys(views)).toEqual([]);
        expect(await r.readMany([])).toEqual([]);
      });

      if (t.makeCounted) {
        it('costs one round trip warm - no more than a single read', async () => {
          const counted = await t.makeCounted!();
          for (const path of PATHS) await counted.store.write({ path, body: `body of ${path}` });
          await counted.store.list({}); // warm whatever a read would warm anyway
          await counted.store.read('a.md');

          counted.reset();
          await counted.store.read('a.md');
          const oneRead = counted.trips();

          counted.reset();
          const views = await counted.store.readMany([...PATHS, 'missing.md']);
          expect(views.map((v) => v?.path ?? null)).toEqual([...PATHS, null]);
          expect(counted.trips()).toBeLessThanOrEqual(Math.max(oneRead, 1));

          counted.reset();
          expect(await counted.store.readMany([])).toEqual([]);
          expect(counted.trips()).toBe(0);
        });
      }
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

    // "Outputs are always tagged addressable" only holds if they also survive the
    // wire: a nested folder left unexpanded at depth 2 must have NO `entries` key,
    // not a key holding undefined.
    describe('serialize-safe outputs', () => {
      beforeEach(async () => {
        for (const path of ['root.md', 'work/a.md', 'work/deep/b.md', 'work/deep/deeper/c.md'])
          await store.write({ path, body: `body of ${path}` });
      });

      it('the store never emits a key holding undefined', async () => {
        for (const q of [{}, { depth: 1 }, { folder: 'work' }, { limit: 2 }])
          expect(undefinedKeys(await store.list(q))).toEqual([]);
        expect(undefinedKeys(await store.read('work/deep/b.md'))).toEqual([]);
        expect(undefinedKeys(await store.search({ query: 'body' }))).toEqual([]);
      });

      it('nor does the router - nested unexpanded folders carry no entries key', async () => {
        const r = routedOver(store);
        const scoped = await r.list({ ref: `@${ROUTED_VAULT}` }); // depth 2, work/deep unexpanded
        expect(undefinedKeys(scoped)).toEqual([]);
        expect(undefinedKeys(await r.list({ ref: `@${ROUTED_VAULT}`, depth: 1 }))).toEqual([]);
        expect(undefinedKeys(await r.list({}))).toEqual([]); // vault-root discovery view
        expect(undefinedKeys(await r.list({ depth: 1 }))).toEqual([]);
        expect(undefinedKeys(await r.read(`@${ROUTED_VAULT}/work/deep/b.md`))).toEqual([]);
        expect(undefinedKeys(await r.search({ query: 'body' }))).toEqual([]);
        // What the wire does to the shape must be a no-op.
        expect(JSON.parse(JSON.stringify(scoped))).toStrictEqual(scoped);
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

    describe('describe', () => {
      it('an empty vault describes as all-zero, no version, no updated', async () => {
        expect(await store.describe()).toEqual({
          files: 0,
          folders: 0,
          sizeBytes: 0,
          updated: null,
          version: null,
        });
      });

      it('never provisions or mutates - version stays null, repeats identically', async () => {
        const first = await store.describe();
        expect(await store.version()).toBeNull();
        expect(await store.describe()).toEqual(first);
        expect(events).toHaveLength(0);
      });

      it('counts files and folders consistently with list()', async () => {
        await store.write({ path: 'root.md', body: 'r' });
        await store.write({ path: 'work/a.md', body: 'a' });
        await store.write({ path: 'work/deep/b.md', body: 'b' });
        const d = await store.describe();
        expect(d.files).toBe((await store.list({})).files);
        expect(d.files).toBe(3);
        expect(d.folders).toBe(2); // work, work/deep
      });

      it('sizeBytes is the exact stored total, updated and version are set', async () => {
        await store.write({ path: 'a.md', body: 'héllo' });
        await store.write({ path: 'sub/b.md', body: 'x'.repeat(1000), frontmatter: { t: 1 } });
        const d = await store.describe();
        const sizes = await Promise.all(
          ['a.md', 'sub/b.md'].map(async (p) => (await store.read(p, { clamp: false }))!.sizeBytes)
        );
        expect(d.sizeBytes).toBe(sizes.reduce((a, b) => a! + b!, 0));
        expect(d.updated).not.toBeNull();
        expect(d.version).toBe(await store.version());
      });

      if (t.makeCounted) {
        it('is computed once per version, then free - and moves with a write', async () => {
          const counted = await t.makeCounted!();
          await counted.store.write({ path: 'a.md', body: 'x' });
          const first = await counted.store.describe();

          counted.reset();
          expect(await counted.store.describe()).toEqual(first);
          expect(counted.trips(), 'a repeat at the same version must cost nothing').toBe(0);

          await counted.store.write({ path: 'sub/b.md', body: 'y' });
          const after = await counted.store.describe();
          expect(after.files).toBe(first.files + 1);
          expect(after.version).toBe(await counted.store.version());
        });
      }

      it('counts drop after a delete', async () => {
        await store.write({ path: 'keep.md', body: 'k' });
        await store.write({ path: 'gone/x.md', body: 'g' });
        const before = await store.describe();
        expect(await store.delete('gone/x.md')).toBe(true);
        const after = await store.describe();
        expect(after.files).toBe(before.files - 1);
        expect(after.folders).toBe(before.folders - 1);
        expect(after.sizeBytes).toBeLessThan(before.sizeBytes);
        expect(after.version).toBe(await store.version());
      });
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

      // Following a change and rebuilding after it are two ways to reach the same
      // state. If they can ever disagree, the cheap path is not an optimization.
      if (t.mutateExternally && t.reopen) {
        it('a store that followed the changes answers like one that just opened', async () => {
          await store.write({ path: 'seed.md', body: 'seed note' });
          await store.write({ path: 'work/kept.md', body: 'kept note' });
          for (let i = 0; i < 4; i++) {
            await t.mutateExternally!(store);
            await store.refresh();
          }
          const fresh = await t.reopen!(store);
          expect(await store.list({})).toEqual(await fresh.list({}));
          expect(await store.list({ folder: 'work' })).toEqual(
            await fresh.list({ folder: 'work' })
          );
          expect(await store.list({ depth: 1 })).toEqual(await fresh.list({ depth: 1 }));
          expect(await store.search({ query: 'note' })).toEqual(
            await fresh.search({ query: 'note' })
          );
          expect(await store.describe()).toEqual(await fresh.describe());
          expect(await store.read('seed.md')).toEqual(await fresh.read('seed.md'));
        });
      }

      if (t.makeCounted && t.mutateExternally) {
        it('following an external change costs the change, not a rebuild', async () => {
          const counted = await t.makeCounted!();
          await counted.store.write({ path: 'seed.md', body: 'x' });
          await counted.store.list({}); // warm
          await t.mutateExternally!(counted.store);

          counted.reset();
          expect(await counted.store.refresh()).toHaveLength(1);
          const drift = counted.trips();

          counted.reset();
          await counted.store.list({});
          expect(counted.trips(), 'answering after a push must not rebuild').toBe(0);
          expect(drift, 'drift detection is bounded by the diff').toBeLessThanOrEqual(3);
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
