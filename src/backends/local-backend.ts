import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  deriveTags,
  makeSnippet,
  parseDoc,
  serializeDoc,
  titleFromPath,
} from '../contract/memory-doc.js';
import type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchHit,
  SearchQuery,
  SearchResult,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../contract/types.js';
import { createGit, SEARCH_TIMEOUT, type Git } from './git.js';
import {
  decodeCursor,
  editBody,
  encodeCursor,
  parseGrepCounts,
  parseMtimes,
  safePath,
} from './local-ops.js';
import {
  buildTree,
  DEFAULT_LIST_DEPTH,
  DEFAULT_LIST_LIMITS,
  type ListLimits,
  normalizeFolder,
} from './tree.js';
import type { BackendCapabilities, VaultBackend } from './vault-backend.js';

const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

export interface LocalBackendOptions {
  path: string;
  now?: () => string;
  listLimits?: ListLimits; // injectable so truncation is testable without 100s of files
  autoInit?: boolean; // create the folder + git-init on first use (default true)
}

// The 6 tools over a local markdown folder kept as a git working copy. Reads/search
// go over the working tree (a human/Obsidian edit is visible immediately, files-first);
// every mutation is one git commit (delete = recoverable removal). git-backed-store
// semantics: git grep ranking, frontmatter passthrough, exact/unique str_replace.
export const createLocalBackend = (opts: LocalBackendOptions): VaultBackend => {
  const root = opts.path;
  const now = opts.now ?? (() => new Date().toISOString());
  const listLimits = opts.listLimits ?? DEFAULT_LIST_LIMITS;
  const autoInit = opts.autoInit ?? true;
  const git: Git = createGit(root);

  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        if (!autoInit && !existsSync(root)) {
          throw new Error(`vault path does not exist and autoInit is off: ${root}`);
        }
        await mkdir(root, { recursive: true });
        if (!existsSync(join(root, '.git'))) await git.run(['init', '-b', 'main']);
      })();
      ready.catch(() => (ready = undefined));
    }
    return ready;
  };

  // Serialize mutations: one index/commit at a time per repo.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const readDoc = async (
    path: string
  ): Promise<{ frontmatter: Record<string, unknown>; body: string } | null> => {
    try {
      return parseDoc(await readFile(join(root, path), 'utf8'));
    } catch {
      return null;
    }
  };

  const commit = async (path: string, verb: string, author?: WriteAuthor): Promise<string> => {
    const ts = now();
    await git.run(['add', '-A', '--', path]);
    await git.run(['commit', '--allow-empty', '-m', `${verb}: ${path}`], { date: ts, author });
    const rev = (await git.run(['rev-parse', 'HEAD'])).trim();
    return rev;
  };

  const writeDoc = async (
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    verb: string,
    author?: WriteAuthor
  ): Promise<WriteResult> => {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, serializeDoc(frontmatter, body), 'utf8');
    const ts = now();
    await git.run(['add', '-A', '--', path]);
    await git.run(['commit', '-m', `${verb}: ${path}`], { date: ts, author });
    const rev = (await git.run(['rev-parse', 'HEAD'])).trim();
    return { path, rev, updated: ts };
  };

  // tracked+untracked (non-ignored) markdown-bearing paths in the working tree.
  const listFiles = async (): Promise<string[]> => {
    const out = await git.try(['ls-files', '--cached', '--others', '--exclude-standard']);
    return out ? out.split('\n').filter(Boolean) : [];
  };

  const mtimeMap = (): Promise<Map<string, string>> =>
    git.try(['log', '--format=%cI', '--name-only', 'HEAD']).then(parseMtimes);

  return {
    capabilities(): BackendCapabilities {
      return { kind: 'local', mutate: true, search: 'git-grep' };
    },

    async write(input: WriteInput, author?: WriteAuthor): Promise<WriteResult> {
      if (!safePath(input.path)) throw new Error(`invalid path: ${JSON.stringify(input.path)}`);
      await ensure();
      return locked(() =>
        writeDoc(input.path, input.frontmatter ?? {}, input.body, 'write', author)
      );
    },

    async edit(input: EditInput, author?: WriteAuthor): Promise<WriteResult | null> {
      if (!safePath(input.path)) throw new Error(`invalid path: ${JSON.stringify(input.path)}`);
      await ensure();
      return locked(async () => {
        const existing = await readDoc(input.path);
        if (!existing) return null;
        const frontmatter = { ...existing.frontmatter, ...(input.frontmatter ?? {}) };
        return writeDoc(input.path, frontmatter, editBody(existing.body, input), 'edit', author);
      });
    },

    async read(path: string): Promise<MemoryView | null> {
      await ensure();
      const doc = await readDoc(path);
      if (!doc) return null;
      const updated = (await git.try(['log', '-1', '--format=%cI', '--', path]))?.trim() || now();
      return {
        path,
        title: titleFromPath(path),
        frontmatter: doc.frontmatter,
        body: doc.body,
        tags: deriveTags(doc.frontmatter, doc.body),
        updated,
        deleted: false,
      };
    },

    async delete(path: string): Promise<boolean> {
      await ensure();
      if (!safePath(path) || !existsSync(join(root, path))) return false;
      return locked(async () => {
        await rm(join(root, path), { force: true });
        await commit(path, 'delete');
        return true;
      });
    },

    async list(query: ListQuery): Promise<ListResult> {
      await ensure();
      const folder = normalizeFolder(query.folder);
      const depth = Math.min(Math.max(query.depth ?? DEFAULT_LIST_DEPTH, 1), 2);
      let paths = (await listFiles()).filter((p) => (folder ? p.startsWith(`${folder}/`) : true));
      if (query.tags?.length) {
        const keep = await Promise.all(
          paths.map(async (p) => {
            const doc = await readDoc(p);
            const tags = doc ? deriveTags(doc.frontmatter, doc.body) : [];
            return query.tags!.every((t) => tags.includes(t));
          })
        );
        paths = paths.filter((_, i) => keep[i]);
      }
      return buildTree(paths, folder, depth, await mtimeMap(), listLimits);
    },

    async search(query: SearchQuery): Promise<SearchResult> {
      await ensure();
      const q = query.query.trim();
      if (!q) return { results: [] };
      const grep = await git.try(
        ['grep', '-o', '-I', '-i', '-F', '--no-color', '--untracked', '-e', q],
        { timeoutMs: SEARCH_TIMEOUT }
      );
      if (!grep) return { results: [] };
      const counts = parseGrepCounts(grep);
      const mtimes = await mtimeMap();
      const scope = normalizeFolder(query.folder);
      const hits = await Promise.all(
        [...counts.entries()]
          .filter(([path]) => (scope ? path.startsWith(`${scope}/`) : true))
          .map(async ([path, score]) => {
            const doc = await readDoc(path);
            return {
              path,
              score,
              tags: doc ? deriveTags(doc.frontmatter, doc.body) : [],
              body: doc?.body ?? '',
              updated: mtimes.get(path) ?? '',
            };
          })
      );
      const scored = hits
        .filter((h) => (query.tags?.length ? query.tags.every((t) => h.tags.includes(t)) : true))
        .sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
      const limit = Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const offset = decodeCursor(query.cursor);
      const results: SearchHit[] = scored.slice(offset, offset + limit).map((h) => ({
        path: h.path,
        title: titleFromPath(h.path),
        snippet: makeSnippet(h.body, query.query),
        score: h.score,
        updated: h.updated,
      }));
      const next = offset + limit;
      return next < scored.length ? { results, nextCursor: encodeCursor(next) } : { results };
    },
  };
};
