# @agentage/memory-core

The memory engine for agentage Memory: one storage-agnostic **vault store contract** ("markdown docs addressed by path, opaquely versioned"), swappable implementations, and the two layers above them - an `Access`-gated multi-vault container and an `@vault/path` router. One store instance = one vault. Auth, tenancy policy, and protocol rendering live in the consumers - never here.

**`1.0.0` is a new engine under an existing name.** It replaces the `0.5.x` `@agentage/memory-core` line wholesale (different API, no upgrade path) and retires `@agentage/store-core`, the never-published name this repo grew up under.

North star spec: `vaults/agentage/specs/north-star-store-core.md`.

## Layers

```text
caller  (MCP tool layer, /v1 REST handlers, sync)
  |     every ref is @vault/path
  v
Router      permission fail-fast: the ref's vault is checked against Access BEFORE any
  |         container call; every path it emits comes back as @vault/path
  v
Container   Access-gated lifecycle over <root>/<userId>/<vault>.git - list/create/open/
  |         remove; open never provisions; an ObjectCache holds one live store instance
  |         per vault (LRU by object count, dispose on evict)
  v
VaultStore  the frozen contract - read/write/edit/delete/search/list/describe + events;
  |         guards always on (path safety, restricted data, size caps, read clamp)
  v
bare git    one bare repo per vault - every write is a commit, `git grep` is the index
```

Each layer stands alone: a single-vault consumer can hold a `VaultStore` directly, the container works without the router, and the router is a pure binding cheap enough to rebuild per request.

## Install

```bash
npm install @agentage/memory-core
```

MIT licensed, published to public npm. Requires **Node >=22**.

## Quickstart

```ts
import { createBareGitStore } from '@agentage/memory-core';

const store = createBareGitStore('/data/repos/alice01/main.git'); // one instance = one vault

await store.write(
  { path: 'inbox/idea.md', body: 'A quiet zebra #inbox' },
  { id: 'claude-desktop', name: 'Claude' }
);
const hits = await store.search({ query: 'zebra', limit: 10 }); // [{ path, title, snippet, score, updated }]
const view = await store.read('inbox/idea.md'); // { body, frontmatter, tags, title, updated }
await store.edit({ path: 'inbox/idea.md', mode: 'str_replace', old_str: 'quiet', new_str: 'loud' });
await store.delete('inbox/idea.md'); // recoverable - git history keeps it
await store.describe(); // { files, folders, sizeBytes, updated, version } - the vault card
```

Every write is a git commit with client attribution; guards are always on (path safety incl. `.git`/`.agentage` reservation, secrets/PII refusal, 8MB doc cap, 64KB read clamp).

The engine is hermetic: every git spawn gets a minimal explicit environment (`PATH` only, no `HOME`, global+system gitconfig voided), so a host's `~/.gitconfig` - identity, `core.autocrlf`, `core.hooksPath`, proxies - can never change engine behavior. Commit identity comes from the call, not the machine.

### Events, out-of-band changes, derived data

```ts
store.subscribe((e) => console.log(e.type, e.paths, e.version)); // write | edit | delete | external

// someone `git push`ed / a human saved a file? surface it as events:
const externalEvents = await store.refresh();

// derived data: computed views cached by policy, disposable by construction
import { createDerivedCache, createStatsView } from '@agentage/memory-core';
const cache = createDerivedCache(store, '/data/repos/alice01/main.cache');
const stats = await cache.get(createStatsView('/data/repos/alice01/main.git')); // { files, folders, sizeBytes }
```

### Shared live objects

```ts
import { ObjectCache } from '@agentage/memory-core';

// build ONE per process - bounded by object COUNT (not bytes), LRU by last use
const stores = new ObjectCache<VaultStore>({ max: 256, dispose: (s, key) => detach(s, key) });
stores.get(key, () => createBareGitStore(pathFor(key))); // same key = same instance
```

Type-agnostic by construction (it never imports an engine type), so the same class caches stores, parsed configs, watchers - anything rebuildable. `dispose` is best-effort cleanup on eviction/`delete`, never a correctness hook.

### Many vaults, one root (the server shape)

```ts
import {
  createBareGitStore,
  createVaultContainer,
  ensureBareRepo,
  ObjectCache,
  type VaultStore,
} from '@agentage/memory-core';

const container = createVaultContainer({
  root: '/data/repos', // layout: <root>/<userId>/<vault>.git
  store: (dir) => createBareGitStore(dir),
  provision: ensureBareRepo, // store-kind-specific init: the ONLY path that creates
  cache: new ObjectCache<VaultStore>({ max: 256, dispose: (s, key) => detach(s, key) }),
});

const access = await resolveAccess(principal); // host policy: token claims, plan limits, DB
await container.list(access); // allowlist-intersected, sorted
await container.create(access, 'work'); // gated by canCreate, idempotent
await container.open(access, 'work'); // NEVER provisions - unknown_vault if absent
await container.remove(access, 'work', stamp); // gated by canDelete -> <vault>.deleted-<stamp>.git
```

