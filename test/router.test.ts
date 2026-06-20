import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { createRouter, UnknownVaultError } from '../src/router/router.js';
import type { VaultHandle } from '../src/registry/registry.js';
import { tmpVault } from './fixtures/index.js';

const handle = (id: string, files?: Record<string, string>): VaultHandle => ({
  id,
  mcp: ['local'],
  backend: createLocalBackend({ path: tmpVault(files) }),
});

// The federation engine (transport-agnostic): @vault routing + fan-out + tagging.
describe('router (federation engine)', () => {
  it('single vault is transparent - bare paths, no @ prefix', async () => {
    const h = handle('work');
    const r = createRouter([h], h);
    expect(r.multi).toBe(false);
    const w = await r.write({ path: 'a.md', body: 'hello' });
    expect(w.path).toBe('a.md');
    expect((await r.read('a.md'))!.body).toBe('hello');
  });

  it('multi vault: bare -> default, @vault -> that vault, tags round-trip', async () => {
    const work = handle('work');
    const personal = handle('personal');
    const r = createRouter([work, personal], work);
    expect(r.multi).toBe(true);
    const w = await r.write({ path: 'bare.md', body: 'in work' });
    expect(w.path).toBe('@work/bare.md'); // tagged back, addressable
    await r.write({ path: '@personal/p.md', body: 'in personal' });
    expect((await r.read('@personal/p.md'))!.body).toBe('in personal');
    expect(await r.read('@personal/bare.md')).toBeNull(); // no cross-vault leak
  });

  it('search fans out and tags each hit with @vault', async () => {
    const a = handle('work', { 'x.md': 'shared term' });
    const b = handle('personal', { 'y.md': 'shared term too' });
    const r = createRouter([a, b], a);
    const res = await r.search({ query: 'shared' });
    expect(res.results.map((h) => h.path).sort()).toEqual(['@personal/y.md', '@work/x.md']);
  });

  it('list with no folder shows each vault as a top-level @folder', async () => {
    const a = handle('work', { 'x.md': 'a' });
    const b = handle('personal', { 'y.md': 'b' });
    const r = createRouter([a, b], a);
    const res = await r.list({});
    expect(res.entries.map((e) => e.path).sort()).toEqual(['@personal', '@work']);
    expect(res.entries.every((e) => e.type === 'folder')).toBe(true);
  });

  it('throws UnknownVaultError for an unknown @vault', async () => {
    const h = handle('work');
    const r = createRouter([h], h);
    await expect(r.read('@ghost/x.md')).rejects.toBeInstanceOf(UnknownVaultError);
  });
});
