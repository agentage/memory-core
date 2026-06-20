import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../src/registry/registry.js';
import { validateConfig } from '../src/config/config.js';
import { tmpVault } from './fixtures/index.js';

// registry builds LocalBackend per path entry, path-only = zero network.
describe('createRegistry', () => {
  it('builds a LocalBackend for every entry with a path', async () => {
    const reg = await createRegistry(
      validateConfig({
        version: 1,
        default: 'work',
        vaults: { work: { path: tmpVault() }, scratch: { path: tmpVault() } },
      })
    );
    expect(reg.list()).toHaveLength(2);
    expect(reg.get('work')!.backend.capabilities().kind).toBe('local');
    expect(reg.default()!.id).toBe('work');
  });

  it('surfaces vaults by mcp scope', async () => {
    const reg = await createRegistry(
      validateConfig({
        version: 1,
        vaults: {
          a: { path: tmpVault(), mcp: ['local', 'remote'] },
          b: { path: tmpVault(), mcp: ['local'] },
          hidden: { path: tmpVault(), mcp: [] },
        },
      })
    );
    expect(
      reg
        .surfaced('local')
        .map((h) => h.id)
        .sort()
    ).toEqual(['a', 'b']);
    expect(reg.surfaced('remote').map((h) => h.id)).toEqual(['a']);
  });
});

// a path-only vault performs ZERO network calls across its full lifecycle.
describe('path-only vault makes no network calls', () => {
  const guards: Array<{ restore: () => void; name: string; calls: () => number }> = [];

  beforeEach(() => {
    const trap = (obj: Record<string, unknown>, key: string) => {
      const original = obj[key];
      const spy = vi.fn(() => {
        throw new Error(`network call via ${key} in a path-only vault`);
      });
      obj[key] = spy;
      guards.push({
        name: key,
        calls: () => spy.mock.calls.length,
        restore: () => (obj[key] = original),
      });
    };
    trap(globalThis as unknown as Record<string, unknown>, 'fetch');
  });

  afterEach(() => {
    while (guards.length) guards.pop()!.restore();
  });

  it('write/read/search/list/edit/delete touch no network', async () => {
    const reg = await createRegistry(
      validateConfig({ version: 1, default: 'w', vaults: { w: { path: tmpVault() } } })
    );
    const b = reg.get('w')!.backend;
    await b.write({ path: 'a.md', body: 'hello world' });
    await b.read('a.md');
    await b.search({ query: 'hello' });
    await b.list({});
    await b.edit({ path: 'a.md', mode: 'append', body: 'more' });
    await b.delete('a.md');
    expect(guards.every((g) => g.calls() === 0)).toBe(true);
  });
});
