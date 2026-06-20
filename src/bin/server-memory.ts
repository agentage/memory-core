#!/usr/bin/env node
// @agentage/server-memory - the stdio MCP keystone. Mirrors @modelcontextprotocol/
// server-memory: `npx @agentage/server-memory` exposes the user's local vaults
// (~/.agentage/vaults.json) as the 6 memory__* tools over stdio, for stdio-only
// clients (Windsurf, Zed) and as the published npm artifact. Zero memory logic -
// it just binds memory-core's server to a StdioServerTransport.
//
// stdout is the JSON-RPC wire; all diagnostics MUST go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadLocalServer } from '../server/local-server.js';

const main = async (): Promise<void> => {
  const server = await loadLocalServer();
  await server.connect(new StdioServerTransport());
  // The transport keeps the process alive until the client disconnects (stdin EOF).
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[server-memory] fatal: ${message}\n`);
  process.exit(1);
});
