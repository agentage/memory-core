# @agentage/store-core

The storage foundation for agentage Memory: one storage-agnostic **vault store contract** ("markdown docs addressed by path, opaquely versioned") plus swappable implementations. One instance = one vault. Multi-tenancy, auth, and protocol rendering live in the consumers - never here.

North star spec: `vaults/agentage/specs/north-star-store-core.md`.

## Install

```bash
npm install @agentage/store-core
```

MIT licensed, published to public npm. Requires **Node >=22**.

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
import { createDerivedCache, createStatsView } from '@agentage/store-core';
const cache = createDerivedCache(store, '/data/repos/alice01/main.cache');
const stats = await cache.get(createStatsView('/data/repos/alice01/main.git')); // { files, folders, sizeBytes }
```

### Swap the store, keep the contract

```ts
import { createMemoryStore } from '@agentage/store-core';

createMemoryStore(); // dev/test fixture - the reference implementation
```

| Store                | World                 | Search                           |
| -------------------- | --------------------- | -------------------------------- |
| `createMemoryStore`  | tests/dev             | in-process scan (reference impl) |
| `createBareGitStore` | server (multi-tenant) | `git grep` HEAD                  |

Both pass the same conformance kit, so a consumer written against one runs unchanged on the other. Stores for other worlds (local working copy, FTS-indexed, HTTP client/server) are out of scope for now - they lived here through `v0.1.0` and are recoverable from git history.

## Consumer templates (start here when integrating)

- **MCP tool layer** (memory-mcp shape - token ctx, `@vault/` routing, isError results): `test/integration/mcp-tools.showcase.test.ts`
- **/v1 REST handlers** (resource JSON, `{error:{code,message}}` envelope, derived stats; `/notes` = the memory__list shape, cursor-drainable on opt-in): `test/integration/rest-api.showcase.test.ts`
- **Full lifecycle on one vault** (push -> events -> derived state -> restart): `test/integration/e2e-lifecycle.test.ts`

## Conformance

Every implementation must pass the shared kit - a store that passes is guaranteed swappable:

```ts
// vitest is an optional peer dependency - run the kit inside your own suite
import { contractSuite, securitySuite, HOSTILE_PATHS } from '@agentage/store-core/conformance';

contractSuite({ name: 'my-store', make: () => createMyStore() });
securitySuite({ name: 'my-store', make: () => createMyStore() });
// HOSTILE_PATHS / RESTRICTED_BODIES / BENIGN_BODIES: fire the same corpus at your HTTP/MCP edge
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
