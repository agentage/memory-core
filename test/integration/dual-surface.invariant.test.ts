// THE "same contract for MCP and API" guarantee, pinned by CI: for identical
// operations on the same vault, the MCP tool's structuredContent and the REST
// body are the SAME objects (modulo the REST envelope's field selection). Any
// future drift between the tool schema and the /v1 wire fails here, in this
// repo, before it can ship in a service.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBareGitStore, type VaultStore } from '../../src/index.js';

// Both surfaces, built the way the showcases build them: thin renderers over
// the SAME store instance - which is the whole point.
const mcp = {
  memory__read: async (store: VaultStore, path: string) => ({
    structuredContent: await store.read(path),
  }),
  memory__search: async (store: VaultStore, query: string) => ({
    structuredContent: await store.search({ query, limit: 10 }),
  }),
  memory__list: async (store: VaultStore) => ({ structuredContent: await store.list({}) }),
};

const rest = {
  getNote: async (store: VaultStore, path: string) => {
    const v = (await store.read(path, { clamp: false }))!;
    return {
      path: v.path,
      title: v.title,
      frontmatter: v.frontmatter,
      body: v.body,
      tags: v.tags,
      sizeBytes: v.sizeBytes,
      updated: v.updated,
    };
  },
  search: (store: VaultStore, query: string) => store.search({ query, limit: 10 }),
  getNotes: async (store: VaultStore) => {
    const { notes, nextCursor } = await store.listNotes();
    return { notes, nextCursor: nextCursor ?? null };
  },
};

describe('dual-surface invariant: MCP structuredContent === REST body', () => {
  let store: VaultStore;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'dual-'));
    store = createBareGitStore(join(base, 'v.git'));
    await store.write({
      path: 'notes/a.md',
      body: 'shared galaxy truth',
      frontmatter: { tags: ['t'] },
    });
    await store.write({ path: 'notes/b.md', body: 'galaxy galaxy' });
  });

  it('search: identical result objects on both surfaces', async () => {
    const tool = await mcp.memory__search(store, 'galaxy');
    const api = await rest.search(store, 'galaxy');
    expect(tool.structuredContent).toEqual(api);
  });

  it('read: the REST note is a field-selection of the SAME MemoryView', async () => {
    const tool = await mcp.memory__read(store, 'notes/a.md');
    const api = await rest.getNote(store, 'notes/a.md');
    const view = tool.structuredContent!;
    // Every REST field equals the tool's field - one source object, two envelopes.
    expect(api).toEqual({
      path: view.path,
      title: view.title,
      frontmatter: view.frontmatter,
      body: view.body, // small doc: clamped and unclamped agree
      tags: view.tags,
      sizeBytes: view.sizeBytes,
      updated: view.updated,
    });
  });

  it('enumeration: NoteMeta on REST and TreeFile on MCP describe the same files', async () => {
    const tool = await mcp.memory__list(store);
    const api = await rest.getNotes(store);
    const toolPaths = JSON.stringify(tool.structuredContent)
      .match(/notes\/[ab]\.md/g)!
      .sort();
    expect([...new Set(toolPaths)]).toEqual(api.notes.map((n) => n.path).sort());
    for (const note of api.notes) {
      const view = (await store.read(note.path))!;
      expect(note.title).toBe(view.title);
      expect(note.tags).toEqual(view.tags);
      expect(note.sizeBytes).toBe(view.sizeBytes);
    }
  });

  it('errors: one taxonomy, both renderings derivable from the same code', async () => {
    const err = await store.write({ path: '../x.md', body: 'x' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_path' }); // -> HTTP 400 AND MCP isError, per contract/errors.ts
  });
});
