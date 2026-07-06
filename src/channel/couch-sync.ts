import {
  contentRev,
  encodeFile,
  fileId,
  leafIdsOf,
  pathOf,
  type FileDoc,
  type LeafDoc,
} from './couch-doc.js';
import type { CouchState } from './couch-state.js';
import type { FetchLike } from './http.js';

// CouchDB sync channel (thin client) - THE account channel for couch-flagged memories.
// Replicates a markdown file set to a per-memory CouchDB using the SAME content-addressed
// model the server bridge expects (leaf docs + a file doc); the bridge then commits every
// couch edit to git. Transport-agnostic: fetch + a FileStore are injected (the CLI wires a
// local folder, obsidian wired its vault). Echo-safe: a push/pull whose content already
// matches is skipped, so the files<->couch<->git loop converges.

const DEFAULT_PAGE = 200; // _changes page size so a big feed never lands in one response
const SUPPRESS_MS = 200; // window after a pull-write during which the path's push is skipped
const ok2xx = (status: number): boolean => status >= 200 && status < 300;

export interface CouchSyncConfig {
  endpoint: string; // discovered couch host, e.g. https://couch.<fqdn>
  db: string; // discovered per-memory db name (mem_<hash>)
  pageLimit?: number; // _changes limit; defaults to DEFAULT_PAGE
}

// The markdown file set to replicate. Paths are vault-relative POSIX. `read` returns null
// when the path is absent; `write` creates-or-modifies (incl. parent dirs); `remove` is a
// no-op when absent. Replaces the obsidian vault adapter.
export interface FileStore {
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, body: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// Mints/caches the couch JWT (CouchTokenClient.token); the header is always "Bearer <jwt>".
export type CouchAuthorize = () => Promise<string>;

// Outcome of a full syncNow round. Resilient like tick(): a push/pull failure is recorded
// here (and logged) rather than thrown, so callers can report success/failure without a catch.
export interface SyncResult {
  pushed: boolean; // pushAll finished without throwing
  pulled: boolean; // pullOnce finished without throwing
  error?: string; // first error message when either side failed
}

export class CouchSync {
  private pulling = false;
  private suppress = new Set<string>(); // paths being written by a pull (skip their push)

  constructor(
    private files: FileStore,
    private cfg: CouchSyncConfig,
    private fetch: FetchLike,
    private authorize: CouchAuthorize, // supplies a valid couch JWT (see CouchTokenClient)
    private onUnauthorized: () => void, // drop the token cache so a 401 retry re-mints
    private state: CouchState, // persisted cursor + push-rev cache + pending pushes
    private log: (msg: string) => void = () => {}
  ) {}

