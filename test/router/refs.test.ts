// The ref grammar is the router's entire input surface: "path" -> the default
// vault, "@vault/path" -> that vault. Three refusal tiers, three owners: a
// malformed ref dies in the router before any container call, an unaddressable
// vault name dies in the container's segment allowlist, and a hostile in-vault
// path is the store's business. No tier may ever open a vault outside the grant.

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

// Refused by the grammar itself - a ref that names no vault, or names no document.
const MALFORMED_REFS = ['', '@', '@x', '@x/', '@/a.md', '@a/@b/c.md', '@main/@work/a.md'];

// Well-formed refs whose VAULT segment can never be a path component.
const UNADDRESSABLE_VAULT_REFS = [
  '@../x/a.md',
  '@.git/a.md',
  '@ünicode/a.md',
  '@main.git/a.md',
  '@main.deleted-1/a.md',
  `@${'e'.repeat(65)}/a.md`,
  '@has space/a.md',
];

// Well-formed refs into a granted vault whose in-vault path is hostile: the STORE
// owns these (refuse on write, not-found on read) - the router only routes.
const HOSTILE_PATH_REFS = [
  '@work/../a.md',
  '@work/.git/config',
  '@work/.agentage/hooks.md',
  '@work/a\u0000.md',
  '../a.md',
  '.git/config',
  '/abs.md',
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

describe('router ref grammar', () => {
  let w: World;
  let r: Router;

  beforeEach(async () => {
    w = await world(seeds, { over: { vaults: GRANTED } });
    r = createRouter(w.container, w.access, { defaultVault: 'main' });
  });

  it('routes every valid ref shape to the right vault', async () => {
    expect((await r.read('a.md'))?.body).toBe('main note'); // plain -> default
    expect((await r.read('@main/a.md'))?.body).toBe('main note');
    expect((await r.read('@work/dir/a.md'))?.body).toBe('work note');
    expect(await r.read('@work/a.md')).toBeNull(); // no cross-vault fallback
    expect(await r.read('dir/a.md')).toBeNull();
    const deep = await r.write('@work/x/y/z.md', { body: 'deep' });
    expect(deep.path).toBe('@work/x/y/z.md');
    expect(w.opened.every((v) => GRANTED.has(v))).toBe(true);
  });

  it('refuses a malformed ref before touching the container', async () => {
    for (const ref of MALFORMED_REFS) {
      for (const verb of verbs(r)) {
        w.reset();
        const err = await verb.run(ref).catch((e: unknown) => e);
        expect(err, `${verb.name}(${JSON.stringify(ref)})`).toBeInstanceOf(StoreError);
        expect(err).toMatchObject({ code: 'invalid_path' });
        expect(w.calls, `${verb.name}(${JSON.stringify(ref)}) touched the container`).toEqual([]);
      }
    }
  });

  it('refuses an unaddressable vault name in the container, opening nothing', async () => {
    for (const ref of UNADDRESSABLE_VAULT_REFS) {
      for (const verb of verbs(r)) {
        w.reset();
        const err = await verb.run(ref).catch((e: unknown) => e);
        expect(err, `${verb.name}(${JSON.stringify(ref)})`).toBeInstanceOf(StoreError);
        expect(err).toMatchObject({ code: 'invalid_path' });
        expect(w.opened).toEqual([]);
      }
    }
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
          expect((out as StoreError).code, label).toBe('invalid_path');
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
      ...MALFORMED_REFS,
      ...UNADDRESSABLE_VAULT_REFS,
      ...HOSTILE_PATH_REFS,
      '@secret/a.md',
    ];
    w.reset();
    for (const ref of refs) for (const verb of verbs(r)) await verb.run(ref).catch(() => undefined);
    expect(w.opened.filter((v) => !GRANTED.has(v))).toEqual([]);
    expect((await (await w.direct('secret')).read('a.md'))?.body).toBe('not granted');
  });
});
