// Autoroute: bind one Access to one VaultContainer and every verb takes a ref
// instead of a store. "path" -> the default vault, "@vault/path" -> that vault.
// One granted vault = the layer is invisible (no prefix required in, none
// emitted out, results identical to calling the store); more than one = every
// returned path is re-tagged so it stays addressable, and search fans out.
//
// Binding is PURE - createRouter does no IO, so a router is cheap enough to build
// per request; the vault set resolves per operation. Guards, ranking, paging and
// path validation stay in the store, access stays in the container: the router
// owns addressing and nothing else.

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

const NO_VAULT = 'no vault is available for this connection';

// Every verb addresses by ref; the vault a plain ref lands in is bound, not passed.
export interface Router {
  read(ref: string, opts?: { clamp?: boolean }): Promise<MemoryView | null>;
  write(ref: string, i: Omit<WriteInput, 'path'>, author?: WriteAuthor): Promise<WriteResult>;
  edit(ref: string, i: Omit<EditInput, 'path'>, author?: WriteAuthor): Promise<WriteResult | null>;
  delete(ref: string): Promise<boolean>;
  list(q: Omit<ListQuery, 'folder'> & { ref?: string }): Promise<ListResult>;
  search(q: SearchQuery): Promise<SearchResult>;
}

export interface RouterOptions {
  // Where a plain (unprefixed) ref lands; defaults to the first vault listed.
  defaultVault?: string;
}

interface Ref {
  vault?: string;
  path: string;
}

interface Bound {
  store: VaultStore;
  vault: string;
  path: string;
  multi: boolean;
}

const invalidRef = (ref: string): StoreError =>
  new StoreError('invalid_path', `invalid ref: ${JSON.stringify(ref)}`);

// Pure grammar, run before any container call so a malformed ref never costs IO.
// `doc` refs must name a document; a folder ref may be a whole vault.
const parseRef = (ref: string | undefined, doc: boolean): Ref => {
  const raw = ref ?? '';
  if (!raw.startsWith('@')) {
    if (doc && !raw) throw invalidRef(raw);
    return { path: raw };
  }
  const m = VAULT_PREFIX.exec(raw);
  const vault = m?.[1];
  const path = m?.[2] ?? '';
  // A nested @ would name a document whose path cannot round-trip as a ref.
  if (!vault || path.startsWith('@') || (doc && !path)) throw invalidRef(raw);
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

export const createRouter = (
  container: VaultContainer,
  access: Access,
  opts: RouterOptions = {}
): Router => {
  const isGranted = (vault: string): boolean => access.vaults === '*' || access.vaults.has(vault);

  const open = async (vaults: string[], ref: Ref): Promise<Bound> => {
    const vault = ref.vault ?? opts.defaultVault ?? vaults[0];
    if (!vault) throw new StoreError('unknown_vault', NO_VAULT);
    // Granted but never provisioned is the one refusal the router owns - its text
    // is a frozen client contract. Every other refusal is the container's.
    if (
      ref.vault &&
      !vaults.includes(ref.vault) &&
      isGranted(ref.vault) &&
      isSafeSegment(ref.vault)
    )
      throw new StoreError('unknown_vault', unknownVaultMessage(ref.vault));
    const store = await container.open(access, vault);
    return { store, vault, path: ref.path, multi: vaults.length > 1 };
  };

  const bind = async (ref: string | undefined, doc: boolean): Promise<Bound> => {
    const parsed = parseRef(ref, doc); // grammar first: a bad ref costs no IO
    return open(await container.list(access), parsed);
  };

  const qualify = (b: Bound, path: string): string => `@${b.vault}/${path}`;

  // Multi-vault root: each vault is a top-level @folder, one level of its own tree inside.
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
      return view && b.multi ? { ...view, path: qualify(b, view.path) } : view;
    },

    async write(ref, i, author) {
      const b = await bind(ref, true);
      const r = await b.store.write({ ...i, path: b.path }, author);
      return b.multi ? { ...r, path: qualify(b, r.path) } : r;
    },

    async edit(ref, i, author) {
      const b = await bind(ref, true);
      const r = await b.store.edit({ ...i, path: b.path }, author);
      return r && b.multi ? { ...r, path: qualify(b, r.path) } : r;
    },

    async delete(ref) {
      const b = await bind(ref, true);
      return b.store.delete(b.path);
    },

    async list(q) {
      const { ref, ...page } = q;
      const parsed = parseRef(ref, false);
      const vaults = await container.list(access);
      if (!ref && vaults.length > 1) return rootView(vaults, page);
      const b = await open(vaults, parsed);
      const res = await b.store.list({ ...page, folder: b.path || undefined });
      if (!b.multi) return res;
      return {
        ...res,
        folder: `@${b.vault}${b.path ? `/${b.path}` : ''}`,
        entries: prefixEntries(res.entries, `@${b.vault}`),
      };
    },

    async search(q) {
      const parsed = parseRef(q.folder, false);
      const vaults = await container.list(access);
      // One target (single vault, or an @folder scope): the store pages it - its
      // cursor is authoritative, so nothing is re-paged and nothing is capped twice.
      if (parsed.vault || vaults.length <= 1) {
        const b = await open(vaults, parsed);
        const res = await b.store.search({ ...q, folder: b.path || undefined });
        if (!b.multi) return res;
        return { ...res, results: res.results.map((h) => ({ ...h, path: qualify(b, h.path) })) };
      }
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
