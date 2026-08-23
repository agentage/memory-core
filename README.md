# @agentage/memory-core

[![npm](https://img.shields.io/npm/v/@agentage/memory-core.svg)](https://www.npmjs.com/package/@agentage/memory-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/agentage/memory-core/ci.yml?branch=master&label=CI)](https://github.com/agentage/memory-core/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a.svg)](https://nodejs.org)
[![agentage.io](https://img.shields.io/badge/by-agentage.io-e0a234.svg)](https://agentage.io)

Give your AI a memory it can read, write and search - stored as plain markdown files you own.

## What is this?

AI apps forget everything between chats. [agentage Memory](https://agentage.io) fixes that with
**one markdown memory every AI can read and write** - Claude, Cursor, ChatGPT - kept as ordinary
`.md` files in a git repository you can clone, grep and export at any time.

This package is the engine underneath. It turns a folder of markdown into a small, boring API -
`read`, `write`, `edit`, `delete`, `search`, `list` - with the awkward parts already solved: path
safety, secret refusal, size caps, snippets and ranking, cursor paging, change events, and a
version token that only moves when content moves. Every write is a git commit, so nothing is ever
silently lost.

Use it when you are building the thing that talks to a memory rather than using one:

- an **MCP server** - [`@agentage/server-memory`](https://github.com/agentage/server-memory) is
  exactly this engine behind the frozen 6 `memory__*` tools
- an **agent or app** that needs durable, greppable notes instead of a vector blob
- a **multi-tenant service** - the container and router layers add per-user vault isolation

Want the product, not the library? Start at [agentage.io](https://agentage.io).

## Install

```bash
npm install @agentage/memory-core
```

MIT licensed, published to public npm. Requires **Node >=22** and `git` on `PATH` for the git store.

## Quickstart

```ts
import { createBareGitStore } from '@agentage/memory-core';

const store = createBareGitStore('/data/repos/alice01/main.git'); // one instance = one vault

await store.write(
  { path: 'inbox/idea.md', body: 'A quiet zebra #inbox' },
  { id: 'claude-desktop', name: 'Claude' }
);
const hits = await store.search({ query: 'zebra', limit: 10 }); // { results: [{ path, title, snippet, score, updated }], nextCursor? }
const view = await store.read('inbox/idea.md'); // MemoryView | null - { path, title, frontmatter, body, tags, updated, deleted, sizeBytes? }
await store.edit({ path: 'inbox/idea.md', mode: 'str_replace', old_str: 'quiet', new_str: 'loud' });
await store.delete('inbox/idea.md'); // recoverable - git history keeps it
await store.describe(); // { files, folders, sizeBytes, updated, version } - the vault card
await store.authors(); // [{ author, writes, lastAt }] - which AIs write here, busiest first
```

Every write is a git commit with client attribution; guards are always on (path safety incl.
`.git`/`.agentage` reservation, secrets/PII refusal, 8MB doc cap, 64KB read clamp).

The engine is hermetic: every git spawn gets a minimal explicit environment (`PATH` only, no
`HOME`, global+system gitconfig voided), so a host's `~/.gitconfig` - identity, `core.autocrlf`,
`core.hooksPath`, proxies - can never change engine behavior. Commit identity comes from the call,
not the machine.

## The contract

`VaultStore` is the whole surface. One instance = one vault; every store implements the same shape,
so a consumer written against one runs unchanged on another.

| Verb                     | Returns                  | What it does                                                              |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| `read(path, opts?)`      | `MemoryView \| null`     | One doc: body, frontmatter, tags, title. Clamped to 64KB unless opted out |
| `readMany(paths, opts?)` | `(MemoryView \| null)[]` | Those same reads in ONE round trip: same order, a `null` per miss         |
| `write(input, author?)`  | `WriteResult`            | Create or replace a doc; one git commit, attributed to the client         |
| `edit(input, author?)`   | `WriteResult \| null`    | `replace` / `append` / `str_replace` on an existing doc; `null` = absent  |
| `delete(path)`           | `boolean`                | Remove a doc; recoverable from history. `false` = it was not there        |
| `search(query)`          | `SearchResult`           | Ranked hits with snippets, `{ results, nextCursor? }`, cap 50 per page    |
| `list(query)`            | `ListResult`             | Bounded folder tree with truncation + cursor paging                       |
| `refresh()`              | `StoreEvent[]`           | Pick up out-of-band changes (a `git push`, a human edit) as events        |
| `subscribe(observer)`    | `() => void`             | Fire-and-forget change events; returns the unsubscribe                    |
| `describe()`             | `VaultDescription`       | Cheap vault card: `{ files, folders, sizeBytes, updated, version }`       |
| `authors()`              | `AuthorStat[]`           | Who has written here: one row per attributed client, busiest first        |
| `version()`              | `string \| null`         | Opaque change token; changes iff content changed, `null` = empty vault    |
| `capabilities()`         | `StoreCapabilities`      | What this store can do: mutable, versioned, externallyMutable, search     |

Guards are part of the contract, not of one implementation: refusals come back as a `StoreError`
with a stable code - `invalid_path`, `restricted`, `unknown_vault`, `forbidden`, `unavailable`.
A `null` / `[]` / `false` answer always means definitively-not-found; infrastructure failure throws
`unavailable` instead of a degraded answer.

```ts
// One page of a folder listing, enriched - one git process, not one per file
const views = await store.readMany(paths); // (MemoryView | null)[], aligned to `paths`
await router.readMany(['@main/a.md', '@work/b.md']); // refs may span vaults
```

`readMany` is the bulk shape of `read` and nothing else: element-for-element the same answer the
individual reads would give (same order, `null` in place of every miss, same clamp), and an
infrastructure failure still throws for the whole call rather than degrading one element to a
`null`. At the router, a ref it would refuse (`invalid_path`, `forbidden`, `unknown_vault`) refuses
the batch, before any IO.

### Who wrote here

```ts
await store.write({ path: 'a.md', body: 'x' }, { id: 'claude-desktop', name: 'Claude' });
await store.authors(); // [{ author: { id: 'claude-desktop', name: 'Claude' }, writes: 1, lastAt }]
```

`authors()` is the read-only view of the attribution `write` and `edit` already record - the same
history, aggregated. There is no second bookkeeping: the bare store stamps the client as the git
**author** (the committer stays the system identity), so `authors()` is one `git log` pass and a
restored clone answers exactly like the store that wrote it.

The contract is deliberately narrow, because everything else is product policy:

- **Attributed changes only.** A write with no author, a `delete`, and a commit that arrived out of
  band (a `git push` from a person) carry no client and appear in no row.
- **A change is what the store recorded.** A no-op write makes no commit, so it counts for nobody.
- **Order is pinned**: `writes` descending, then `author.id` ascending - a total order that never
  reads a clock, so two stores holding the same history agree. Sort by recency yourself if that is
  the view you want.
- `lastAt` is a strict ISO 8601 instant at second precision. What counts as "recently active", how
  a client is labelled or badged, and which clients to show belong to the host.
- `writes` and `lastAt` cover the history the store **retains**: every commit for the bare store,
  what the instance has seen for the in-memory one (`capabilities().versioned` tells you which).

### What a verb costs (bare git store)

Cost here is git processes. The budget below is asserted by the conformance kit (via the target's
optional round-trip counter) and by the store's own spawn-budget test - "warm" means the
version-keyed snapshot is already built:

| Verb                           | Warm spawns | How                                                             |
| ------------------------------ | ----------- | --------------------------------------------------------------- |
| `version()`, quiet `refresh()` | 0           | the ref is read as a file, never through git                    |
| `list()`                       | 0           | served from the snapshot (+1 `cat-file --batch` to filter tags) |
| `read(path)`                   | 1           | `cat-file --batch`                                              |
| `readMany(paths)`              | 1           | one `cat-file --batch`, whatever N is                           |
| `search(query)`                | 2           | `grep`, then one batch for the page it decided                  |
| `describe()`                   | 0           | computed once per version (`ls-tree -l`, `log -1`), then cached |
| `authors()`                    | 0           | one `git log` pass per version, then cached like the card       |
| `write` / `edit` / `delete`    | 6-7         | blob, tree build, `commit-tree`, compare-and-swap ref update    |
| `container.bundle(vault)`      | 1           | one `git bundle create - --all` - the whole history, streamed   |
| first query on a cold store    | +2          | the once-per-version snapshot build (`ls-tree`, `log`)          |
| a push landing (drift)         | 3           | the diff, an ancestry check, and a log of the range only        |

The snapshot is version-keyed and kept fresh by patches - own writes update it for free, and an
incoming push is applied from the diff the drift check already paid for. Only a force-push or a
change git cannot attribute to a commit costs a fresh walk of history.

## Layers

```text
caller  (MCP tool layer, /v1 REST handlers, sync)
  |     every ref is @vault/path
  v
Router      permission fail-fast: the ref's vault is checked against Access BEFORE any
  |         container call; every path it emits comes back as @vault/path
  v
Container   Access-gated lifecycle over <root>/<userId>/<vault>.git - list/create/open/
  |         remove/bundle/destroyUser, plus the root's own facts (checkRoot) and the
  |         layout helpers; open never provisions; an ObjectCache holds one live store
  |         instance per vault (LRU by object count, dispose on evict)
  v
VaultStore  the frozen contract - read/write/edit/delete/search/list/describe + events;
  |         guards always on (path safety, restricted data, size caps, read clamp)
  v
bare git    one bare repo per vault - every write is a commit, `git grep` is the index
```

Each layer stands alone: a single-vault consumer can hold a `VaultStore` directly, the container
works without the router, and the router is a pure binding cheap enough to rebuild per request.

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
import { ObjectCache, type VaultStore } from '@agentage/memory-core';

// build ONE per process - bounded by object COUNT (not bytes), LRU by last use
const stores = new ObjectCache<VaultStore>({ max: 256, dispose: (s, key) => detach(s, key) });
stores.get(key, () => createBareGitStore(pathFor(key))); // same key = same instance
```

Type-agnostic by construction (it never imports an engine type), so the same class caches stores,
parsed configs, watchers - anything rebuildable. `dispose` is best-effort cleanup on
eviction/`delete`, never a correctness hook.

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
await container.bundle(access, 'work'); // Buffer | null - clone-able git bundle, history included
await container.destroyUser(access, userId); // account erasure: own user + canDelete, tombstones too
```

`Access` (`{ userId, vaults: Set | '*', canCreate, canDelete }`) is the only authority the container
reads: the host decides who may touch which vault - `ResolveAccess` is a **type** here, policy never
enters the engine - and the container enforces that decision against storage facts. It never reads
the clock (deletion stamps are supplied by the caller), never provisions on a read path, and never
configures the cache: the composition root builds the `ObjectCache` with its own `dispose`, because
whoever creates subscriptions owns tearing them down. Refusals are coded: `invalid_path` (hostile id
or stamp), `forbidden` (outside the grant, or missing canCreate/canDelete), `unknown_vault` (not
provisioned).

`bundle` is the export path: gated exactly like `open`, `null` when there is nothing to export (no
repo yet, no commits yet, or a tombstoned name) - so an absent vault of another account never reads
differently from an empty one of your own. `destroyUser` is the account erasure, the one verb keyed
by user rather than vault: it refuses any `userId` but `access.userId` (`forbidden`, whether or not
that account exists), needs `canDelete`, disposes every live object it wipes, and takes the
tombstones with it. There is no stamp - `remove` tombstones, `destroyUser` erases.

### The root itself - health, layout

Above one vault sits the root, and a host should not have to open `node:fs` to reason about it:

```ts
import {
  checkRoot,
  vaultRepoDir,
  userDir,
  tombstoneRepoDir,
  REPO_SUFFIX,
} from '@agentage/memory-core';

// facts, never exceptions - a vanished root is all-false + zeros, not a throw
const facts = await checkRoot('/data/repos', { markerFile: '.volume-ok' });
// { reachable, writable, markerPresent: boolean | null, diskFreeBytes, diskTotalBytes }

vaultRepoDir('/data/repos', 'alice01', 'main'); // /data/repos/alice01/main.git
userDir('/data/repos', 'alice01'); // /data/repos/alice01
tombstoneRepoDir('/data/repos', 'alice01', 'main', stamp); // ...main.deleted-<stamp>.git
```

`checkRoot` is cheap by default - `access(R_OK|W_OK)`, because health endpoints poll forever. Pass
`probeWrite: true` for the honest test (write + unlink) when the bits can lie: a full disk or a
read-only remount still reports `writable` permission. `markerFile` catches the writable-but-WRONG
volume, and is `null` (not `false`) when no marker was asked for. `checkRootWritable(dir)` stays as
it was - the same two booleans, write-probing, now a projection of the fact set.

The layout helpers are the same ones the container computes with: every segment goes through the
allowlist, so a hostile name throws `invalid_path` instead of returning a path (there is no way to
get a path out of a name that was never safe). Stamps allow dots and colons - timestamps - but never
a separator.

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

**One input rule:** a ref is always `@vault/path`. Anything without the prefix is `invalid_path` -
there is no default vault and no single-vault special case, so a caller that wants a default resolves
it itself. **One output rule:** every path the router emits - `view.path`, write/edit results, search
hits, list entries and folders - comes back as `@vault/path`, so every output round-trips as an input.
The two unscoped shapes are the discovery ones: `list({})` is the vault directory, `search({ query })`
fans out across every granted vault and merges the per-vault pages into the contract's total order
(score desc, recency desc, path asc) before re-paging.

**Router = permission check + routing to the corresponding vault instance. No default vault.** It is
the responsible layer for permission: the ref's vault is checked against `Access` BEFORE any container
call, so an ungranted vault is refused with `forbidden` and zero container interaction (the container's
own gate stays the last line of defense). Everything else stays where it belongs - guards, ranking and
paging in the store, provisioning in the container - and their refusals pass through untouched
(`restricted`, `invalid_path`, `unavailable`). The one refusal the router owns is `unknown_vault` for
a granted-but-unprovisioned `@vault`: its message text is a frozen client contract, exported as
`unknownVaultMessage`. What it asks for is the lifecycle subset, `RoutedContainer` (`list` / `open` /
`create` / `remove`): export and account erasure are not routing concerns, so a container verb can be
added without widening what a router - or a stand-in for one - has to provide.

Strip the tags off a response and what is left is byte-for-byte what calling the store directly
returns - same values, same cursors, same events.

### Swap the store, keep the contract

```ts
import { createMemoryStore } from '@agentage/memory-core';

createMemoryStore(); // dev/test fixture - the reference implementation
```

| Store                | World                 | Search                           |
| -------------------- | --------------------- | -------------------------------- |
| `createMemoryStore`  | tests/dev             | in-process scan (reference impl) |
| `createBareGitStore` | server (multi-tenant) | `git grep` HEAD                  |

Both pass the same conformance kit, so a consumer written against one runs unchanged on the other.
Stores for other worlds (local working copy, FTS-indexed, HTTP client/server) are out of scope for
now - they were cut before `1.0.0` and are recoverable from git history.

## Consumer templates (start here when integrating)

Working, executed examples - each is a test in this repo, so they can never drift from the API:

- **MCP tool layer** (memory-mcp shape - token ctx, `@vault/` routing, isError results):
  [`test/integration/mcp-tools.showcase.test.ts`](https://github.com/agentage/memory-core/blob/master/test/integration/mcp-tools.showcase.test.ts)
- **/v1 REST handlers** (resource JSON, `{error:{code,message}}` envelope, derived stats; `/notes` =
  the memory\_\_list shape, cursor-drainable on opt-in):
  [`test/integration/rest-api.showcase.test.ts`](https://github.com/agentage/memory-core/blob/master/test/integration/rest-api.showcase.test.ts)
- **Full lifecycle on one vault** (push -> events -> derived state -> restart):
  [`test/integration/e2e-lifecycle.test.ts`](https://github.com/agentage/memory-core/blob/master/test/integration/e2e-lifecycle.test.ts)

## Conformance

Every implementation must pass the shared kit - a store that passes is guaranteed swappable:

```ts
// vitest is an optional peer dependency - run the kit inside your own suite
import { contractSuite, securitySuite, HOSTILE_PATHS } from '@agentage/memory-core/conformance';

contractSuite({ name: 'my-store', make: () => createMyStore() });
securitySuite({ name: 'my-store', make: () => createMyStore() });
// HOSTILE_PATHS / RESTRICTED_BODIES / BENIGN_BODIES: fire the same corpus at your HTTP/MCP edge
```

The suites live in
[`src/conformance/`](https://github.com/agentage/memory-core/tree/master/src/conformance) and are
shipped as a subpath export, not as a dev-only fixture.

## Test layout & CI

The [`test/`](https://github.com/agentage/memory-core/tree/master/test) tree:

```
test/
├── unit/          contract helpers + fuzzing (property oracles, memory-vs-git differential)
├── container/     access matrix, containment, lifecycle (no-provision + tombstone proofs)
├── stores/        conformance + security per implementation
├── integration/   consumer showcases + e2e lifecycle
└── perf/          non-functional gate - budgets asserted AND printed to the CI job summary
```

CI tiers: **PR** = full verify incl. perf @1000 notes / 4000 commits (merge-blocking, `verify` is a
required check) · **nightly** = perf @5000 notes / 20000 commits + deep fuzz (500 property runs /
25 differential sequences). The perf gate has two axes because the engine has two: note count sets
the cost of listing and searching, commit count sets the cost of building a snapshot.

## Develop

```bash
npm install
npm run verify   # type-check + lint + format:check + coverage + build + dist smoke
```

## Release

Releases publish to npm via GitHub Actions when a version bump lands on `master` (the squash-merge
of a release PR), or by dispatching the workflow by hand. The workflow skips any version already on
npm and publishes with npm provenance. No one publishes from a laptop.

## Security

Path traversal, reserved namespaces, secret/PII persistence and storage abuse are contract-level
controls enforced by the conformance kit - see [SECURITY.md](./SECURITY.md). Report vulnerabilities
privately via GitHub Security Advisories, never a public issue.

## Links

- [agentage.io](https://agentage.io) - the product this engine powers
- [`@agentage/server-memory`](https://www.npmjs.com/package/@agentage/server-memory) - the stdio MCP
  server built on it ([source](https://github.com/agentage/server-memory))
- [github.com/agentage/memory-core](https://github.com/agentage/memory-core) - source, issues,
  releases

## License

MIT - see [LICENSE](./LICENSE).
