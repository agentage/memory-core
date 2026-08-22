// Server-world VaultStore: one bare git repo, plumbing commits, no working tree.
// Same template as every store (validate -> guard -> persist -> emit); the git
// specifics live in git-run/commit/snapshot. Spawn budget: read 1, readMany 1
// (N docs, one batch), search 2, list 0 warm - version checks are fs reads.

import { applyEdit } from '../../contract/edit.js';
import { deriveTags, parseDoc, serializeDoc, titleFromPath } from '../../contract/memory-doc.js';
import { assertSafePath, safePath } from '../../contract/paths.js';
import { clampView, ensureSize } from '../../contract/read-budget.js';
import { assertNoRestricted, frontmatterText } from '../../contract/restricted-data.js';
import { rankAndPageDeferred } from '../../contract/search.js';
import { DEFAULT_LIST_DEPTH, normalizeFolder, pageTree } from '../../contract/tree.js';
import type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchQuery,
  SearchResult,
  VaultDescription,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../../contract/types.js';
import type { StoreEvent, StoreObserver, VaultStore } from '../../contract/vault-store.js';
import { commitChange, gitAuthorOf } from './commit.js';
import { createGitRunner } from './git-run.js';
import { buildSnapshot, driftChanges, patchSnapshot, type Snapshot } from './snapshot.js';
import { computeVaultStats } from './stats-view.js';

const SEARCH_TIMEOUT_MS = 5_000;

export interface BareGitStoreOptions {
  now?: () => string;
  onSpawn?: (args: string[]) => void;
}

