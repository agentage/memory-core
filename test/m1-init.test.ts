import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { init } from '../src/setup/init.js';

const dirs: string[] = [];
const mk = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// init scaffolds + git-inits offline.
describe('init', () => {
  it('scaffolds a loadable vaults.json and git-inits the vault, with no network', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network call during init');
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;

    const configDir = mk('mc-init-cfg-');
    const vaultPath = mk('mc-init-vault-');
    const result = await init({ configDir, vaultName: 'work', vaultPath });

    expect(result.createdConfig).toBe(true);
    expect(result.createdRepo).toBe(true);
    expect(existsSync(join(vaultPath, '.git'))).toBe(true);

    const config = await loadConfig({ configDir });
    expect(config.default).toBe('work');
    expect(config.vaults.work.path).toBe(vaultPath);
    expect(config.vaults.work.mcp).toEqual(['local']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is idempotent - never clobbers an existing config', async () => {
    const configDir = mk('mc-init-cfg-');
    const vaultPath = mk('mc-init-vault-');
    await init({ configDir, vaultName: 'work', vaultPath });
    const edited = '{"version":1,"default":"work","vaults":{"work":{"path":"' + vaultPath + '"}}}';
    writeFileSync(join(configDir, 'vaults.json'), edited);

    const again = await init({ configDir, vaultName: 'work', vaultPath });
    expect(again.createdConfig).toBe(false);
    expect(again.createdRepo).toBe(false);
    expect(readFileSync(join(configDir, 'vaults.json'), 'utf8')).toBe(edited);
  });
});
