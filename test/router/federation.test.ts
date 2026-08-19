// More than one granted vault turns the @vault/ prefix on: it is accepted going
// in and re-applied to every path coming out, so everything the caller sees is
// addressable again. The router adds exactly this - refusals still come from the
// container (forbidden) and the store (restricted, invalid_path) untouched.

import { beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from '../../src/index.js';
import { createRouter, unknownVaultMessage, type Router } from '../../src/router/router.js';
import { world, type World } from './harness.js';

// The exact text the CLI regex-matches (memory-core parity) - byte-frozen.
const GOLDEN = 'Unknown vault "@ghost". Use memory__list with no folder to see available vaults.';

const seeds = {
  main: [{ path: 'a.md', body: 'main zebra' }],
  work: [
    { path: 'p.md', body: 'work zebra' },
    { path: 'dir/q.md', body: 'nested zebra' },
  ],
  secret: [{ path: 'a.md', body: 'not granted' }],
};

const granted = new Set(['main', 'work', 'ghost']); // ghost is granted but never provisioned

describe('router federation (>1 vault)', () => {
  let w: World;
  let r: Router;

  beforeEach(async () => {
    w = await world(seeds, { over: { vaults: granted } });
    r = createRouter(w.container, w.access, { defaultVault: 'main' });
  });

  it('resolves a plain ref to the default vault and tags the result', async () => {
    const written = await r.write('bare.md', { body: 'in main' });
    expect(written.path).toBe('@main/bare.md');
    expect((await r.read('@main/bare.md'))?.body).toBe('in main');
    expect((await r.read('bare.md'))?.path).toBe('@main/bare.md');
    expect(await r.read('@work/bare.md')).toBeNull();
  });

  it('routes every verb by @vault and tags every returned path', async () => {
    const written = await r.write('@work/new.md', { body: 'w' });
    expect(written.path).toBe('@work/new.md');
    const edited = await r.edit('@work/new.md', { mode: 'append', body: 'more' });
    expect(edited?.path).toBe('@work/new.md');
    expect((await r.read('@work/new.md'))?.path).toBe('@work/new.md');
    expect(await r.delete('@work/new.md')).toBe(true);
    expect(await r.read('@work/new.md')).toBeNull();
  });

  it('fans search out across the granted vaults, tagging each hit', async () => {
    const res = await r.search({ query: 'zebra' });
    expect(res.results.map((h) => h.path).sort()).toEqual([
      '@main/a.md',
      '@work/dir/q.md',
      '@work/p.md',
    ]);
  });

  it('scopes search to one vault with an @folder', async () => {
    const res = await r.search({ query: 'zebra', folder: '@work' });
    expect(res.results.map((h) => h.path).sort()).toEqual(['@work/dir/q.md', '@work/p.md']);
    const deeper = await r.search({ query: 'zebra', folder: '@work/dir' });
    expect(deeper.results.map((h) => h.path)).toEqual(['@work/dir/q.md']);
  });

  it('shows every vault as a top-level @folder at the root', async () => {
    const res = await r.list({});
    expect(res.folder).toBe('');
    expect(res.entries.map((e) => e.path)).toEqual(['@main', '@work']); // ghost is not provisioned
    expect(res.entries.every((e) => e.type === 'folder')).toBe(true);
    expect(res.files).toBe(3);
    const work = res.entries.find((e) => e.path === '@work');
    expect(work).toMatchObject({ type: 'folder', files: 2 });
    expect(work?.type === 'folder' ? work.entries?.map((e) => e.path).sort() : undefined).toEqual([
      '@work/dir',
      '@work/p.md',
    ]);
  });

  it('lists the vaults alone at depth 1', async () => {
    const res = await r.list({ depth: 1 });
    expect(res.entries).toEqual([
      { type: 'folder', path: '@main', files: 1, entries: undefined },
      { type: 'folder', path: '@work', files: 2, entries: undefined },
    ]);
  });

  it('prefixes list entries under an @vault folder and under the default vault', async () => {
    const scoped = await r.list({ ref: '@work/dir' });
    expect(scoped.folder).toBe('@work/dir');
    expect(scoped.entries.map((e) => e.path)).toEqual(['@work/dir/q.md']);
    const vaultRoot = await r.list({ ref: '@work' });
    expect(vaultRoot.folder).toBe('@work');
    expect(vaultRoot.entries.map((e) => e.path).sort()).toEqual(['@work/dir', '@work/p.md']);
    const plain = await r.list({ ref: 'dir', depth: 1 });
    expect(plain.folder).toBe('@main/dir'); // a bare folder still resolves in the default vault
  });

  it('refuses a granted-but-absent vault with the frozen CLI message', async () => {
    const err = await r.read('@ghost/x.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: 'unknown_vault' });
    expect((err as StoreError).message).toBe(GOLDEN);
    expect(unknownVaultMessage('ghost')).toBe(GOLDEN);
    // the shape the cli parses out of the message
    expect(/Unknown vault "@([^"]+)"\./.exec((err as StoreError).message)?.[1]).toBe('ghost');
    await expect(r.write('@ghost/x.md', { body: 'x' })).rejects.toMatchObject({
      code: 'unknown_vault',
      message: GOLDEN,
    });
    await expect(r.list({ ref: '@ghost' })).rejects.toMatchObject({ message: GOLDEN });
  });

  it('passes the container refusal through for a vault outside the grant', async () => {
    const err = await r.read('@secret/a.md').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: 'no access to vault: secret' });
    expect(w.opened).toEqual([]);
  });

  it('passes store refusals through untouched', async () => {
    await expect(
      r.write('@work/k.md', { body: `api_key: sk-${'a'.repeat(24)}` })
    ).rejects.toMatchObject({ code: 'restricted' });
    await expect(r.write('@work/../escape.md', { body: 'x' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('falls back to the first listed vault when no default is configured', async () => {
    const bare = createRouter(w.container, w.access);
    expect((await bare.write('x.md', { body: 'y' })).path).toBe('@main/x.md');
  });

  it('honours a configured default vault', async () => {
    const onWork = createRouter(w.container, w.access, { defaultVault: 'work' });
    expect((await onWork.read('p.md'))?.body).toBe('work zebra');
    expect((await onWork.list({ ref: 'dir' })).folder).toBe('@work/dir');
  });

  it('refuses every verb when the connection has no vault at all', async () => {
    const empty = await world({}, { over: { vaults: new Set<string>() } });
    const none = createRouter(empty.container, empty.access);
    await expect(none.read('a.md')).rejects.toMatchObject({ code: 'unknown_vault' });
    await expect(none.list({})).rejects.toMatchObject({ code: 'unknown_vault' });
    await expect(none.search({ query: 'x' })).rejects.toMatchObject({ code: 'unknown_vault' });
  });
});
