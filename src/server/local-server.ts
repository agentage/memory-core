import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../config/config.js';
import { createRegistry } from '../registry/registry.js';
import { createMemoryServer } from './create-memory-server.js';

// The whole local stack in one call: read vaults.json -> registry -> a server
// exposing the local-scoped vaults via the 6 tools. The transport (stdio, HTTP) is
// the caller's choice. Used by the @agentage/server-memory stdio shim and the daemon.
export const loadLocalServer = async (opts: { configDir?: string } = {}): Promise<McpServer> => {
  const config = await loadConfig({ configDir: opts.configDir });
  const registry = await createRegistry(config);
  return createMemoryServer(registry, { scope: 'local' });
};
