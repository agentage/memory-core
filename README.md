# @agentage/store-core

The storage foundation for agentage Memory: one storage-agnostic **vault store contract** ("markdown docs addressed by path, opaquely versioned") plus swappable implementations. One instance = one vault. Multi-tenancy, auth, and protocol rendering live in the consumers - never here.

North star spec: `vaults/agentage/specs/north-star-store-core.md`.

## Contract

`VaultStore` - 10 members: the 6 verbs (`read` / `list` / `search` / `write` / `edit` / `delete`), plus `version()` (opaque change token), `refresh()` (surface out-of-band changes as events), `subscribe()` (the one extension seam), `capabilities()` (honest divergence).

All semantics are single-sourced in `src/contract/` and shared by every store: edit modes (`applyEdit`), tree shape (`buildTree`), search ranking (`rankAndPage`), path safety (`safePath`), the restricted-data screen, and the read clamp. A store implements persistence and matching; behavior comes from the contract.

## Implementations

| Store                               | Status                               | Search                           |
| ----------------------------------- | ------------------------------------ | -------------------------------- |
| `createMemoryStore`                 | ✅ this repo                         | in-process scan (reference impl) |
| `createBareGitStore` (server)       | ✅ this repo                         | `git grep` HEAD                  |
| `createWorkingCopyGitStore` (local) | planned - harvest from `memory-core` | `git grep` worktree              |
| `createIndexedGitStore`             | planned                              | SQLite FTS5, grep fallback       |
| `createRemoteStore`                 | planned                              | server-side via /v1              |

## Conformance

Every implementation must pass the shared kit - functional + security:

```ts
import { contractSuite } from '../src/conformance/contract-suite.js';
import { securitySuite } from '../src/conformance/security-suite.js';

contractSuite({ name: 'my-store', make: () => createMyStore() });
securitySuite({ name: 'my-store', make: () => createMyStore() });
```

A store that passes the kit is guaranteed swappable behind the contract.

## Develop

```bash
npm install
npm run verify   # type-check + lint + format:check + test + build
```

CI tiers: PR = `verify` (fast, merge-blocking). Nightly bench/soak/fuzz tiers land with the git stores.
