// SHOWCASE: how an MCP service (memory-mcp) wires the 6 memory__* tools onto
// VaultStore. This is the intended consumer shape: auth resolves the context,
// @vault/ prefixes route between a user's vaults, every tool is route -> verb ->
// render, and errors become isError tool results. Swapping the store factory
// (bare <-> indexed) changes search behavior and nothing else - both run below.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createIndexedGitStore,
  createStorePool,
  parseMemoryId,
  type VaultStore,
  type WriteAuthor,
} from '../../src/index.js';

// ---- the consumer template ----

interface ToolCtx {
  userId: string; // OAuth sub - NEVER a client-supplied param
  defaultVault: string;
  vaults: string[]; // vault claim from the token
  client: WriteAuthor; // connected-client attribution
}

interface ToolResult {
  isError?: true;
  text: string;
  structured?: unknown;
}

const createMemoryTools = (reposRoot: string, indexed: boolean) => {
  // Keys are opaque to the pool; the HOST owns layout + tenant semantics here.
  const pool = createStorePool({
    create: (memoryId) => {
      const { userId, vault } = parseMemoryId(memoryId); // allowlists both segments
      const repo = join(reposRoot, userId, `${vault}.git`);
      return indexed
        ? createIndexedGitStore(repo, join(reposRoot, userId, `${vault}.index`))
        : createBareGitStore(repo);
    },
  });
  const storeFor = (memoryId: string): VaultStore => pool.get(memoryId);

  const route = (ctx: ToolCtx, path: string): { store: VaultStore; rest: string } => {
    const m = /^@([^/]+)\/(.+)$/.exec(path);
    if (!m) return { store: storeFor(`${ctx.userId}/${ctx.defaultVault}`), rest: path };
    if (!ctx.vaults.includes(m[1]!)) throw new Error(`unknown vault: @${m[1]}`);
    return { store: storeFor(`${ctx.userId}/${m[1]}`), rest: m[2]! };
  };

  const guard = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return { isError: true, text: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    memory__write: (
      ctx: ToolCtx,
      args: { path: string; body: string; frontmatter?: Record<string, unknown> }
    ) =>
      guard(async () => {
        const { store, rest } = route(ctx, args.path);
        const r = await store.write({ ...args, path: rest }, ctx.client);
        return { text: `Saved ${r.path}`, structured: { path: r.path, updated: r.updated } };
      }),
    memory__search: (ctx: ToolCtx, args: { query: string; limit: number }) =>
      guard(async () => {
        const { store } = route(ctx, 'x'); // search runs on the routed default vault
        const res = await store.search(args);
        return { text: `${res.results.length} results`, structured: res };
      }),
    memory__read: (ctx: ToolCtx, args: { path: string }) =>
      guard(async () => {
        const { store, rest } = route(ctx, args.path);
        const view = await store.read(rest);
        if (!view) return { isError: true, text: `not found: ${args.path}` };
        return { text: view.body, structured: view };
      }),
    memory__list: (ctx: ToolCtx, args: { folder?: string }) =>
      guard(async () => {
        const { store } = route(ctx, 'x');
        const res = await store.list(args);
        return { text: `${res.files} files`, structured: res };
      }),
    memory__edit: (
      ctx: ToolCtx,
      args: {
        path: string;
        mode: 'replace' | 'append' | 'str_replace';
        body?: string;
        old_str?: string;
        new_str?: string;
      }
    ) =>
      guard(async () => {
        const { store, rest } = route(ctx, args.path);
        const r = await store.edit({ ...args, path: rest }, ctx.client);
        if (!r) return { isError: true, text: `not found: ${args.path}` };
        return { text: `Edited ${r.path}`, structured: { path: r.path, updated: r.updated } };
      }),
    memory__delete: (ctx: ToolCtx, args: { path: string }) =>
      guard(async () => {
        const { store, rest } = route(ctx, args.path);
        const gone = await store.delete(rest);
        return gone
          ? { text: `Deleted ${args.path}` }
          : { isError: true, text: `not found: ${args.path}` };
      }),
  };
};

// ---- the proof ----

describe.each([
  { name: 'bare store', indexed: false },
  { name: 'indexed store (search swapped, tools untouched)', indexed: true },
])('mcp showcase over the $name', ({ indexed }) => {
  let tools: ReturnType<typeof createMemoryTools>;
  const alice: ToolCtx = {
    userId: 'alice01',
    defaultVault: 'main',
    vaults: ['main', 'work'],
    client: { id: 'claude-desktop', name: 'Claude' },
  };
  const bob: ToolCtx = { ...alice, userId: 'bob02', vaults: ['main'] };

  beforeEach(async () => {
    tools = createMemoryTools(await mkdtemp(join(tmpdir(), 'mcp-showcase-')), indexed);
  });

  it('write -> search -> read round-trip through the tool layer', async () => {
    await tools.memory__write(alice, { path: 'inbox/idea.md', body: 'a quiet zebra #inbox' });
    const found = await tools.memory__search(alice, { query: 'zebra', limit: 10 });
    expect(found.structured).toMatchObject({ results: [{ path: 'inbox/idea.md', score: 1 }] });
    const read = await tools.memory__read(alice, { path: 'inbox/idea.md' });
    expect(read.text).toBe('a quiet zebra #inbox');
  });

  it('@vault/ prefix routes between the user vaults; unknown vault is refused', async () => {
    await tools.memory__write(alice, { path: '@work/plan.md', body: 'work only' });
    expect((await tools.memory__read(alice, { path: '@work/plan.md' })).text).toBe('work only');
    expect((await tools.memory__read(alice, { path: 'plan.md' })).isError).toBe(true); // not in main
    const denied = await tools.memory__write(alice, { path: '@secret/x.md', body: 'x' });
    expect(denied).toMatchObject({ isError: true, text: 'unknown vault: @secret' });
  });

  it('tenants are isolated: same path, different users, different content', async () => {
    await tools.memory__write(alice, { path: 'me.md', body: 'alice notes' });
    await tools.memory__write(bob, { path: 'me.md', body: 'bob notes' });
    expect((await tools.memory__read(alice, { path: 'me.md' })).text).toBe('alice notes');
    expect((await tools.memory__read(bob, { path: 'me.md' })).text).toBe('bob notes');
  });

  it('restricted content and str_replace errors surface as canonical isError results', async () => {
    const refused = await tools.memory__write(alice, {
      path: 'k.md',
      body: `api_key: sk-${'a'.repeat(24)}`,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: this appears to contain an API key/);
    await tools.memory__write(alice, { path: 'n.md', body: 'alpha' });
    const miss = await tools.memory__edit(alice, {
      path: 'n.md',
      mode: 'str_replace',
      old_str: 'zzz',
      new_str: 'y',
    });
    expect(miss.text).toMatch(/No replacement was performed/);
  });
});
