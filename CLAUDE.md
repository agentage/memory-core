# CLAUDE.md - @agentage/memory-core

## Identity

This repo grew up as **`store-core`** and was renamed to `memory-core`; it publishes
**`@agentage/memory-core`** (public npm, MIT, `node-lib`). `1.0.0` took over the package name from a
different `0.5.x` engine - no upgrade path, different API. That old engine repo is archived as
`agentage/archive_memory-core`; do not port code from it.

Consumers: `@agentage/server-memory` (stdio MCP), `@agentage/cli`, `web`'s `memory-mcp`. A contract
change here is a fan-out - rebuild and check all three.

## Architecture

Four layers, each usable alone: **Router** (`@vault/path` refs, permission fail-fast) ->
**Container** (`Access`-gated vault lifecycle over `<root>/<userId>/<vault>.git`, `ObjectCache` holds
one live store per vault) -> **VaultStore** (the frozen contract + always-on guards) -> **bare git**
(one repo per vault, every write a commit, `git grep` is the index). Details: README.

## Commands

```bash
npm install
npm run verify        # type-check + lint + format:check + coverage + build + dist smoke
npm run test          # vitest run
npm run build         # tsc -p tsconfig.build.json
```

CI: PR = full `verify` incl. perf @1000 notes. Nightly = perf @5000 + deep fuzz.

## Documented >200-line exemptions

House rule is files < 200 lines (`~/vaults/projects/standards/code-style.md`). These four are deliberate:

- `src/conformance/contract-suite.ts` (349) - one shipped spec; splitting it splits the guarantee.
- `src/stores/bare-git/bare-git-store.ts` (271) - the reference store; its 8 verbs share one
  snapshot/commit closure that costs more to thread across files than to read in one.
- `src/stores/bare-git/git-run.ts` (213) - the whole hermetic-spawn boundary (env voiding, timeouts,
  byte caps, `unavailable` mapping) in one auditable place.
- `src/stores/memory-store.ts` (202) - the reference implementation, kept a mirror of the contract's
  own ordering so a reader can diff the two by eye.

## Rules

- **Contracts stay simple - consumers adapt.** No auth, tenancy policy or protocol rendering in here;
  `ResolveAccess` is a type, never an implementation.
- **Every ref is `@vault/path`** at the router - no default vault, no single-vault special case, and
  every emitted path round-trips as an input.
- **Hermetic git env.** Spawns get `PATH` only, no `HOME`, global+system gitconfig voided. Never let a
  host's `~/.gitconfig` reach the engine; commit identity comes from the call.
- **Conformance-first PRs.** A behavior change lands in the conformance kit first; both stores must
  pass unchanged suites, and a `null`/`[]`/`false` may only ever mean not-found - infra failure throws
  `StoreError('unavailable')`.
- Worktrees only (`~/.worktrees/memory-core/<slug>`), never edit on master. Publishing is
  GitHub Actions only.
