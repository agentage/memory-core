// Client-side VaultStore over the JSON wire (createStoreHandler is the server
// half). Verbs proxy 1:1; events emitted server-side during an operation come
// back in the response and re-emit locally, so hooks/derived caches on the
// client see the same stream they would see in-process.

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

export interface RemoteStoreOptions {
  timeoutMs?: number;
}

export const createRemoteStore = (
  baseUrl: string,
  token: string,
  opts: RemoteStoreOptions = {}
): VaultStore => {
  const observers = new Set<StoreObserver>();

  const emit = (events: StoreEvent[]): void => {
    for (const e of events) {
      for (const obs of observers) {
        try {
          obs(e);
        } catch {
          // observers never break the store
        }
      }
    }
  };

  const call = async <T>(verb: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    const payload = (await res.json()) as {
      value?: T;
      events?: StoreEvent[];
      error?: { message: string };
    };
    if (!res.ok || payload.error) {
      throw new Error(payload.error?.message ?? `remote store: HTTP ${res.status}`);
    }
    if (payload.events?.length) emit(payload.events);
    return payload.value as T;
  };

  return {
    read: (path: string, opts?: { clamp?: boolean }): Promise<MemoryView | null> =>
      call('read', { path, opts }),
    list: (query: ListQuery): Promise<ListResult> => call('list', { query }),
    listNotes: (query?: ListNotesQuery): Promise<ListNotesResult> => call('listNotes', { query }),
    search: (query: SearchQuery): Promise<SearchResult> => call('search', { query }),
    write: (input: WriteInput, author?: WriteAuthor): Promise<WriteResult> =>
      call('write', { input, author }),
    edit: (input: EditInput, author?: WriteAuthor): Promise<WriteResult | null> =>
      call('edit', { input, author }),
    delete: (path: string): Promise<boolean> => call('delete', { path }),
    version: (): Promise<string | null> => call('version'),
    refresh: (): Promise<StoreEvent[]> => call('refresh'),

    subscribe(obs: StoreObserver): () => void {
      observers.add(obs);
      return () => observers.delete(obs);
    },

    capabilities() {
      // The server-side store enforces behavior; the client declares the honest
      // superset: content can always change out-of-band from the client's view.
      return {
        mutable: true,
        versioned: true,
        externallyMutable: true,
        search: 'lexical' as const,
      };
    },
  };
};
