// A generic byte cache: opaque string keys, opaque byte values. This module
// knows ZERO engine semantics - no vault, doc, path or store type ever crosses
// this boundary (eslint no-restricted-imports on src/cache is the enforcement).
// Caches are disposable by construction: every miss must be survivable, so an
// implementation answers null rather than failing, and swallows write failures.

export interface Cache {
  get(key: string): Promise<Uint8Array | null>;
  // Best-effort: a full cache, a broken disk or an unstorable key are silent no-ops.
  set(key: string, value: Uint8Array): Promise<void>;
  // Sweeps every key whose string form starts with `prefix` ('' sweeps everything).
  delete(prefix: string): Promise<void>;
}

// Optional observability for the swallowed failures - counters, not control flow.
export type CacheErrorHook = (op: 'get' | 'set' | 'delete', key: string, err: unknown) => void;
