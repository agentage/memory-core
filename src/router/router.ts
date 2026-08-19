// Autoroute: bind one Access to one VaultContainer and every verb takes a ref
// instead of a store. ONE input rule - a ref is always `@vault/path`; anything
// without the prefix is invalid_path, whatever the grant holds. ONE output rule -
// every path the router emits is `@vault/path`, so every output round-trips as an
// input. The unscoped shapes are the discovery ones: list with no ref is the
// @vault folders root, search with no folder fans out across every granted vault.
//
// The router is the RESPONSIBLE layer for permission: it checks the ref's vault
// against Access BEFORE any container call, so an ungranted vault is refused with
// zero container interaction (the container's own gate stays the last defense).
// Binding is PURE - createRouter does no IO, so a router is cheap enough to build
// per request. Guards, ranking, paging and path validation stay in the store.

import type { Access, VaultContainer } from '../container/vault-container.js';
import { decodeCursor, encodeCursor } from '../contract/cursor.js';
import { StoreError } from '../contract/errors.js';
import { isSafeSegment } from '../contract/paths.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../contract/search.js';
import { DEFAULT_LIST_DEPTH } from '../contract/tree.js';
import type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchHit,
  SearchQuery,
  SearchResult,
  TreeEntry,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../contract/types.js';
import type { VaultStore } from '../contract/vault-store.js';

// A leading @<vault> addresses one vault; `@<vault>` alone is that vault's root.
const VAULT_PREFIX = /^@([^/]+)(?:\/(.*))?$/;

// FROZEN CLIENT CONTRACT: the cli regex-matches this text (memory-core parity).
export const unknownVaultMessage = (vault: string): string =>
  `Unknown vault "@${vault}". Use memory__list with no folder to see available vaults.`;

// Every verb addresses by ref, and every path it returns is one.
export interface Router {
  read(ref: string, opts?: { clamp?: boolean }): Promise<MemoryView | null>;
  write(ref: string, i: Omit<WriteInput, 'path'>, author?: WriteAuthor): Promise<WriteResult>;
  edit(ref: string, i: Omit<EditInput, 'path'>, author?: WriteAuthor): Promise<WriteResult | null>;
  delete(ref: string): Promise<boolean>;
  list(q: Omit<ListQuery, 'folder'> & { ref?: string }): Promise<ListResult>;
  search(q: SearchQuery): Promise<SearchResult>;
}

interface Ref {
  vault: string;
  path: string;
}

interface Bound {
  store: VaultStore;
  vault: string;
  path: string;
}

const invalidRef = (ref: string): StoreError =>
  new StoreError('invalid_path', `invalid ref ${JSON.stringify(ref)}: every ref is "@vault/path"`);

// Pure grammar, run before any container call so a bad ref never costs IO. `doc`
// refs must name a document; a folder ref may be a whole vault.
const parseRef = (ref: string, doc: boolean): Ref => {
  const m = ref.startsWith('@') ? VAULT_PREFIX.exec(ref) : null;
  const vault = m?.[1];
  const path = m?.[2] ?? '';
  // The vault segment must be one the layout could hold, and a nested @ would
  // name a document whose path could not round-trip as a ref.
  if (!vault || !isSafeSegment(vault) || path.startsWith('@') || (doc && !path))
    throw invalidRef(ref);
  return { vault, path };
};

const prefixEntries = (entries: TreeEntry[], prefix: string): TreeEntry[] =>
  entries.map((e) =>
    e.type === 'file'
      ? { ...e, path: `${prefix}/${e.path}` }
      : {
          ...e,
          path: `${prefix}/${e.path}`,
          entries: e.entries ? prefixEntries(e.entries, prefix) : undefined,
        }
  );

// The contract's total order, applied to the merged fan-out (score, recency, path).
const byRank = (a: SearchHit, b: SearchHit): number =>
  b.score - a.score || b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path);