`Access` (`{ userId, vaults: Set | '*', canCreate, canDelete }`) is the only authority the container reads: the host decides who may touch which vault - `ResolveAccess` is a **type** here, policy never enters the engine - and the container enforces that decision against storage facts. It never reads the clock (deletion stamps are supplied by the caller), never provisions on a read path, and never configures the cache: the composition root builds the `ObjectCache` with its own `dispose`, because whoever creates subscriptions owns tearing them down. Refusals are coded: `invalid_path` (hostile id or stamp), `forbidden` (outside the grant, or missing canCreate/canDelete), `unknown_vault` (not provisioned).

### One addressable surface over those vaults (the router)

```ts
import { createRouter } from '@agentage/memory-core';

// pure binding - no IO here, so build one per request
const router = createRouter(container, access);

await router.read('@main/inbox/idea.md'); // every ref is @vault/path
await router.write('@work/plan.md', { body: 'ship it' }, client);
await router.search({ query: 'zebra' }); // no folder: fans out across every granted vault
await router.list({}); // no ref: each vault as a top-level @folder
await router.list({ ref: '@work/dir' }); // list and search may scope to @vault or @vault/folder
```

**One input rule:** a ref is always `@vault/path`. Anything without the prefix is `invalid_path` - there is no default vault and no single-vault special case, so a caller that wants a default resolves it itself. **One output rule:** every path the router emits - `view.path`, write/edit results, search hits, list entries and folders - comes back as `@vault/path`, so every output round-trips as an input. The two unscoped shapes are the discovery ones: `list({})` is the vault directory, `search({ query })` fans out across every granted vault and merges the per-vault pages into the contract's total order (score desc, recency desc, path asc) before re-paging.

**Router = permission check + routing to the corresponding vault instance. No default vault.** It is the responsible layer for permission: the ref's vault is checked against `Access` BEFORE any container call, so an ungranted vault is refused with `forbidden` and zero container interaction (the container's own gate stays the last line of defense). Everything else stays where it belongs - guards, ranking and paging in the store, provisioning in the container - and their refusals pass through untouched (`restricted`, `invalid_path`, `unavailable`). The one refusal the router owns is `unknown_vault` for a granted-but-unprovisioned `@vault`: its message text is a frozen client contract, exported as `unknownVaultMessage`.

Strip the tags off a response and what is left is byte-for-byte what calling the store directly returns - same values, same cursors, same events.

### Swap the store, keep the contract

```ts
import { createMemoryStore } from '@agentage/memory-core';

createMemoryStore(); // dev/test fixture - the reference implementation
```

| Store                | World                 | Search                           |
| -------------------- | --------------------- | -------------------------------- |
| `createMemoryStore`  | tests/dev             | in-process scan (reference impl) |
| `createBareGitStore` | server (multi-tenant) | `git grep` HEAD                  |

Both pass the same conformance kit, so a consumer written against one runs unchanged on the other. Stores for other worlds (local working copy, FTS-indexed, HTTP client/server) are out of scope for now - they were cut before `1.0.0` and are recoverable from git history.

## Consumer templates (start here when integrating)

- **MCP tool layer** (memory-mcp shape - token ctx, `@vault/` routing, isError results): `test/integration/mcp-tools.showcase.test.ts`
- **/v1 REST handlers** (resource JSON, `{error:{code,message}}` envelope, derived stats; `/notes` = the memory__list shape, cursor-drainable on opt-in): `test/integration/rest-api.showcase.test.ts`
- **Full lifecycle on one vault** (push -> events -> derived state -> restart): `test/integration/e2e-lifecycle.test.ts`

## Conformance

Every implementation must pass the shared kit - a store that passes is guaranteed swappable:

```ts
// vitest is an optional peer dependency - run the kit inside your own suite
import { contractSuite, securitySuite, HOSTILE_PATHS } from '@agentage/memory-core/conformance';

contractSuite({ name: 'my-store', make: () => createMyStore() });
securitySuite({ name: 'my-store', make: () => createMyStore() });
// HOSTILE_PATHS / RESTRICTED_BODIES / BENIGN_BODIES: fire the same corpus at your HTTP/MCP edge
```

## Test layout & CI

```
test/
├── unit/          contract helpers + fuzzing (property oracles, memory-vs-git differential)
├── container/     access matrix, containment, lifecycle (no-provision + tombstone proofs)
├── stores/        conformance + security per implementation
├── integration/   consumer showcases + e2e lifecycle
└── perf/          non-functional gate - budgets asserted AND printed to the CI job summary
```

CI tiers: **PR** = full verify incl. perf @1000 notes (merge-blocking, `verify` is a required check) · **nightly** = perf @5000 + deep fuzz (500 property runs / 25 differential sequences).

## Develop

```bash
npm install
npm run verify   # type-check + lint + format:check + coverage + build + dist smoke
```