export const createBareGitStore = (repoDir: string, opts: BareGitStoreOptions = {}): VaultStore => {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const git = createGitRunner(repoDir, opts.onSpawn);
  const observers = new Set<StoreObserver>();
  let snap: Snapshot | null = null;
  // The vault card, keyed by the version it was computed from - stale by construction.
  let described: { version: string; value: VaultDescription } | null = null;
  // undefined = never observed (boot baseline, no event storm); null = seen-empty.
  let lastSeen: string | null | undefined = undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const emit = (event: StoreEvent): void => {
    lastSeen = event.version;
    for (const obs of observers) {
      try {
        obs(event);
      } catch {
        // observers never break the store
      }
    }
  };

  // P4: any operation may discover the ref moved out-of-band (push received).
  // Cheap when quiet (one fs read); on drift, one diff answers BOTH questions -
  // what to tell observers, and how to move the snapshot to the new version.
  const detectDrift = async (): Promise<StoreEvent[]> => {
    const v = await git.readVersion();
    if (lastSeen === undefined) {
      lastSeen = v;
      return [];
    }
    if (v === lastSeen || v === null) return [];
    const changes = await driftChanges(git, lastSeen, v);
    // The diff is the patch: a push must not cost a fresh walk of all history.
    // A snapshot at any other version, or a patch that cannot be made faithfully,
    // falls back to the lazy rebuild.
    snap = snap && snap.version === lastSeen ? await patchSnapshot(git, snap, changes, v) : null;
    const event: StoreEvent = {
      type: 'external',
      paths: changes.map((c) => c.path),
      version: v,
      at: now(),
    };
    emit(event);
    return [event];
  };

  const getSnap = async (): Promise<Snapshot | null> => {
    const v = await git.readVersion();
    if (!v) return null;
    if (!snap || snap.version !== v) snap = await buildSnapshot(git, v);
    return snap;
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
      // No-op: already in the desired state - current version, no commit, no event.
      const v = (await git.readVersion())!;
      return { path, rev: v, updated: snap?.mtimes.get(path) ?? now() };
    }
    await git.ensureRepo();
    const ts = now();
    const blob = (await git.run(['hash-object', '-w', '--stdin'], { input: content })).trim();
    const rev = await commitChange(
      git,
      repoDir,
      { path, blobSha: blob },
      `${type}: ${path}`,
      ts,
      gitAuthorOf(author)
    );
    if (snap) {
      snap.version = rev;
      snap.paths.add(path);
      snap.mtimes.set(path, ts);
    }
    emit({ type, paths: [path], version: rev, author, at: ts });
    return { path, rev, updated: ts };
  };

  const readRaw = async (path: string): Promise<string | undefined> =>
    (await git.batchRead('HEAD', [path])).get(path);

  // The one read shape; read and readMany differ only in how many docs one
  // `cat-file --batch` carried.
  const viewOf = (
    path: string,
    raw: string,
    mtimes: Map<string, string> | undefined,
    opts?: { clamp?: boolean }
  ): MemoryView => {
    const { frontmatter, body } = parseDoc(raw);
    const view: MemoryView = {
      path,
      title: titleFromPath(path),
      frontmatter,
      body,
      tags: deriveTags(frontmatter, body),
      updated: mtimes?.get(path) ?? now(),
      deleted: false,
      sizeBytes: Buffer.byteLength(raw, 'utf8'),
    };
    return opts?.clamp === false ? view : clampView(view);
  };

  return {
    async write(input: WriteInput, author?: WriteAuthor): Promise<WriteResult> {
      assertSafePath(input.path);
      await detectDrift();
      return locked(async () => {
        const existing = git.repoExists() ? await readRaw(input.path) : undefined;
        return persist(input.path, input.frontmatter ?? {}, input.body, 'write', existing, author);
      });
    },

    async edit(input: EditInput, author?: WriteAuthor): Promise<WriteResult | null> {
      assertSafePath(input.path);
      await detectDrift();
      return locked(async () => {
        const raw = git.repoExists() ? await readRaw(input.path) : undefined;
        if (raw === undefined) return null;
        const next = applyEdit(parseDoc(raw), input);
        return persist(input.path, next.frontmatter, next.body, 'edit', raw, author);
      });
    },

    async read(path: string, opts?: { clamp?: boolean }): Promise<MemoryView | null> {
      if (!safePath(path) || !git.repoExists()) return null;
      await detectDrift();
      const raw = await readRaw(path);
      if (raw === undefined) return null;
      return viewOf(path, raw, (await getSnap())?.mtimes, opts);
    },

    // N docs, ONE `cat-file --batch` - the same answer N reads give, without N
    // forks. Unsafe and absent paths never reach git and come back null in place.
    async readMany(paths: string[], opts?: { clamp?: boolean }): Promise<(MemoryView | null)[]> {
      if (!paths.length) return [];
      if (!git.repoExists()) return paths.map(() => null);
      await detectDrift();
      // Deduplicated for the wire only - the answer still repeats a repeated path.
      const wanted = [...new Set(paths.filter((p) => safePath(p)))];
      const raws = await git.batchRead('HEAD', wanted);
      const mtimes = raws.size ? (await getSnap())?.mtimes : undefined;
      return paths.map((p) => {
        const raw = raws.get(p);
        return raw === undefined ? null : viewOf(p, raw, mtimes, opts);
      });
    },

    async delete(path: string): Promise<boolean> {
      if (!safePath(path) || !git.repoExists()) return false;
      await detectDrift();
      return locked(async () => {
        if ((await readRaw(path)) === undefined) return false;
        const ts = now();
        const rev = await commitChange(git, repoDir, { path, remove: true }, `delete: ${path}`, ts);
        if (snap) {
          snap.version = rev;
          snap.paths.delete(path);
          snap.mtimes.delete(path);
        }
        emit({ type: 'delete', paths: [path], version: rev, at: ts });
        return true;
      });
    },

    async list(query: ListQuery): Promise<ListResult> {
      const folder = normalizeFolder(query.folder);
      const empty: ListResult = { folder, entries: [], truncated: false, files: 0 };
      if (!git.repoExists()) return empty;
      await detectDrift();
      const s = await getSnap();
      if (!s) return empty;
      const depth = Math.min(Math.max(query.depth ?? DEFAULT_LIST_DEPTH, 1), 2);
      let paths = [...s.paths].filter((p) => (folder ? p.startsWith(`${folder}/`) : true));
      if (query.tags?.length) {
        // Same ref as the snapshot being filtered - HEAD can move mid-list.
        const docs = await git.batchRead(s.version, paths);
        paths = paths.filter((p) => {
          const raw = docs.get(p);
          if (raw === undefined) return false;
          const { frontmatter, body } = parseDoc(raw);
          return query.tags!.every((t) => deriveTags(frontmatter, body).includes(t));
        });
      }
      return pageTree(paths, folder, depth, s.mtimes, query);
    },

    async search(query: SearchQuery): Promise<SearchResult> {
      const q = query.query.trim();
      if (!q || !git.repoExists()) return { results: [] };
      await detectDrift();
      const s = await getSnap();
      if (!s) return { results: [] };
      // -o = one line per occurrence -> occurrence count; -F -i mirror the contract.
      const grep = await git.tryRun(
        ['grep', '-o', '-I', '-i', '-F', '--no-color', '--threads=2', '-e', q, s.version],
        { timeoutMs: SEARCH_TIMEOUT_MS }
      );
      if (!grep) return { results: [] }; // exit 1 = no match; an infra failure already threw
      const counts = new Map<string, number>();
      for (const line of grep.split('\n')) {
        if (!line) continue;
        const rest = line.slice(line.indexOf(':') + 1);
        const path = rest.slice(0, rest.indexOf(':'));
        if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
      }
      // grep already yields every ranking input (path, occurrences, mtime), so the
      // page is decided before any blob is read - one page of docs, not one per match.
      const hits = [...counts.entries()].map(([path, score]) => ({
        path,
        score,
        updated: s.mtimes.get(path) ?? '',
      }));
      return rankAndPageDeferred(hits, query, (paths) => git.batchRead(s.version, paths));
    },

    // Read-only: never creates the repo, so an unprovisioned vault describes as empty.
    // Derived from the version like every other cached view: two spawns once per
    // version, then free however many vault cards a page renders.
    async describe(): Promise<VaultDescription> {
      const none = { files: 0, folders: 0, sizeBytes: 0, updated: null, version: null };
      if (!git.repoExists()) return none;
      await detectDrift();
      const version = await git.readVersion();
      if (!version) return none;
      if (described?.version !== version) {
        const { files, folders, sizeBytes } = await computeVaultStats(git, version);
        const at = await git.tryRun(['log', '-1', '--format=%cI', version]);
        described = {
          version,
          value: { files, folders, sizeBytes, updated: at?.trim() || null, version },
        };
      }
      return { ...described.value }; // a copy: a caller's edit must not become the cache
    },

    async version(): Promise<string | null> {
      return git.readVersion();
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
