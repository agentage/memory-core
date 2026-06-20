# @agentage/memory-core

The transport-agnostic **engine** behind agentage Memory: config, a vault registry,
storage backends (the `VaultBackend` seam), and a federation router. It has **no MCP
dependency** - the MCP server layer lives in a separate package that builds on this one.

## What's in here

| Module | Job |
|--------|-----|
| `contract` | the data types (`WriteInput`, `SearchResult`, ...) + document helpers (serialize/parse/tags/snippet) |
| `backends` | the `VaultBackend` interface + `LocalBackend` (a local markdown folder kept as a git working copy) |
| `config` | load + validate `~/.agentage/vaults.json` |
| `registry` | one backend per configured vault, surfaced by scope |
| `router` | federation: `@vault/` addressing + multi-vault fan-out (transport-agnostic) |
| `setup` | `init` - offline scaffold of `~/.agentage` + a starter vault |

`VaultBackend` is the single extension seam: new storage capabilities are new backends
behind the same interface, never new public surface.

## Public API

```ts
import { loadConfig, createRegistry, createRouter, createLocalBackend, init } from '@agentage/memory-core';

const config = await loadConfig();             // reads + validates ~/.agentage/vaults.json
const registry = await createRegistry(config); // one backend per vault
const router = createRouter(registry.surfaced('local'), registry.default());
// router exposes read / write / edit / delete / search / list over the federated vaults.
```

A local vault is a plain markdown folder under git: reads and search run against the
working tree (so an edit made in any editor is visible immediately), and every write is
a commit (delete is a recoverable removal). Search is literal substring, ranked by match
count; list is a depth-bounded folder tree.

## Develop

```bash
npm install
npm test          # vitest
npm run verify    # type-check + lint + format:check + test + build
```

Node 22+, TypeScript (strict, ESM), Vitest, ESLint + Prettier.
