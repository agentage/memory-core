// Router fixtures: a real temp root + fixed-clock in-memory stores, so two
// identically-seeded worlds compare by value, plus a container spy every proof
// reads - purity (no calls at construction) and containment (which vaults were
// ever opened) are both statements about that call log.

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createMemoryStore,
  createVaultContainer,
  ObjectCache,
  type Access,
  type SeedFile,
  type VaultContainer,
  type VaultStore,
} from '../../src/index.js';

export const NOW = '2026-08-19T00:00:00.000Z';

export const access = (over: Partial<Access> = {}): Access => ({
  userId: 'alice01',
  vaults: new Set(['main']),
  canCreate: false,
  canDelete: false,
  ...over,
});

export interface World {
  root: string;
  container: VaultContainer;
  access: Access;
  // Every container call in order ('list', 'open:<vault>'), and the vaults that
  // actually yielded a store.
  calls: string[];
  opened: string[];
  reset(): void;
  // Bypasses the spy and the grant - the oracle side of a comparison.
  direct(vault: string): Promise<VaultStore>;
  files(vault: string): Promise<number>;
}

export interface WorldOptions {
  over?: Partial<Access>;
  // Per-vault `updated` stamps, consumed in seed order; the last one sticks.
  clocks?: Record<string, string[]>;
}

export const world = async (
  seeds: Record<string, ReadonlyArray<SeedFile>>,
  opts: WorldOptions = {}
): Promise<World> => {
  const root = await mkdtemp(join(tmpdir(), 'router-'));
  const a = access(opts.over);
  const queues = new Map(Object.entries(opts.clocks ?? {}).map(([v, s]) => [v, [...s]]));

  const real = createVaultContainer({
    root,
    store: (dir): VaultStore => {
      const vault = basename(dir, '.git');
      const queue = queues.get(vault) ?? [];
      let last = NOW;
      const now = (): string => {
        last = queue.shift() ?? last;
        return last;
      };
      return createMemoryStore(seeds[vault] ?? [], { now });
    },
    provision: async (dir): Promise<void> => {
      await mkdir(dir, { recursive: true });
    },
    cache: new ObjectCache<VaultStore>({ max: 16 }),
  });

  // Provisioning is privileged and out of the router's reach - seed with a grant
  // wide enough to also create the vaults the router must NOT be able to touch.
  const god: Access = { userId: a.userId, vaults: '*', canCreate: true, canDelete: true };
  for (const vault of Object.keys(seeds)) await real.create(god, vault);

  const calls: string[] = [];
  const opened: string[] = [];
  const container: VaultContainer = {
    async list(who) {
      calls.push('list');
      return real.list(who);
    },
    async open(who, vault) {
      calls.push(`open:${vault}`);
      const store = await real.open(who, vault);
      opened.push(vault);
      return store;
    },
    create(who, vault) {
      calls.push(`create:${vault}`);
      return real.create(who, vault);
    },
    remove(who, vault, stamp) {
      calls.push(`remove:${vault}`);
      return real.remove(who, vault, stamp);
    },
  };

  return {
    root,
    container,
    access: a,
    calls,
    opened,
    reset(): void {
      calls.length = 0;
      opened.length = 0;
    },
    direct: (vault) => real.open(god, vault),
    files: async (vault) => (await (await real.open(god, vault)).describe()).files,
  };
};

// A container that fails on contact: anything the router does at bind time shows up.
export const hostileContainer = (
  calls: string[]
): { container: VaultContainer; calls: string[] } => {
  const boom = (what: string): never => {
    calls.push(what);
    throw new Error('container touched');
  };
  return {
    calls,
    container: {
      list: async () => boom('list'),
      open: async (_who, vault) => boom(`open:${vault}`),
      create: async (_who, vault) => boom(`create:${vault}`),
      remove: async (_who, vault) => boom(`remove:${vault}`),
    },
  };
};
