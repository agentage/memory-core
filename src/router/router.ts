import type {
  EditInput,
  ListResult,
  MemoryView,
  SearchQuery,
  SearchResult,
  TreeEntry,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../contract/types.js';
import type { VaultHandle } from '../registry/registry.js';

const MAX_FANOUT_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const VAULT_PREFIX = /^@([^/]+)(?:\/(.*))?$/;

// Thrown when a path names a vault that is not surfaced. The server turns it into
// an isError tool result rather than crashing (M2-R2).
export class UnknownVaultError extends Error {
  constructor(public readonly vault: string) {
    super(`Unknown vault "@${vault}". Use memory__list with no folder to see available vaults.`);
    this.name = 'UnknownVaultError';
  }
}

const encode = (n: number): string => Buffer.from(String(n)).toString('base64');
const decode = (c?: string): number => (c ? Number(Buffer.from(c, 'base64').toString()) || 0 : 0);

// Federation over the surfaced backends. A bare path -> the default vault; an
// `@vault/path` -> that vault (the `@` is stripped before hitting the backend, and
// re-applied to results when >1 vault is surfaced so every returned path round-trips).
export interface Router {
  multi: boolean;
  read(path: string): Promise<MemoryView | null>;
  write(input: WriteInput, author?: WriteAuthor): Promise<WriteResult>;
  edit(input: EditInput, author?: WriteAuthor): Promise<WriteResult | null>;
  delete(path: string): Promise<boolean>;
  search(query: SearchQuery): Promise<SearchResult>;
  list(query: { folder?: string; depth?: 1 | 2; tags?: string[] }): Promise<ListResult>;
}

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

export const createRouter = (surfaced: VaultHandle[], defaultHandle?: VaultHandle): Router => {
  const multi = surfaced.length > 1;
  const tag = (id: string, path: string): string => (multi ? `@${id}/${path}` : path);

  const resolve = (pathish?: string): { handle: VaultHandle; rest: string } => {
    if (pathish && pathish.startsWith('@')) {
      const m = pathish.match(VAULT_PREFIX);
      const name = m?.[1] ?? '';
      const handle = surfaced.find((h) => h.id === name);
      if (!handle) throw new UnknownVaultError(name);
      return { handle, rest: m?.[2] ?? '' };
    }
    const handle = defaultHandle ?? surfaced[0];
    if (!handle) throw new Error('no vault is surfaced for this connection');
    return { handle, rest: pathish ?? '' };
  };

  return {
    multi,

    async read(path) {
      const { handle, rest } = resolve(path);
      return handle.backend.read(rest);
    },
    async write(input, author) {
      const { handle, rest } = resolve(input.path);
      const r = await handle.backend.write({ ...input, path: rest }, author);
      return { ...r, path: tag(handle.id, r.path) };
    },
    async edit(input, author) {
      const { handle, rest } = resolve(input.path);
      const r = await handle.backend.edit({ ...input, path: rest }, author);
      return r ? { ...r, path: tag(handle.id, r.path) } : null;
    },
    async delete(path) {
      const { handle, rest } = resolve(path);
      return handle.backend.delete(rest);
    },

    async search(query) {
      const limit = query.limit ?? DEFAULT_LIMIT;
      const offset = decode(query.cursor);
      // An @-scoped folder targets one vault; otherwise fan out across all surfaced.
      const scoped = query.folder?.startsWith('@');
      const targets = scoped
        ? [resolve(query.folder)]
        : surfaced.map((handle) => ({ handle, rest: undefined as string | undefined }));
      const batches = await Promise.all(
        targets.map(async ({ handle, rest }) => {
          const res = await handle.backend.search({
            ...query,
            folder: scoped ? rest || undefined : query.folder || undefined,
            limit: MAX_FANOUT_LIMIT,
            cursor: undefined,
          });
          return res.results.map((h) => ({ ...h, path: tag(handle.id, h.path) }));
        })
      );
      const merged = batches
        .flat()
        .sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
      const page = merged.slice(offset, offset + limit);
      const next = offset + limit;
      return next < merged.length ? { results: page, nextCursor: encode(next) } : { results: page };
    },

    async list(query) {
      const scoped = query.folder?.startsWith('@');
      if (scoped) {
        const { handle, rest } = resolve(query.folder);
        const res = await handle.backend.list({ ...query, folder: rest || undefined });
        if (!multi) return res;
        return {
          folder: `@${handle.id}${rest ? `/${rest}` : ''}`,
          entries: prefixEntries(res.entries, `@${handle.id}`),
          truncated: res.truncated,
          files: res.files,
        };
      }
      if (!multi || query.folder) {
        // bare folder -> default vault (single-vault stays fully transparent)
        const { handle } = resolve(query.folder);
        return handle.backend.list(query);
      }
      // multi-vault root: every vault is a top-level @folder.
      const depth = query.depth ?? 2;
      const entries: TreeEntry[] = [];
      let files = 0;
      let truncated = false;
      for (const handle of surfaced) {
        const inner = await handle.backend.list({ depth: 1, tags: query.tags });
        files += inner.files;
        truncated = truncated || inner.truncated;
        entries.push({
          type: 'folder',
          path: `@${handle.id}`,
          files: inner.files,
          entries: depth >= 2 ? prefixEntries(inner.entries, `@${handle.id}`) : undefined,
        });
      }
      return { folder: '', entries, truncated, files };
    },
  };
};
