# @agentage/memory-core

Config-driven multi-vault engine for **agentage Memory**: the frozen 6 MCP tools
(`memory__search/read/list/write/edit/delete`) over pluggable vault backends. One
config (`~/.agentage/vaults.json`), one extension seam (`VaultBackend`), thin clients
on top. See the design in the vault: `features/memory-core/{memory-core,requirements,vaults-json}.md`.

## Status

- **M1 (local vault)** — read · search · list · write · edit · delete · `init`, over a
  local markdown folder kept as a git working copy. Zero network. ✅
- **M2 (MCP server)** — `createMemoryServer` exposes the surfaced vaults as the frozen
  6 tools, with `@vault/` routing + multi-vault fan-out. ✅
- **stdio shim** (`@agentage/server-memory`) — `agentage-server-memory` binds the local
  server to stdio for stdio-only clients and as the npm keystone. ✅
- M3 (external-git sync) and M4 (agentage auth + RemoteBackend) — not yet built; the
  `RemoteBackend` is a loud placeholder until M4.

## Public API

```ts
import { loadConfig, createRegistry, createMemoryServer, createLocalBackend, init } from '@agentage/memory-core';

const config = await loadConfig();                  // reads + validates ~/.agentage/vaults.json
const registry = await createRegistry(config);      // one backend per vault
const server = createMemoryServer(registry, { scope: 'local' }); // an McpServer over the 6 tools
```

`VaultBackend` is the one seam — byte-identical to the server's `MemoryStore` (minus the
`memoryId` arg). New capabilities = new backends behind it, never new public surface.

## Run the stdio shim

```bash
npm run build
node dist/bin/server-memory.js     # serves ~/.agentage/vaults.json over stdio
# or, once published:  npx @agentage/server-memory
```

## Develop

```bash
npm install
npm test          # vitest (M1 + M2 + shim, incl. a real spawned-stdio smoke)
npm run verify    # type-check + lint + format:check + test + build
```

The 6-tool contract (`src/contract/`) and the text renderer are vendored verbatim from
`agentage/web` `packages/memory-mcp`; `.mcpc.json` is the frozen snapshot the contract
test pins against. Re-sync on any contract change (tracked as `@agentage/memory-contract`,
requirements D10).