export const createRouter = (container: VaultContainer, access: Access): Router => {
  // The router's own gate: an ungranted vault never becomes a container call.
  const authorize = (ref: Ref): Ref => {
    if (access.vaults !== '*' && !access.vaults.has(ref.vault))
      throw new StoreError('forbidden', `no access to vault: ${ref.vault}`);
    return ref;
  };

  const open = async (ref: Ref): Promise<Bound> => {
    // Granted but never provisioned is the one refusal the router owns - its text
    // is a frozen client contract. Every other refusal is the container's.
    if (!(await container.list(access)).includes(ref.vault))
      throw new StoreError('unknown_vault', unknownVaultMessage(ref.vault));
    return { store: await container.open(access, ref.vault), vault: ref.vault, path: ref.path };
  };

  const bind = async (ref: string, doc: boolean): Promise<Bound> => {
    const parsed = authorize(parseRef(ref, doc)); // pure: a bad or ungranted ref costs no IO
    return open(parsed);
  };

  const qualify = (b: Bound, path: string): string => `@${b.vault}/${path}`;

  // The discovery view: each vault is a top-level @folder, one level of its own tree inside.
  const rootView = async (vaults: string[], q: Omit<ListQuery, 'folder'>): Promise<ListResult> => {
    const depth = q.depth ?? DEFAULT_LIST_DEPTH;
    const entries: TreeEntry[] = [];
    let files = 0;
    let truncated = false;
    for (const vault of vaults) {
      const store = await container.open(access, vault);
      const inner = await store.list({ depth: 1, tags: q.tags });
      files += inner.files;
      truncated = truncated || inner.truncated;
      entries.push({
        type: 'folder',
        path: `@${vault}`,
        files: inner.files,
        entries: depth >= 2 ? prefixEntries(inner.entries, `@${vault}`) : undefined,
      });
    }
    return { folder: '', entries, truncated, files };
  };

  return {
    async read(ref, o) {
      const b = await bind(ref, true);
      const view = await b.store.read(b.path, o);
      return view && { ...view, path: qualify(b, view.path) };
    },

    async write(ref, i, author) {
      const b = await bind(ref, true);
      const r = await b.store.write({ ...i, path: b.path }, author);
      return { ...r, path: qualify(b, r.path) };
    },

    async edit(ref, i, author) {
      const b = await bind(ref, true);
      const r = await b.store.edit({ ...i, path: b.path }, author);
      return r && { ...r, path: qualify(b, r.path) };
    },

    async delete(ref) {
      const b = await bind(ref, true);
      return b.store.delete(b.path);
    },

    async list(q) {
      const { ref, ...page } = q;
      if (ref === undefined) return rootView(await container.list(access), page);
      const b = await bind(ref, false);
      const res = await b.store.list({ ...page, folder: b.path || undefined });
      return {
        ...res,
        folder: `@${b.vault}${b.path ? `/${b.path}` : ''}`,
        entries: prefixEntries(res.entries, `@${b.vault}`),
      };
    },

    async search(q) {
      // An @folder scopes to one vault: the store pages it, so its cursor is
      // authoritative and nothing is re-paged or capped twice.
      if (q.folder !== undefined) {
        const b = await bind(q.folder, false);
        const res = await b.store.search({ ...q, folder: b.path || undefined });
        return { ...res, results: res.results.map((h) => ({ ...h, path: qualify(b, h.path) })) };
      }
      const vaults = await container.list(access);
      const batches = await Promise.all(
        vaults.map(async (vault) => {
          const store = await container.open(access, vault);
          // Each vault contributes at most one full page; the merge re-pages them.
          const res = await store.search({ ...q, limit: MAX_SEARCH_LIMIT, cursor: undefined });
          return res.results.map((h) => ({ ...h, path: `@${vault}/${h.path}` }));
        })
      );
      const merged = batches.flat().sort(byRank);
      const limit = Math.min(q.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const offset = decodeCursor(q.cursor);
      const next = offset + limit;
      const results = merged.slice(offset, next);
      return next < merged.length ? { results, nextCursor: encodeCursor(next) } : { results };
    },
  };
};
