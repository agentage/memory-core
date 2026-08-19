// ONE input rule: every ref is `@vault/path`. The corpus proves the four refusal
// tiers and who owns each - a ref that is not @-prefixed, malformed, or names an
// unaddressable vault dies in the router's pure grammar; an ungranted vault dies
// in the router's permission gate; both before ANY container call. Only a
// well-formed ref into a granted vault reaches the store, which owns hostile
// in-vault paths. No tier may ever open a vault outside the grant.

import { beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from '../../src/index.js';
import { createRouter, type Router } from '../../src/router/router.js';
import { world, type World } from './harness.js';

const GRANTED = new Set(['main', 'work']);

const seeds = {
  main: [{ path: 'a.md', body: 'main note' }],
  work: [{ path: 'dir/a.md', body: 'work note' }],
  secret: [{ path: 'a.md', body: 'not granted' }],
};

// No leading @ - there is no default vault and no transparency mode to fall into.
const UNPREFIXED_REFS = ['a.md', 'dir/a.md', '', '../a.md', '.git/config', '/abs.md', 'main/a.md'];

// @-prefixed but not a ref: no vault named, a nested @, or no document named.
const MALFORMED_REFS = ['@', '@/a.md', '@main/@work/a.md', '@a/@b/c.md'];

// Well-formed shape whose VAULT segment can never be a path component.
const UNADDRESSABLE_VAULT_REFS = [
  '@../x/a.md',
  '@.git/a.md',
  '@ünicode/a.md',
  '@main.git/a.md',
  '@main.deleted-1/a.md',
  `@${'e'.repeat(65)}/a.md`,
  '@has space/a.md',
];

// A granted vault, hostile in-vault path: the STORE owns these (refuse on write,
// not-found on read) - the router only routes.
const HOSTILE_PATH_REFS = [
  '@work/../a.md',
  '@work/.git/config',
  '@work/.agentage/hooks.md',
  '@work/a\u0000.md',
  '@main//abs.md',
];

interface Verb {
  name: string;
  run: (ref: string) => Promise<unknown>;
}

const verbs = (r: Router): Verb[] => [
  { name: 'read', run: (ref) => r.read(ref) },
  { name: 'write', run: (ref) => r.write(ref, { body: 'x' }) },
  { name: 'edit', run: (ref) => r.edit(ref, { mode: 'append', body: 'x' }) },
  { name: 'delete', run: (ref) => r.delete(ref) },
];

// list and search take the same refs, minus the "must name a document" rule.
const scoped = (r: Router): Verb[] => [
  { name: 'list', run: (ref) => r.list({ ref }) },
  { name: 'search', run: (ref) => r.search({ query: 'x', folder: ref }) },
];

describe('router ref grammar', () => {
  let w: World;
  let r: Router;

  beforeEach(async () => {
    w = await world(seeds, { over: { vaults: GRANTED } });
    r = createRouter(w.container, w.access);
  });

  it('routes every valid ref shape to its vault and tags what it returns', async () => {
    expect((await r.read('@main/a.md'))?.body).toBe('main note');
    expect((await r.read('@main/a.md'))?.path).toBe('@main/a.md');
    expect((await r.read('@work/dir/a.md'))?.body).toBe('work note');
    expect(await r.read('@work/a.md')).toBeNull(); // no cross-vault fallback
    const deep = await r.write('@work/x/y/z.md', { body: 'deep' });
    expect(deep.path).toBe('@work/x/y/z.md');
    expect((await r.read(deep.path))?.body).toBe('deep'); // the output round-trips
    expect(w.opened.every((v) => GRANTED.has(v))).toBe(true);
  });

  it('refuses an unprefixed ref on every verb, before touching the container', async () => {
    for (const ref of UNPREFIXED_REFS) {
      for (const verb of [...verbs(r), ...scoped(r)]) {
        w.reset();
        const err = await verb.run(ref).catch((e: unknown) => e);
        const label = `${verb.name}(${JSON.stringify(ref)})`;
        expect(err, label).toBeInstanceOf(StoreError);
        expect(err, label).toMatchObject({ code: 'invalid_path' });
        expect((err as StoreError).message, label).toContain('"@vault/path"');
        expect(w.calls, `${label} touched the container`).toEqual([]);
      }
    }
  });

  it('refuses a malformed or unaddressable ref before touching the container', async () => {
    for (const ref of [...MALFORMED_REFS, ...UNADDRESSABLE_VAULT_REFS]) {
      for (const verb of [...verbs(r), ...scoped(r)]) {
        w.reset();
        const err = await verb.run(ref).catch((e: unknown) => e);
        const label = `${verb.name}(${JSON.stringify(ref)})`;
        expect(err, label).toBeInstanceOf(StoreError);
        expect(err, label).toMatchObject({ code: 'invalid_path' });
        expect(w.calls, `${label} touched the container`).toEqual([]);
      }
    }
  });

  it('requires a document path on the doc verbs, but not on list or search', async () => {
    for (const ref of ['@main', '@main/']) {
      for (const verb of verbs(r)) {
        w.reset();
        await expect(verb.run(ref), `${verb.name}(${ref})`).rejects.toMatchObject({
          code: 'invalid_path',
        });
        expect(w.calls).toEqual([]);
      }
      expect((await r.list({ ref })).folder).toBe('@main');
      expect((await r.search({ query: 'main', folder: ref })).results).toHaveLength(1);
    }
  });

  it('refuses an ungranted vault itself, with zero container interaction', async () => {
    for (const verb of [...verbs(r), ...scoped(r)]) {
      w.reset();
      const err = await verb.run('@secret/a.md').catch((e: unknown) => e);
      expect(err, verb.name).toBeInstanceOf(StoreError);
      expect(err, verb.name).toMatchObject({
        code: 'forbidden',
        message: 'no access to vault: secret',
      });
      expect(w.calls, `${verb.name} touched the container`).toEqual([]);
    }
    expect((await (await w.direct('secret')).read('a.md'))?.body).toBe('not granted');
  });

  it('passes a hostile in-vault path to the store, which refuses or reports absence', async () => {
    const before = [await w.files('main'), await w.files('work'), await w.files('secret')];
    for (const ref of HOSTILE_PATH_REFS) {
      for (const verb of verbs(r)) {
        w.reset();
        const out = await verb.run(ref).catch((e: unknown) => e);
        const label = `${verb.name}(${JSON.stringify(ref)})`;
        if (out instanceof Error) {
          expect(out, label).toBeInstanceOf(StoreError);
          expect(out, label).toMatchObject({ code: 'invalid_path' });
        } else {
          // Not-found is the only non-throwing answer a hostile path may produce.
          expect([null, false], label).toContain(out);
        }
        expect(
          w.opened.every((v) => GRANTED.has(v)),
          label
        ).toBe(true);
      }
    }
    expect([await w.files('main'), await w.files('work'), await w.files('secret')]).toEqual(before);
  });

  it('never opens a vault outside the grant, whatever the ref', async () => {
    const refs = [
      ...UNPREFIXED_REFS,
      ...MALFORMED_REFS,
      ...UNADDRESSABLE_VAULT_REFS,
      ...HOSTILE_PATH_REFS,
      '@secret/a.md',
    ];
    w.reset();
    for (const ref of refs) for (const verb of verbs(r)) await verb.run(ref).catch(() => undefined);
    expect(w.opened.filter((v) => !GRANTED.has(v))).toEqual([]);
  });
});
