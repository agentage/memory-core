// Local-world VaultStore: a markdown folder kept as a git working copy. Reads,
// list, and search go over the WORKING TREE, so a human/Obsidian edit is visible
// immediately, before any commit (files-first). Every store mutation is one git
// commit (delete = recoverable). Same template as every store: validate ->
// guard -> persist -> emit; git is only the durability layer here.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyEdit } from '../../contract/edit.js';
import { pageNotes } from '../../contract/notes.js';
import { deriveTags, parseDoc, serializeDoc, titleFromPath } from '../../contract/memory-doc.js';
import { assertSafePath, safePath } from '../../contract/paths.js';
import { clampView, ensureSize } from '../../contract/read-budget.js';
import { assertNoRestricted, frontmatterText } from '../../contract/restricted-data.js';
import { countOccurrences, rankAndPage } from '../../contract/search.js';
import { buildTree, DEFAULT_LIST_DEPTH, normalizeFolder } from '../../contract/tree.js';
import type {
  EditInput,
  ListNotesQuery,
  ListNotesResult,
  ListQuery,
  ListResult,
  MemoryView,
  SearchQuery,
  SearchResult,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../../contract/types.js';
import type { StoreEvent, StoreObserver, VaultStore } from '../../contract/vault-store.js';
import { gitAuthorOf } from '../bare-git/commit.js';
import { digestState, diffState, walkFiles, type WorktreeState } from './walk.js';

export interface WorkingCopyStoreOptions {
  now?: () => string;
  onSpawn?: (args: string[]) => void;
}

export const createWorkingCopyGitStore = (
  dir: string,
  opts: WorkingCopyStoreOptions = {}
): VaultStore => {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const observers = new Set<StoreObserver>();
  let lastState: WorktreeState | undefined; // undefined = boot baseline not taken
  let chain: Promise<unknown> = Promise.resolve();

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const git = (args: string[], author?: WriteAuthor): Promise<string> =>
    new Promise((resolve, reject) => {
      opts.onSpawn?.(args);
      const a = gitAuthorOf(author);
      execFile(
        'git',
        ['-C', dir, ...args],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: a?.name ?? 'agentage memory',
            GIT_AUTHOR_EMAIL: a?.email ?? 'memory@agentage.io',
            GIT_COMMITTER_NAME: 'agentage memory',
            GIT_COMMITTER_EMAIL: 'memory@agentage.io',
          },
          maxBuffer: 64 * 1024 * 1024,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });

  // Commit with a bounded retry on a raced index.lock (another local process).
  const commit = async (path: string, message: string, author?: WriteAuthor): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await git(['add', '-A', '--', path], author);
        await git(['commit', '-m', message], author);
        return;
      } catch (err) {
        if (attempt >= 3 || !String(err).includes('index.lock')) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  };

  const ensureRepo = async (): Promise<void> => {
    await mkdir(dir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) await git(['init', '-b', 'main']);
  };

  const readHead = async (): Promise<string | null> => {
    try {
      const head = (await readFile(join(dir, '.git', 'HEAD'), 'utf8')).trim();
      if (!head.startsWith('ref: ')) return head || null;
      return (await readFile(join(dir, '.git', head.slice(5)), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  };

  const computeVersion = async (
    state?: WorktreeState
  ): Promise<{ version: string | null; state: WorktreeState }> => {
    const s = state ?? (await walkFiles(dir));
    return { version: digestState(await readHead(), s), state: s };
  };

  const emit = (event: StoreEvent): void => {
    for (const obs of observers) {
      try {
        obs(event);
      } catch {
        // observers never break the store
      }
    }
  };

  // P4 for the local world: a human edit or pull shows up as worktree drift.
  const detectDrift = async (): Promise<StoreEvent[]> => {
    const state = await walkFiles(dir);
    if (lastState === undefined) {
      lastState = state;
      return [];
    }
    const paths = diffState(lastState, state);
    lastState = state;
    if (!paths.length) return [];
    const { version } = await computeVersion(state);
    const event: StoreEvent = { type: 'external', paths, version: version ?? '', at: now() };
    emit(event);
    return [event];
  };

  const trackOwn = async (path: string, removed: boolean): Promise<void> => {
    if (lastState === undefined) return;
    if (removed) {
      lastState.delete(path);
      return;
    }
    try {
      const s = await stat(join(dir, path));
      lastState.set(path, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      lastState.delete(path);
    }
  };

  const readRaw = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(join(dir, path), 'utf8');
    } catch {
      return undefined;
    }
  };

  const persist = async (
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
    type: 'write' | 'edit',
    existingRaw: string | undefined,
    author?: WriteAuthor
  ): Promise<WriteResult> => {
    const content = serializeDoc(frontmatter, body);
    ensureSize(content);
    assertNoRestricted(`${frontmatterText(frontmatter)}\n${body}`);
    if (existingRaw === content) {
      const { version } = await computeVersion(lastState);
      return { path, rev: version ?? '', updated: now() };
    }
    await ensureRepo();
    const abs = join(dir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    await commit(path, `${type}: ${path}`, author);
    await trackOwn(path, false);
    const ts = now();
    const { version } = await computeVersion(lastState);
    emit({ type, paths: [path], version: version ?? '', author, at: ts });
    return { path, rev: version ?? '', updated: ts };
  };

  return {
    async write(input: WriteInput, author?: WriteAuthor): Promise<WriteResult> {
      assertSafePath(input.path);
      await detectDrift();
      return locked(async () =>
        persist(
          input.path,
          input.frontmatter ?? {},
          input.body,
          'write',
          await readRaw(input.path),
          author
        )
      );
    },

    async edit(input: EditInput, author?: WriteAuthor): Promise<WriteResult | null> {
      assertSafePath(input.path);
      await detectDrift();
      return locked(async () => {
        const raw = await readRaw(input.path);
        if (raw === undefined) return null;
        const next = applyEdit(parseDoc(raw), input);
        return persist(input.path, next.frontmatter, next.body, 'edit', raw, author);
      });
    },

    async read(path: string, opts?: { clamp?: boolean }): Promise<MemoryView | null> {
      // No drift walk here: the worktree file IS the truth, so read cost stays
      // independent of vault size. Drift events fire from list/search/refresh.
      if (!safePath(path)) return null;
      const raw = await readRaw(path);
      if (raw === undefined) return null;
      const { frontmatter, body } = parseDoc(raw);
      const mtime = await stat(join(dir, path)).then(
        (s) => s.mtimeMs,
        () => undefined
      );
      const view: MemoryView = {
        path,
        title: titleFromPath(path),
        frontmatter,
        body,
        tags: deriveTags(frontmatter, body),
        updated: mtime ? new Date(mtime).toISOString() : now(),
        deleted: false,
        sizeBytes: Buffer.byteLength(raw, 'utf8'),
      };
      return opts?.clamp === false ? view : clampView(view);
    },

    async listNotes(q?: ListNotesQuery): Promise<ListNotesResult> {
      await detectDrift();
      const state = lastState ?? new Map<string, { mtimeMs: number }>();
      return pageNotes(
        state.keys(),
        q,
        async (page) => {
          const out = new Map<string, string>();
          for (const p of page) {
            const raw = await readRaw(p);
            if (raw !== undefined) out.set(p, raw);
          }
          return out;
        },
        (p) => {
          const s = state.get(p);
          return s ? new Date(s.mtimeMs).toISOString() : null;
        }
      );
    },

    async delete(path: string): Promise<boolean> {
      if (!safePath(path) || !existsSync(join(dir, path))) return false;
      await detectDrift();
      return locked(async () => {
        await rm(join(dir, path), { force: true });
        await commit(path, `delete: ${path}`);
        await trackOwn(path, true);
        const { version } = await computeVersion(lastState);
        emit({ type: 'delete', paths: [path], version: version ?? '', at: now() });
        return true;
      });
    },

    async list(query: ListQuery): Promise<ListResult> {
      await detectDrift();
      const folder = normalizeFolder(query.folder);
      const state = lastState ?? new Map();
      const depth = Math.min(Math.max(query.depth ?? DEFAULT_LIST_DEPTH, 1), 2);
      let paths = [...state.keys()].filter((p) => (folder ? p.startsWith(`${folder}/`) : true));
      if (query.tags?.length) {
        const keep = await Promise.all(
          paths.map(async (p) => {
            const raw = await readRaw(p);
            if (raw === undefined) return false;
            const { frontmatter, body } = parseDoc(raw);
            return query.tags!.every((t) => deriveTags(frontmatter, body).includes(t));
          })
        );
        paths = paths.filter((_, i) => keep[i]);
      }
      const mtimes = new Map(
        [...state].map(([p, s]) => [p, new Date(s.mtimeMs).toISOString()] as [string, string])
      );
      return buildTree(paths, folder, depth, mtimes);
    },

    async search(query: SearchQuery): Promise<SearchResult> {
      const q = query.query.trim();
      if (!q) return { results: [] };
      await detectDrift();
      const state = lastState ?? new Map<string, { mtimeMs: number }>();
      const hits = await Promise.all(
        [...state.entries()].map(async ([path, s]) => {
          const raw = (await readRaw(path)) ?? '';
          const { frontmatter, body } = parseDoc(raw);
          return {
            path,
            score: countOccurrences(raw, q),
            tags: deriveTags(frontmatter, body),
            body,
            updated: new Date(s.mtimeMs).toISOString(),
          };
        })
      );
      return rankAndPage(hits, query);
    },

    async version(): Promise<string | null> {
      return (await computeVersion()).version;
    },

    async refresh(): Promise<StoreEvent[]> {
      return detectDrift();
    },

    subscribe(obs: StoreObserver): () => void {
      observers.add(obs);
      return () => observers.delete(obs);
    },

    capabilities() {
      return {
        mutable: true,
        versioned: true,
        externallyMutable: true,
        search: 'lexical' as const,
      };
    },
  };
};
