import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadLocalServer } from '../src/server/local-server.js';
import { call } from './fixtures/mcp.js';
import { tmpConfig, tmpVault } from './fixtures/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The stdio shim wraps memory-core: load vaults.json -> registry -> 6-tool server.
describe('stdio shim (@agentage/server-memory) wraps memory-core', () => {
  it('loadLocalServer serves the configured vaults over MCP (in-memory)', async () => {
    const configDir = tmpConfig(
      { work: { path: tmpVault({ 'seed.md': 'hello pkce' }) } },
      { default: 'work' }
    );
    const server = await loadLocalServer({ configDir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    try {
      expect((await client.listTools()).tools).toHaveLength(6);
      const s = await call(client, 'memory__search', { query: 'pkce' });
      expect((s.structured as { results: unknown[] }).results).toHaveLength(1);
      const w = await call(client, 'memory__write', { path: 'new.md', body: 'fresh' });
      expect(w.isError).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  describe('over a real spawned stdio process', () => {
    beforeAll(() => {
      execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
    }, 60_000);

    it('exposes the 6 tools and round-trips through the bin', async () => {
      const configDir = tmpConfig(
        { work: { path: tmpVault({ 'note.md': 'remember oauth' }) } },
        { default: 'work' }
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(repoRoot, 'dist/bin/server-memory.js')],
        env: { ...(process.env as Record<string, string>), AGENTAGE_CONFIG_DIR: configDir },
      });
      const client = new Client({ name: 'spawn-test', version: '0' });
      await client.connect(transport);
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toContain('memory__search');
        const s = await call(client, 'memory__search', { query: 'oauth' });
        expect((s.structured as { results: Array<{ path: string }> }).results[0].path).toBe(
          'note.md'
        );
        const w = await call(client, 'memory__write', {
          path: 'fromshim.md',
          body: 'written via shim',
        });
        expect(w.isError).toBe(false);
        const r = await call(client, 'memory__read', { path: 'fromshim.md' });
        expect((r.structured as { body: string }).body).toBe('written via shim');
      } finally {
        await client.close();
      }
    }, 30_000);
  });
});
