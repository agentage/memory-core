// Keyed store lifecycle - tenant-blind and storage-blind. Keys are OPAQUE: the
// host owns the key scheme and any security meaning (a server derives keys from
// auth-validated ids; a local client uses vault names; user-awareness never
// enters this package). `create` owns layout and store kind - git, memory,
// remote, sync-backed - anything passing the conformance kit.

import type { StoreEvent, VaultStore } from './vault-store.js';

export interface StorePoolOptions {
  create: (key: string) => VaultStore;
  // LRU cap on LIVE instances (a store is cheap state + caches; evicting one
  // loses nothing durable - it just rebuilds lazily on next resolve).
  maxOpen?: number;
  // Global event tap: every event from every pooled store, tagged with its key.
  onEvent?: (key: string, e: StoreEvent) => void;
}

export interface StorePool {
  get(key: string): VaultStore;
  has(key: string): boolean; // a live instance exists (NOT vault existence)
  evict(key?: string): void;
  keys(): string[];
  close(): void;
}

export const createStorePool = (opts: StorePoolOptions): StorePool => {
  const maxOpen = opts.maxOpen ?? 256;
  // Map preserves insertion order - re-set on access makes it an LRU.
  const live = new Map<string, { store: VaultStore; off: () => void }>();

  const drop = (key: string): void => {
    const entry = live.get(key);
    if (entry) {
      entry.off();
      live.delete(key);
    }
  };

  return {
    get(key: string): VaultStore {
      const cached = live.get(key);
      if (cached) {
        live.delete(key);
        live.set(key, cached); // refresh LRU position
        return cached.store;
      }
      const store = opts.create(key);
      const off = opts.onEvent
        ? store.subscribe((e) => opts.onEvent!(key, e))
        : (): void => undefined;
      live.set(key, { store, off });
      if (live.size > maxOpen) drop(live.keys().next().value!);
      return store;
    },

    has: (key: string): boolean => live.has(key),

    evict(key?: string): void {
      if (key !== undefined) return drop(key);
      for (const k of [...live.keys()]) drop(k);
    },

    keys: (): string[] => [...live.keys()],

    close(): void {
      for (const k of [...live.keys()]) drop(k);
    },
  };
};

// Seed a vault iff it has never held content - idempotent by construction and
// storage-agnostic (works on every VaultStore implementation).
export const provisionIfEmpty = async (
  store: VaultStore,
  files: ReadonlyArray<{ path: string; body: string }>
): Promise<{ created: boolean }> => {
  if ((await store.version()) !== null) return { created: false };
  for (const f of files) await store.write(f);
  return { created: true };
};
