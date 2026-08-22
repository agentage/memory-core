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
} from './types.js';

// Every change - own verb or out-of-band (git push received, human file edit,
// pull) - surfaces as one StoreEvent. Observers are fire-and-forget: they run
// after the change persisted and can never fail or delay the operation.
export interface StoreEvent {
  type: 'write' | 'edit' | 'delete' | 'external';
  paths: string[];
  version: string;
  author?: WriteAuthor;
  at: string;
}

export type StoreObserver = (e: StoreEvent) => void;

export interface StoreCapabilities {
  mutable: boolean;
  // History exists and versions are durable (git: yes; in-memory: no).
  versioned: boolean;
  // Content can change outside this API (server: push; local: editor/pull).
  externallyMutable: boolean;
  search: 'lexical' | 'indexed' | 'none';
}

// THE contract. One instance = one vault. Storage-agnostic: git, remote HTTP,
// and in-memory stores all implement this same shape; swapping stores swaps
// search behavior with them. Multi-tenancy is a resolver above, never in here.
export interface VaultStore extends VaultReader, VaultWriter {
  // Opaque change token; null = empty vault. Changes iff content changed.
  version(): Promise<string | null>;
  // Detect out-of-band changes since the last seen version and emit them as
  // `external` events. No-op ([]) when nothing changed or nothing external can happen.
  refresh(): Promise<StoreEvent[]>;
  subscribe(obs: StoreObserver): () => void;
  capabilities(): StoreCapabilities;
}

// GUARANTEE: a null/[]/empty result here means definitively-not-found. Infra
// failure (binary missing, spawn kill, EACCES, timeout/byte-cap) throws
// StoreError('unavailable') with the cause attached - never a degraded answer.
export interface VaultReader {
  // clamp defaults to true (model-safe 64KB body budget); pass { clamp: false }
  // for full-body reads (REST note read, export flows).
  read(path: string, opts?: { clamp?: boolean }): Promise<MemoryView | null>;
  // Bulk read: element-wise identical to read() - same order, a null wherever
  // read() would answer null, same clamp - in ONE storage round trip instead of N.
  // The guarantee above still holds whole-call: an infra failure throws for the
  // batch rather than degrading any element to a null.
  readMany(paths: string[], opts?: { clamp?: boolean }): Promise<(MemoryView | null)[]>;
  // THE listing verb for every surface (MCP tool AND REST): a bounded folder
  // tree with truncation - never paginated (bounded-results contract, AC6).
  list(q: ListQuery): Promise<ListResult>;
  search(q: SearchQuery): Promise<SearchResult>;
  // Cheap storage facts for a vault card - product shapes (names, histograms) live in the host.
  describe(): Promise<VaultDescription>;
}

export interface VaultWriter {
  write(i: WriteInput, author?: WriteAuthor): Promise<WriteResult>;
  // Same guarantee as the reader: null/false = the doc is not there, and a store
  // that could not run the change throws StoreError('unavailable') instead.
  edit(i: EditInput, author?: WriteAuthor): Promise<WriteResult | null>;
  delete(path: string): Promise<boolean>;
}
