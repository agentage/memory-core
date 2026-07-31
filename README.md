# @agentage/store-core

The storage foundation for agentage Memory: one storage-agnostic **vault store contract** ("markdown docs addressed by path, opaquely versioned") plus swappable implementations. One instance = one vault. Multi-tenancy, auth, and protocol rendering live in the consumers - never here.

North star spec: `vaults/agentage/specs/north-star-store-core.md`.

## Install

```bash
# GitHub Packages - needs a read:packages token in .npmrc
npm install @agentage/store-core
```

## Quickstart

```ts
import { createBareGitStore } from '@agentage/store-core';

const store = createBareGitStore('/data/repos/alice01/main.git'); // one instance = one vault

await store.write(
  { path: 'inbox/idea.md', body: 'A quiet zebra #inbox' },
  { id: 'claude-desktop', name: 'Claude' }
);
const hits = await store.search({ query: 'zebra', limit: 10 }); // [{ path, title, snippet, score, updated }]
const view = await store.read('inbox/idea.md'); // { body, frontmatter, tags, title, updated }
await store.edit({ path: 'inbox/idea.md', mode: 'str_replace', old_str: 'quiet', new_str: 'loud' });
await store.delete('inbox/idea.md'); // recoverable - git history keeps it
```

Every write is a git commit with client attribution; guards are always on (path safety incl. `.git`/`.agentage` reservation, secrets/PII refusal, 8MB doc cap, 64KB read clamp).

### Events, out-of-band changes, derived data

```ts
store.subscribe((e) => console.log(e.type, e.paths, e.version)); // write | edit | delete | external

// someone `git push`ed / a human saved a file? surface it as events:
const externalEvents = await store.refresh();

// derived data: computed views cached by policy, disposable by construction
import { createDerivedCache, createStatsView } from '@agentage/store-core';
const cache = createDerivedCache(store, '/data/repos/alice01/main.cache');
const stats = await cache.get(createStatsView('/data/repos/alice01/main.git')); // { files, folders, sizeBytes }
```

### Swap the store, swap the search

```ts
import {
  createIndexedGitStore,
  createWorkingCopyGitStore,
  createMemoryStore,
  createRemoteStore,
} from '@agentage/store-core';

createIndexedGitStore(repoDir, indexDir); // same contract, SQLite-FTS5 search (7x faster @1k), grep fallback
createWorkingCopyGitStore(vaultDir); // local world: uncommitted editor saves are readable + searchable
createMemoryStore(); // dev/test fixture
createRemoteStore(baseUrl, token); // the contract over HTTP (server half: createStoreHandler)
```

| Store                       | World                  | Search                                     |
| --------------------------- | ---------------------- | ------------------------------------------ |
| `createMemoryStore`         | tests/dev              | in-process scan (reference impl)           |
| `createBareGitStore`        | server (multi-tenant)  | `git grep` HEAD                            |
| `createWorkingCopyGitStore` | local (human co-owned) | worktree scan, uncommitted included        |
| `createIndexedGitStore`     | server                 | SQLite FTS5 (`node:sqlite`), grep fallback |
| `createRemoteStore`         | any client             | server-side via `createStoreHandler`       |

## Consumer templates (start here when integrating)

- **MCP tool layer** (memory-mcp shape - token ctx, `@vault/` routing, isError results, store-swap proof): `test/integration/mcp-tools.showcase.test.ts`
- **/v1 REST handlers** (resource JSON, `{error:{code,message}}` envelope, derived stats): `test/integration/rest-api.showcase.test.ts`
- **Full lifecycle on one vault** (push -> events -> derived state -> restart): `test/integration/e2e-lifecycle.test.ts`

## Conformance

Every implementation must pass the shared kit - a store that passes is guaranteed swappable:

```ts
import { contractSuite } from '../src/conformance/contract-suite.js';
import { securitySuite } from '../src/conformance/security-suite.js';

contractSuite({ name: 'my-store', make: () => createMyStore() });
securitySuite({ name: 'my-store', make: () => createMyStore() });
```

## Test layout & CI

```
test/
├── unit/          contract helpers + fuzzing (property oracles, memory-vs-git differential)
├── stores/        conformance + security per implementation
├── integration/   consumer showcases + e2e lifecycle
└── perf/          non-functional gate - budgets asserted AND printed to the CI job summary
```

CI tiers: **PR** = full verify incl. perf @1000 notes (merge-blocking, `verify` is a required check) · **nightly** = perf @5000 + deep fuzz (500 property runs / 25 differential sequences).

## Develop

```bash
npm install
npm run verify   # type-check + lint + format:check + test + build
```