  private url(p: string): string {
    return `${this.cfg.endpoint.replace(/\/+$/, '')}/${this.cfg.db}${p}`;
  }
  private async req(
    p: string,
    init: { method?: string; body?: string } = {}
  ): Promise<{ status: number; json: unknown }> {
    const send = async (): Promise<{ status: number; json: unknown }> => {
      const jwt = await this.authorize();
      const r = await this.fetch(this.url(p), {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: init.body,
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    };
    const out = await send();
    if (out.status !== 401) return out;
    this.onUnauthorized(); // JWT expired/rejected -> re-mint and retry once
    return send();
  }

  private async getDoc(id: string, rev?: string): Promise<(FileDoc & Partial<LeafDoc>) | null> {
    const r = await this.req(
      `/${encodeURIComponent(id)}${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`
    );
    return r.status === 200 ? (r.json as FileDoc & Partial<LeafDoc>) : null;
  }
  // Mirror the server's decodeFile: a missing leaf THROWS, never substitutes an empty chunk
  // (which would truncate the note). The caller aborts the pull round and keeps the cursor.
  private async reassemble(fdoc: FileDoc): Promise<string> {
    const parts: string[] = [];
    for (const id of fdoc.leaves) {
      const leaf = await this.getDoc(id);
      if (!leaf || typeof leaf.data !== 'string')
        throw new Error(`couch pull: missing leaf ${id} for ${fdoc.path}`);
      parts.push(leaf.data);
    }
    return parts.join('');
  }

  // -- push: files -> couch --------------------------------------------------
  async pushFile(path: string): Promise<void> {
    if (this.suppress.has(path)) return; // we are mid-pull-writing this file
    const body = await this.files.read(path);
    if (body === null) return; // gone from the file set
    const { leaves, fileDoc } = await encodeFile(path, body);
    const rev = contentRev(fileDoc);
    if (this.state.revFor(path) === rev) return; // this exact content is already pushed
    const cur = await this.getDoc(fileDoc._id);
    if (cur && !cur._deleted && JSON.stringify(cur.leaves) === JSON.stringify(fileDoc.leaves)) {
      await this.state.setRev(path, rev); // remote already converged; cache so we skip next time
      return;
    }
    const bulk = await this.req('/_bulk_docs', {
      method: 'POST',
      body: JSON.stringify({ new_edits: false, docs: leaves }),
    });
    if (!ok2xx(bulk.status)) throw new Error(`couch push leaves ${bulk.status} for ${path}`);
    const put: FileDoc = { ...fileDoc };
    if (cur && cur._rev) put._rev = cur._rev; // normal update so this device's edit wins
    const r = await this.req(`/${encodeURIComponent(put._id)}`, {
      method: 'PUT',
      body: JSON.stringify(put),
    });
    // Cache the pushed rev only after couch accepted it, so a rejected push stays retryable.
    if (!ok2xx(r.status)) throw new Error(`couch push ${r.status} for ${path}`);
    await this.state.setRev(path, rev);
    this.log(`push ${path} -> ${r.status}`);
  }

  // Live push (sync-on-save): a failure queues the path so the next tick retries it, and a
  // success clears any prior queue entry. Never throws (the caller's event handler is void).
  async pushFileLive(path: string): Promise<void> {
    try {
      await this.pushFile(path);
      await this.state.dequeue(path);
    } catch (e) {
      await this.state.enqueue(path);
      this.log(`push ${path} failed, queued: ${(e as Error).message}`);
    }
  }

  // Tombstone the file doc at its current couch rev. Terminal outcomes (no retry needed):
  //   'deleted'  - couch accepted the tombstone, or the doc was already gone
  //   'conflict' - couch advanced under us (a newer edit) - abandon the delete and let the
  //                next pull re-deliver that newer version (edit-wins-over-stale-delete).
  // Throws only on a transport/couch failure so the caller can keep the deletion pending.
  private async tombstone(path: string): Promise<'deleted' | 'conflict'> {
    const cur = await this.getDoc(fileId(path));
    if (!cur?._rev || cur._deleted) {
      await this.state.dropRev(path);
      return 'deleted'; // already absent on couch
    }
    // Content moved on since we last synced it -> another device edited it, not the version we
    // deleted. Never force-delete the fresh rev; drop our rev so pull re-delivers it.
    const known = this.state.revFor(path);
    if (known !== undefined && contentRev(cur) !== known) {
      await this.state.dropRev(path);
      return 'conflict';
    }
    const r = await this.req(
      `/${encodeURIComponent(fileId(path))}?rev=${encodeURIComponent(cur._rev)}`,
      { method: 'DELETE' }
    );
    if (r.status === 409) {
      await this.state.dropRev(path); // rev went stale mid-flight -> let pull win
      return 'conflict';
    }
    if (!ok2xx(r.status)) throw new Error(`couch delete ${r.status} for ${path}`);
    await this.state.dropRev(path);
    this.log(`delete ${path}`);
    return 'deleted';
  }

  // Live delete (mirror of pushFileLive): a transport failure queues the tombstone so the next
  // tick retries it, a terminal outcome clears any prior queue entry. Never throws.
  async removeFile(path: string): Promise<void> {
    try {
      await this.tombstone(path);
      await this.state.dequeueDeletion(path);
    } catch (e) {
      await this.state.enqueueDeletion(path);
      this.log(`delete ${path} failed, queued: ${(e as Error).message}`);
    }
  }

  // A file we have synced (rev cache) but that is no longer in the file set was deleted
  // locally - issue its tombstone. A couch doc with no rev-cache entry is new remote content
  // (pull writes it), so it is never mistaken for a local deletion.
  private async reconcileDeletions(): Promise<void> {
    const present = new Set(await this.files.listMarkdown());
    for (const path of this.state.knownPaths()) {
      if (!present.has(path)) await this.removeFile(path);
    }
  }

  async pushAll(): Promise<void> {
    for (const path of await this.files.listMarkdown()) await this.pushFileLive(path);
    await this.reconcileDeletions();
  }

  // -- pull: couch -> files --------------------------------------------------
  async pullOnce(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;
    const limit = this.cfg.pageLimit ?? DEFAULT_PAGE;
    try {
      for (;;) {
        const since = this.state.getCursor();
        const r = await this.req(
          `/_changes?since=${encodeURIComponent(since)}&include_docs=true&style=all_docs&limit=${limit}`
        );
        const body = r.json as {
          results?: Array<{ id: string; deleted?: boolean; doc?: FileDoc }>;
          last_seq?: string;
        } | null;
        const results = body?.results ?? [];
        // Apply the whole page first; reassemble THROWS on a missing leaf, aborting the round
        // before writeFile so no truncated body is written and the cursor is not advanced.
        for (const ch of results) {
          if (!ch.id.startsWith('f:')) continue;
          const path = pathOf(ch.id);
          if (ch.deleted || ch.doc?._deleted) {
            await this.files.remove(path);
            await this.state.dropRev(path);
            continue;
          }
          if (ch.doc) await this.writeFile(path, await this.reassemble(ch.doc));
        }
        // Page fully applied - only now advance (and persist) the cursor.
        if (body?.last_seq != null) await this.state.setCursor(body.last_seq);
        if (results.length < limit || body?.last_seq == null || body.last_seq === since) break;
      }
    } finally {
      this.pulling = false;
    }
  }

  private async writeFile(path: string, body: string): Promise<void> {
    if ((await this.files.read(path)) === body) return; // echo guard: already in sync
    this.suppress.add(path);
    try {
      await this.files.write(path, body);
    } finally {
      const t = setTimeout(() => this.suppress.delete(path), SUPPRESS_MS);
      (t as { unref?: () => void }).unref?.(); // do not keep the host process alive
    }
    // Cache the applied content rev so a later push does not echo it back to couch.
    await this.state.setRev(path, (await leafIdsOf(body)).join(','));
    this.log(`pull ${path}`);
  }

  // Retry every queued push, then pull. The periodic tick calls this so a dropped live push
  // is not lost. Resilient: a failing pull is logged, not thrown, so the next tick retries.
  async flushPending(): Promise<void> {
    for (const path of this.state.pendingPaths()) {
      try {
        await this.pushFile(path);
        await this.state.dequeue(path);
      } catch {
        /* keep queued for the next tick */
      }
    }
    for (const path of this.state.deletionPaths()) {
      try {
        await this.tombstone(path);
        await this.state.dequeueDeletion(path);
      } catch {
        /* keep queued for the next tick */
      }
    }
  }

  async tick(): Promise<void> {
    await this.flushPending();
    try {
      await this.pullOnce();
    } catch (e) {
      this.log(`pull failed (will retry): ${(e as Error).message}`);
    }
  }

  // Resilient like tick(): a push or pull failure is recorded, not thrown, so a one-shot sync
  // never rejects and the caller still learns which side failed.
  async syncNow(): Promise<SyncResult> {
    const out: SyncResult = { pushed: false, pulled: false };
    try {
      await this.pushAll();
      out.pushed = true;
    } catch (e) {
      out.error = (e as Error).message;
      this.log(`push failed (will retry): ${(e as Error).message}`);
    }
    try {
      await this.pullOnce();
      out.pulled = true;
    } catch (e) {
      out.error ??= (e as Error).message;
      this.log(`pull failed (will retry): ${(e as Error).message}`);
    }
    return out;
  }
}
