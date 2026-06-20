import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, validateConfig } from '../src/config/config.js';
import { tmpConfig, tmpConfigRaw, tmpVault } from './fixtures/index.js';

// load/validate (+reject).
describe('config load + validate', () => {
  it('loads and returns a valid config', async () => {
    const path = tmpVault();
    const dir = tmpConfig({ work: { path } }, { default: 'work' });
    const config = await loadConfig({ configDir: dir });
    expect(config.version).toBe(1);
    expect(config.default).toBe('work');
    expect(config.vaults.work.path).toBe(path);
  });

  it('accepts an origin-only, a path-only, and a combined entry', () => {
    const config = validateConfig({
      version: 1,
      vaults: {
        cloud: { origin: [{ remote: 'agentage' }], mcp: ['local', 'remote'] },
        scratch: { path: '~/scratch' },
        mixed: { path: '~/n', origin: [{ remote: 'git@github.com:me/n.git', interval: 5 }] },
      },
    });
    expect(Object.keys(config.vaults)).toHaveLength(3);
    expect(config.vaults.cloud.mcp).toEqual(['local', 'remote']);
  });

  it('rejects a default that names a missing vault (ConfigError key=default)', () => {
    let err: unknown;
    try {
      validateConfig({ version: 1, default: 'ghost', vaults: { work: { path: '/x' } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).key).toBe('default');
  });

  it('rejects an entry with neither origin nor path', () => {
    let err: unknown;
    try {
      validateConfig({ version: 1, vaults: { empty: {} } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).key).toContain('empty');
  });

  it('rejects an unknown mcp scope', () => {
    expect(() =>
      validateConfig({ version: 1, vaults: { x: { path: '/x', mcp: ['public'] } } })
    ).toThrow(ConfigError);
  });

  it('rejects a wrong version', () => {
    expect(() => validateConfig({ version: 2, vaults: {} })).toThrow(ConfigError);
  });

  it('throws ConfigError on malformed JSON', async () => {
    const dir = tmpConfigRaw('{ not json');
    await expect(loadConfig({ configDir: dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when vaults.json is missing', async () => {
    const dir = tmpVault(); // a dir with no vaults.json
    await expect(loadConfig({ configDir: dir })).rejects.toBeInstanceOf(ConfigError);
  });
});
