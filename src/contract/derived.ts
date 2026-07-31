// Generic derived data: any value computed from vault content (stats, overviews,
// mtime maps, indexes) cached by policy in a sidecar dir. Entries are stamped
// with the store version they were computed from, so a cache is disposable by
// construction - delete it any time, it rebuilds. Never lives inside the
// versioned content and never syncs.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoreEvent, VaultReader, VaultStore } from './vault-store.js';

export interface CachePolicy {
  // on-change: patched incrementally from events when `patch` exists, else lazily
  //   recomputed on next get after the version moved.
  // on-stale: recomputed on get when the version moved or ttlMs elapsed.
  // manual: recomputed only via recompute().
  recompute: 'on-change' | 'on-stale' | 'manual';
  ttlMs?: number;
}

export interface DerivedView<T> {
  name: string; // cache key, [a-z0-9-]
  policy: CachePolicy;
  // May use the reader or close over store-specific access - the cache only
  // owns freshness and persistence.
  compute(reader: VaultReader, version: string | null): Promise<T>;
  patch?(prev: T, e: StoreEvent, reader: VaultReader): Promise<T> | T;
}

export interface DerivedCache {
  get<T>(view: DerivedView<T>): Promise<T>;
  recompute<T>(view: DerivedView<T>): Promise<T>;
  invalidate(name?: string): Promise<void>;
  close(): void;
}

interface Entry {
  version: string | null;
  at: string;
  value: unknown;
}

const NAME_RE = /^[a-z0-9-]{1,64}$/;

export const createDerivedCache = (store: VaultStore, cacheDir: string): DerivedCache => {
  const entries = new Map<string, Entry>();
  const registered = new Map<string, DerivedView<unknown>>();

  const fileOf = (name: string): string => join(cacheDir, `${name}.json`);

  const load = async (name: string): Promise<Entry | undefined> => {
    const cached = entries.get(name);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await readFile(fileOf(name), 'utf8')) as Entry;
      if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) return undefined;
      entries.set(name, parsed);
      return parsed;
    } catch {
      return undefined; // absent or corrupt - both mean "recompute"
    }
  };

  const save = async (name: string, entry: Entry): Promise<void> => {
    entries.set(name, entry);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(fileOf(name), JSON.stringify(entry), 'utf8');
  };

  const register = (view: DerivedView<never>): void => {
    if (!NAME_RE.test(view.name))
      throw new Error(`invalid view name: ${JSON.stringify(view.name)}`);
    registered.set(view.name, view as DerivedView<unknown>);
  };

  const doCompute = async <T>(view: DerivedView<T>): Promise<T> => {
    const version = await store.version();
    const value = await view.compute(store, version);
    await save(view.name, { version, at: new Date().toISOString(), value });
    return value;
  };

  // on-change views with a patch stay fresh from the event stream; everyone else
  // goes stale (entry dropped from memory keeps the version stamp mismatched).
  const unsubscribe = store.subscribe((e) => {
    for (const view of registered.values()) {
      if (view.policy.recompute !== 'on-change' || !view.patch) continue;
      const entry = entries.get(view.name);
      if (!entry) continue;
      void Promise.resolve(view.patch(entry.value, e, store))
        .then((value) =>
          save(view.name, { version: e.version, at: new Date().toISOString(), value })
        )
        .catch(() => entries.delete(view.name)); // failed patch = stale, not wrong
    }
  });

  return {
    async get<T>(view: DerivedView<T>): Promise<T> {
      register(view as DerivedView<never>);
      const entry = await load(view.name);
      if (view.policy.recompute === 'manual') {
        return entry !== undefined ? (entry.value as T) : doCompute(view);
      }
      const current = await store.version();
      const ttlOk =
        !view.policy.ttlMs || Date.now() - Date.parse(entry?.at ?? '') < view.policy.ttlMs;
      if (entry && entry.version === current && ttlOk) return entry.value as T;
      return doCompute(view);
    },

    async recompute<T>(view: DerivedView<T>): Promise<T> {
      register(view as DerivedView<never>);
      return doCompute(view);
    },

    async invalidate(name?: string): Promise<void> {
      if (name) {
        entries.delete(name);
        await rm(fileOf(name), { force: true });
      } else {
        entries.clear();
        await rm(cacheDir, { recursive: true, force: true });
      }
    },

    close(): void {
      unsubscribe();
    },
  };
};
