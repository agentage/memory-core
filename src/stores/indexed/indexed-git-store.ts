// Indexed server store: the bare-git store with a SQLite FTS5 sidecar as its
// search implementation - the "swap the store, get different search" tier.
// Everything except search IS the bare store; the index is derived state kept
// fresh from the event stream, rebuilt from git whenever stale, and never
// trusted over the contract: FTS narrows candidates, the shared occurrence
// scoring decides, and any doubt (error, empty page, unknown token shape)
// falls back to git grep. The index can lag - it can never lie.

import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deriveTags, parseDoc } from '../../contract/memory-doc.js';
import { countOccurrences, rankAndPage } from '../../contract/search.js';
import type { SearchQuery, SearchResult } from '../../contract/types.js';
import type { StoreEvent, VaultStore } from '../../contract/vault-store.js';
import { createBareGitStore, type BareGitStoreOptions } from '../bare-git/bare-git-store.js';
import { createGitRunner } from '../bare-git/git-run.js';

interface Row {
  path: string;
  content: string;
  tags: string;
  updated: string;
}

export const createIndexedGitStore = (
  repoDir: string,
  indexDir: string,
  opts: BareGitStoreOptions = {}
): VaultStore => {
  const base = createBareGitStore(repoDir, opts);
  const git = createGitRunner(repoDir, opts.onSpawn);
  let db: DatabaseSync | undefined;
  let applying: Promise<void> = Promise.resolve();

  const open = async (): Promise<DatabaseSync> => {
    if (db) return db;
    await mkdir(dirname(join(indexDir, 'x')), { recursive: true });
    db = new DatabaseSync(join(indexDir, 'index.sqlite'));
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs
        USING fts5(content, path UNINDEXED, tags UNINDEXED, updated UNINDEXED);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    `);
    return db;
  };

  const indexedVersion = (d: DatabaseSync): string | null => {
    const row = d.prepare(`SELECT v FROM meta WHERE k = 'version'`).get() as
      { v: string } | undefined;
    return row?.v ?? null;
  };

  const setVersion = (d: DatabaseSync, v: string): void => {
    d.prepare(
      `INSERT INTO meta(k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = ?`
    ).run(v, v);
  };

  const upsert = (d: DatabaseSync, path: string, raw: string, updated: string): void => {
    d.prepare(`DELETE FROM docs WHERE path = ?`).run(path);
    const { frontmatter, body } = parseDoc(raw);
    d.prepare(`INSERT INTO docs(content, path, tags, updated) VALUES (?, ?, ?, ?)`).run(
      raw,
      path,
      JSON.stringify(deriveTags(frontmatter, body)),
      updated
    );
  };

  const reindex = async (version: string): Promise<void> => {
    const d = await open();
    const tree = await git.tryRun(['ls-tree', '-r', '--name-only', version]);
    const paths = (tree ?? '').split('\n').filter(Boolean);
    const docs = await git.batchRead(version, paths);
    d.exec('BEGIN');
    try {
      d.exec('DELETE FROM docs');
      for (const [path, raw] of docs) upsert(d, path, raw, '');
      setVersion(d, version);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  };

  // Incremental freshness from the ONE extension seam. Deletions show up as
  // paths missing from the batch read (external diffs include removals).
  base.subscribe((e: StoreEvent) => {
    applying = applying
      .then(async () => {
        const d = await open();
        if (e.type === 'delete') {
          for (const p of e.paths) d.prepare(`DELETE FROM docs WHERE path = ?`).run(p);
        } else {
          const docs = await git.batchRead(e.version, e.paths);
          for (const p of e.paths) {
            const raw = docs.get(p);
            if (raw === undefined) d.prepare(`DELETE FROM docs WHERE path = ?`).run(p);
            else upsert(d, p, raw, e.at);
          }
        }
        setVersion(d, e.version);
      })
      .catch(() => {
        // failed apply = stale index; the version check forces a reindex
      });
  });

  const ftsSearch = async (query: SearchQuery, q: string): Promise<SearchResult | null> => {
    const version = await base.version();
    if (!version) return { results: [] };
    await applying;
    const d = await open();
    if (indexedVersion(d) !== version) await reindex(version);
    // Fixed-string query as a quoted FTS phrase; parameter-bound, quotes doubled.
    const rows = d
      .prepare(`SELECT path, content, tags, updated FROM docs WHERE docs MATCH ?`)
      .all(`"${q.replace(/"/g, '""')}"`) as unknown as Row[];
    const hits = rows.map((r) => ({
      path: r.path,
      score: countOccurrences(r.content, q),
      tags: JSON.parse(r.tags) as string[],
      body: parseDoc(r.content).body,
      updated: r.updated,
    }));
    const res = rankAndPage(hits, query);
    // Empty page = possible recall gap (substring or tokenizer shape) - let grep decide.
    return res.results.length ? res : null;
  };

  return {
    ...base,

    async search(query: SearchQuery): Promise<SearchResult> {
      const q = query.query.trim();
      if (!q) return { results: [] };
      try {
        return (await ftsSearch(query, q)) ?? (await base.search(query));
      } catch {
        return base.search(query); // the index can lag or break - never lie
      }
    },

    capabilities() {
      return { ...base.capabilities(), search: 'indexed' as const };
    },
  };
};
