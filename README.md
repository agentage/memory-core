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
| `channel` | couch account channel client: a wire-compatible CouchDB replicator |

`VaultBackend` is the single extension seam: new storage capabilities are new backends
behind the same interface, never new public surface.

## Couch account channel (client)

A memory can sync over one of two channels: **git** (smart-HTTP) or **couch** (a thin
CouchDB replicator). The `channel` module is the couch client - a faithful, byte-compatible
port of the replicator shipped in the Obsidian plugin, so every client speaks the same wire
protocol and the server bridge reassembles any client's writes.

It is transport-agnostic: nothing here imports a UI, an HTTP library, or `node:fs`. Three
seams are injected so the same code runs in a CLI daemon, an editor extension, or a browser:

- `FetchLike` - the `fetch` slice used (`status` + `json()`); pass `globalThis.fetch`.
- `FileStore` - `listMarkdown / read / write / remove` over vault-relative POSIX paths.
- `CouchStatePersistence` - `load / save` for the resume state (the CLI backs it with a JSON file).

Doc model (the public contract the bridge reads): a note becomes leaf docs keyed
`h:<sha256(64KiB chunk)>` plus a file doc `f:<path>` listing its leaves in order; the body is
UTF-8 chunked at 64KiB. Pull is a paged `_changes` feed with a resumable cursor; a missing
leaf aborts the page without advancing the cursor (never a truncated write). Push writes the
leaves with `_bulk_docs` then PUTs the file doc; an unchanged file skips the network.

Host resolution reads `GET /.well-known/agentage-sync` and `channelForVault(resolution, vault)`
returns `{ channel: 'couch', endpoint, db, tokenUrl }` or `{ channel: 'git' }`, degrading to
git when the couch advertisement is absent or partial.

```ts
import {
  CouchSync,
  CouchTokenClient,
  createCouchState,
  channelForVault,
  type FileStore,
} from '@agentage/memory-core';
```

## Public API

```ts
import { loadConfig, createRegistry, createRouter, createLocalBackend, init } from '@agentage/memory-core';

const config = await loadConfig();             // reads + validates ~/.agentage/vaults.json
const registry = await createRegistry(config); // one backend per vault
const router = createRouter(registry.surfaced('local'), registry.default());
// router exposes read / write / edit / delete / search / list over the federated vaults.
```

A local vault is a plain markdown folder under git: reads and searches run against the
working tree (so an edit made in any editor is visible immediately), and every write is
a commit (delete is a recoverable removal). Search is literal substring, ranked by match
count; list is a depth-bounded folder tree.

## Config: vaults.json

Vaults are declared in `~/.agentage/vaults.json` (validated by `loadConfig`). The published
JSON Schema for the file ships with the package at `schema/vaults.schema.json`; resolve its
absolute path with `vaultsSchemaPath()` or read the live object via `buildVaultsJsonSchema()`.

### Account entry shape

A vault that syncs through the **agentage account sync channel** is an ordinary flat entry
whose `origin` names the reserved `agentage` remote - there are no extra per-entry fields:

```jsonc
{
  "vaults": {
    "personal": {
      "path": "~/memory/personal",
      "origin": [{ "remote": "agentage" }], // reserved remote = account channel
      "mcp": ["local"]
    }
  }
}
```

`isAccountVault(entry)` is the public predicate for this shape (true when any origin's remote
is `agentage`). Any other `remote` value is a plain git remote.

### discover[]

`discover` lists directories whose immediate subfolders are candidate account vaults, so
dropping a folder into a watched root offers it up for sync. It is config shape only - the
watching and persistence live in the CLI daemon; memory-core just validates and types it.

```jsonc
{
  "discover": [
    {
      "path": "~/vaults", // root to scan; each subfolder is a candidate
      "autosync": true, // default true; false pauses discovered vaults
      "ignore": ["archive"] // subfolder names to never treat as vaults
    }
  ]
}
```

`scanDiscoverRoots(config)` is a pure helper that enumerates the candidates in the account
entry shape, skipping names that fail the vault-name rule (`^[A-Za-z0-9_-]{1,64}$`), are
ignored, or already match a registered vault by name or path.

## Develop

```bash
npm install
npm test          # vitest
npm run verify    # type-check + lint + format:check + test + build
```

Node 22+, TypeScript (strict, ESM), Vitest, ESLint + Prettier.

## License

MIT - see [LICENSE](./LICENSE).
