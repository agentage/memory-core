# @agentage/memory-core — CLAUDE.md

Transport-agnostic **engine** for agentage Memory. No MCP, no HTTP — just config,
vaults, storage backends, and federation. Everything else (server-memory, cli,
web/memory-mcp) builds on this. Change it carefully: it's the foundation.

## Layout (src/)
- `contract/` — data types + `memory-doc` helpers (serialize/parse/tags/snippet). The wire shapes.
- `backends/` — `VaultBackend` interface (the ONE extension seam) + `local-backend` (git working copy), `remote-backend`, `git`, `tree`.
- `config/` — load + validate `~/.agentage/vaults.json`.
- `registry/` — one backend per vault, surfaced by scope.
- `router/` — federation: `@vault/` addressing + multi-vault fan-out.
- `setup/init` — offline scaffold of `~/.agentage` + starter vault.

## Rules
- New storage capability = a new **backend behind `VaultBackend`**, never new public surface.
- A local vault is a plain markdown folder under git: reads/search hit the working tree (editor edits are instantly visible); every write is a commit; delete is recoverable.
- Public API is the named exports from `src/index.ts` only. Keep it minimal.

## Verify
`npm run verify` (type-check + lint + format:check + test + build). Node 22+, ESM, strict TS, Vitest.

## Downstream (rebuild + check on any contract change)
`@agentage/server-memory` · `@agentage/cli` · `web/@agentage/memory-mcp`. The 6-tool
`memory__*` contract these expose is frozen — verify against a live `tools/list`.
