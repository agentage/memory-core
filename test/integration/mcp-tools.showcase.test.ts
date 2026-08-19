// SHOWCASE: how an MCP service (memory-mcp) wires the 6 memory__* tools onto
// VaultStore. This is the intended consumer shape: auth resolves a Principal
// into an Access ONCE per request, the container turns (access, vault) into a
// store, @vault/ prefixes route between a user's vaults, every tool is route ->
// verb -> render, and errors become isError tool results. The tool layer only
// ever sees the contract, so swapping the store factory changes nothing above
// this line - and it holds NO create/delete rights, so no tool can ever
// provision or destroy a vault.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createVaultContainer,
  ensureBareRepo,
  ObjectCache,
  type Access,
  type ResolveAccess,
  type VaultStore,
  type WriteAuthor,
} from '../../src/index.js';

// ---- the consumer template ----

interface ToolCtx {
  access: Access; // resolved from the OAuth token - NEVER a client-supplied param
  defaultVault: string;
  client: WriteAuthor; // connected-client attribution
}

interface ToolResult {
  isError?: true;
  text: string;
  structured?: unknown;
}

// Policy lives in the host: claims in, decision out. The MCP surface reads and
// writes docs; provisioning a vault is a dashboard/admin verb.
const resolveAccess: ResolveAccess = async (p) => ({
  userId: p.userId,
  vaults: new Set(p.vaults ?? ['main']),
  canCreate: false,
  canDelete: false,
});

const createMemoryTools = (reposRoot: string) => {
  const container = createVaultContainer({
    root: reposRoot, // layout is the container's: <root>/<userId>/<vault>.git
    store: (dir) => createBareGitStore(dir),
    provision: ensureBareRepo,
    cache: new ObjectCache<VaultStore>({ max: 64 }),
  });

  const route = async (
    ctx: ToolCtx,
    path: string
  ): Promise<{ store: VaultStore; rest: string }> => {
    const m = /^@([^/]+)\/(.+)$/.exec(path);
    if (!m) return { store: await container.open(ctx.access, ctx.defaultVault), rest: path };
    return { store: await container.open(ctx.access, m[1]!), rest: m[2]! };
  };

  const guard = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      return { isError: true, text: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    container,
    memory__write: (
      ctx: ToolCtx,
      args: { path: string; body: string; frontmatter?: Record<string, unknown> }
    ) =>
      guard(async () => {
        const { store, rest } = await route(ctx, args.path);
        const r = await store.write({ ...args, path: rest }, ctx.client);
        return { text: `Saved ${r.path}`, structured: { path: r.path, updated: r.updated } };
      }),
    memory__search: (ctx: ToolCtx, args: { query: string; limit: number }) =>
      guard(async () => {
        const { store } = await route(ctx, 'x'); // search runs on the routed default vault
        const res = await store.search(args);
        return { text: `${res.results.length} results`, structured: res };
      }),
    memory__read: (ctx: ToolCtx, args: { path: string }) =>
      guard(async () => {
        const { store, rest } = await route(ctx, args.path);
        const view = await store.read(rest);
        if (!view) return { isError: true, text: `not found: ${args.path}` };
        return { text: view.body, structured: view };
      }),
    memory__list: (ctx: ToolCtx, args: { folder?: string }) =>
      guard(async () => {
        const { store } = await route(ctx, 'x');
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
        const { store, rest } = await route(ctx, args.path);
        const r = await store.edit({ ...args, path: rest }, ctx.client);
        if (!r) return { isError: true, text: `not found: ${args.path}` };
        return { text: `Edited ${r.path}`, structured: { path: r.path, updated: r.updated } };
      }),
    memory__delete: (ctx: ToolCtx, args: { path: string }) =>
      guard(async () => {
        const { store, rest } = await route(ctx, args.path);
        const gone = await store.delete(rest);
        return gone
          ? { text: `Deleted ${args.path}` }
          : { isError: true, text: `not found: ${args.path}` };
      }),
  };
};

// ---- the proof ----

describe('mcp showcase over the bare store', () => {
  let tools: ReturnType<typeof createMemoryTools>;
  let alice: ToolCtx;
  let bob: ToolCtx;
  const client: WriteAuthor = { id: 'claude-desktop', name: 'Claude' };

  beforeEach(async () => {
    tools = createMemoryTools(await mkdtemp(join(tmpdir(), 'mcp-showcase-')));
    alice = {
      access: await resolveAccess({ userId: 'alice01', vaults: ['main', 'work'] }),
      defaultVault: 'main',
      client,
    };
    bob = { access: await resolveAccess({ userId: 'bob02' }), defaultVault: 'main', client };
    // Provisioning is a separate, privileged verb - here, the signup path.
    const admin = (ctx: ToolCtx): Access => ({ ...ctx.access, canCreate: true });
    for (const v of ['main', 'work']) await tools.container.create(admin(alice), v);
    await tools.container.create(admin(bob), 'main');
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
    expect(denied).toMatchObject({ isError: true, text: 'no access to vault: secret' });
  });

  it('a granted-but-unprovisioned vault is unknown, and no tool ever creates it', async () => {
    const withNotes = {
      ...alice,
      access: { ...alice.access, vaults: new Set(['main', 'work', 'notes']) },
    };
    const miss = await tools.memory__write(withNotes, { path: '@notes/x.md', body: 'x' });
    expect(miss).toMatchObject({ isError: true, text: 'unknown vault: notes' });
    expect(await tools.container.list(withNotes.access)).toEqual(['main', 'work']);
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

  it('the tool surface can neither provision nor destroy a vault', async () => {
    await expect(tools.container.create(alice.access, 'brand-new')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(tools.container.remove(alice.access, 'work', 's1')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await tools.container.list(alice.access)).toEqual(['main', 'work']);
  });
});
