// Per-(host, memory) sync state, persisted through an injected persistence seam (the CLI
// backs it with a JSON file; the obsidian plugin backed it with saveData). Holds the
// resumable pull cursor (so a restart does not re-pull from seq 0), the path -> content-rev
// map (so an unchanged push skips the network), and the pending-push set (paths whose live
// push failed, retried on the next tick). Every real mutation persists; a no-op skips the write.

export interface CouchSyncState {
  cursor: string;
  revs: Record<string, string>;
  pending: string[];
}

// The durable store. `load` returns the last saved snapshot (null on first run); `save`
// records a full snapshot. Injected so the class is pure in tests.
export interface CouchStatePersistence {
  load(): Promise<CouchSyncState | null>;
  save(state: CouchSyncState): Promise<void>;
}

export type SaveCouchState = (state: CouchSyncState) => Promise<void>;

export class CouchState {
  private cursor: string;
  private readonly revs: Map<string, string>;
  private readonly pending: Set<string>;

  constructor(
    loaded: CouchSyncState | null,
    private readonly save: SaveCouchState
  ) {
    const s: Partial<CouchSyncState> = loaded ?? {};
    this.cursor = s.cursor ?? '0';
    this.revs = new Map(Object.entries(s.revs ?? {}));
    this.pending = new Set(s.pending ?? []);
  }

  getCursor(): string {
    return this.cursor;
  }
  async setCursor(seq: string): Promise<void> {
    if (seq === this.cursor) return;
    this.cursor = seq;
    await this.persist();
  }

  revFor(path: string): string | undefined {
    return this.revs.get(path);
  }
  async setRev(path: string, rev: string): Promise<void> {
    if (this.revs.get(path) === rev) return;
    this.revs.set(path, rev);
    await this.persist();
  }
  async dropRev(path: string): Promise<void> {
    if (this.revs.delete(path)) await this.persist();
  }

  pendingPaths(): string[] {
    return [...this.pending];
  }
  async enqueue(path: string): Promise<void> {
    if (this.pending.has(path)) return;
    this.pending.add(path);
    await this.persist();
  }
  async dequeue(path: string): Promise<void> {
    if (this.pending.delete(path)) await this.persist();
  }

  private async persist(): Promise<void> {
    await this.save({
      cursor: this.cursor,
      revs: Object.fromEntries(this.revs),
      pending: [...this.pending],
    });
  }
}

// Load the persisted snapshot and build a CouchState bound to the same store. Await this
// once per (host, memory); a later call re-reads the store, modelling a process restart.
export async function createCouchState(persistence: CouchStatePersistence): Promise<CouchState> {
  const loaded = await persistence.load();
  return new CouchState(loaded, (state) => persistence.save(state));
}
