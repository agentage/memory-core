// In-memory VaultStore: the contract's reference implementation and the dev/test
// fixture. Thin by design - all semantics (edit modes, tree shape, ranking,
// guards) come from the contract layer, so this file is the template every real
// store follows: validate -> guard -> persist -> emit.

import { applyEdit } from '../contract/edit.js';
import { deriveTags, serializeDoc, titleFromPath } from '../contract/memory-doc.js';
import { assertSafePath, safePath } from '../contract/paths.js';
import { clampView, ensureSize } from '../contract/read-budget.js';
import { assertNoRestricted, frontmatterText } from '../contract/restricted-data.js';
import { countOccurrences, rankAndPage } from '../contract/search.js';
import { buildTree, DEFAULT_LIST_DEPTH, normalizeFolder } from '../contract/tree.js';
import type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchQuery,
  SearchResult,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../contract/types.js';
import type { StoreEvent, StoreObserver, VaultStore } from '../contract/vault-store.js';

interface Doc {
  frontmatter: Record<string, unknown>;
  body: string;
  updated: string;
}

export interface SeedFile {
  path: string;
  body: string;
}

export interface MemoryStoreOptions {
  now?: () => string;
}

export const createMemoryStore = (
  seed: ReadonlyArray<SeedFile> = [],
  opts: MemoryStoreOptions = {}
): VaultStore => {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const docs = new Map<string, Doc>();
  const observers = new Set<StoreObserver>();
  let counter = 0;

  for (const f of seed) {
    assertSafePath(f.path);
    docs.set(f.path, { frontmatter: {}, body: f.body, updated: now() });
  }
  if (seed.length) counter = 1;

  const versionOf = (): string | null => (counter === 0 ? null : String(counter));

  const emit = (e: Omit<StoreEvent, 'version' | 'at'>): void => {
    counter++;
    const event: StoreEvent = { ...e, version: String(counter), at: now() };
    for (const obs of observers) {
      try {
        obs(event);
      } catch {
        // observers never break the store
      }
    }
  };

  const persist = (
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    type: 'write' | 'edit',
    author?: WriteAuthor
  ): WriteResult => {
    const content = serializeDoc(frontmatter, body);
    ensureSize(content);
    assertNoRestricted(`${frontmatterText(frontmatter)}\n${body}`);
    const existing = docs.get(path);
    // No-op (byte-identical to the stored doc): already in the desired state -
    // return the current version, emit nothing.
    if (existing && serializeDoc(existing.frontmatter, existing.body) === content) {
      return { path, rev: String(counter), updated: existing.updated };
    }
    const updated = now();
    docs.set(path, { frontmatter, body, updated });
    emit({ type, paths: [path], author });
    return { path, rev: String(counter), updated };
  };

  return {
    async write(input: WriteInput, author?: WriteAuthor): Promise<WriteResult> {
      assertSafePath(input.path);
      return persist(input.path, input.frontmatter ?? {}, input.body, 'write', author);
    },

    async edit(input: EditInput, author?: WriteAuthor): Promise<WriteResult | null> {
      assertSafePath(input.path);
      const existing = docs.get(input.path);
      if (!existing) return null;
      const next = applyEdit(existing, input);
      return persist(input.path, next.frontmatter, next.body, 'edit', author);
    },

    async read(path: string): Promise<MemoryView | null> {
      if (!safePath(path)) return null;
      const doc = docs.get(path);
      if (!doc) return null;
      return clampView({
        path,
        title: titleFromPath(path),
        frontmatter: doc.frontmatter,
        body: doc.body,
        tags: deriveTags(doc.frontmatter, doc.body),
        updated: doc.updated,
        deleted: false,
      });
    },

    async delete(path: string): Promise<boolean> {
      if (!safePath(path) || !docs.has(path)) return false;
      docs.delete(path);
      emit({ type: 'delete', paths: [path] });
      return true;
    },

    async list(query: ListQuery): Promise<ListResult> {
      const folder = normalizeFolder(query.folder);
      const depth = Math.min(Math.max(query.depth ?? DEFAULT_LIST_DEPTH, 1), 2);
      let paths = [...docs.keys()].filter((p) => (folder ? p.startsWith(`${folder}/`) : true));
      if (query.tags?.length) {
        paths = paths.filter((p) => {
          const doc = docs.get(p);
          const tags = doc ? deriveTags(doc.frontmatter, doc.body) : [];
          return query.tags!.every((t) => tags.includes(t));
        });
      }
      const mtimes = new Map([...docs].map(([p, d]) => [p, d.updated]));
      return buildTree(paths, folder, depth, mtimes);
    },

    async search(query: SearchQuery): Promise<SearchResult> {
      const q = query.query.trim();
      if (!q) return { results: [] };
      const hits = [...docs].map(([path, doc]) => ({
        path,
        score: countOccurrences(serializeDoc(doc.frontmatter, doc.body), q),
        tags: deriveTags(doc.frontmatter, doc.body),
        body: doc.body,
        updated: doc.updated,
      }));
      return rankAndPage(hits, query);
    },

    async version(): Promise<string | null> {
      return versionOf();
    },

    async refresh(): Promise<StoreEvent[]> {
      return []; // nothing external can mutate an in-memory store
    },

    subscribe(obs: StoreObserver): () => void {
      observers.add(obs);
      return () => observers.delete(obs);
    },

    capabilities() {
      return {
        mutable: true,
        versioned: false,
        externallyMutable: false,
        search: 'lexical' as const,
      };
    },
  };
};
