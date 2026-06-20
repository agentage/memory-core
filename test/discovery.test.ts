import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, validateConfig } from '../src/config/config.js';
import { createRegistry } from '../src/registry/registry.js';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// vaultsDir + autodiscover: drop a folder in -> it's a vault.
describe('autodiscover', () => {
  it('treats each subfolder of vaultsDir as a vault (dotfolders skipped)', async () => {
    const base = tmp('mc-vd-');
    for (const name of ['work', 'personal', '.hidden']) mkdirSync(join(base, name));
    const reg = await createRegistry(
      validateConfig({ version: 1, vaultsDir: base, autodiscover: true })
    );
    expect(
      reg
        .list()
        .map((h) => h.id)
        .sort()
    ).toEqual(['personal', 'work']);
    expect(reg.get('work')!.backend.capabilities().kind).toBe('local');
  });

  it('explicit vaults override a discovered folder of the same name', async () => {
    const base = tmp('mc-vd-');
    mkdirSync(join(base, 'work'));
    const override = tmp('mc-ov-');
    const reg = await createRegistry(
      validateConfig({
        version: 1,
        vaultsDir: base,
        autodiscover: true,
        vaults: { work: { path: override, mcp: ['local', 'remote'] } },
      })
    );
    expect(reg.surfaced('remote').map((h) => h.id)).toEqual(['work']); // override's scope won
  });

  it('a discovered vault is writable (autoInit git-inits it)', async () => {
    const base = tmp('mc-vd-');
    mkdirSync(join(base, 'notes'));
    const reg = await createRegistry(
      validateConfig({ version: 1, vaultsDir: base, autodiscover: true, default: 'notes' })
    );
    const b = reg.get('notes')!.backend;
    await b.write({ path: 'a.md', body: 'hi' });
    expect((await b.read('a.md'))!.body).toBe('hi');
  });

  it('autodiscover without vaultsDir is a ConfigError', () => {
    expect(() => validateConfig({ version: 1, autodiscover: true })).toThrow(ConfigError);
  });
});

// autoInit:false refuses to create a missing vault folder.
describe('autoInit', () => {
  it('false + missing path -> operations error instead of creating', async () => {
    const reg = await createRegistry(
      validateConfig({
        version: 1,
        autoInit: false,
        vaults: { x: { path: join(tmpdir(), 'mc-does-not-exist-xyz', 'v') } },
      })
    );
    await expect(reg.get('x')!.backend.read('a.md')).rejects.toThrow(/autoInit is off/);
  });
});
