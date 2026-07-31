// End-to-end lifecycle over a real bare repo: the full chain a production vault
// goes through - provision, search, edit, out-of-band push, event-driven derived
// state, delete, restart. Each step asserts the REQUIREMENT, not the mechanism.

import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createDerivedCache,
  createStatsView,
  validateBareRepoTree,
  type StoreEvent,
} from '../../src/index.js';

const sh = (args: string[], env: Record<string, string>, input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile('git', args, { env: { ...process.env, ...env } }, (e, so) =>
      e ? reject(e) : resolve(so)
    );
    if (input !== undefined) child.stdin?.end(input);
  });

describe('e2e: one vault, full life', () => {
  it('write -> search -> edit -> push -> events -> stats -> delete -> restart', async () => {
    const base = await mkdtemp(join(tmpdir(), 'e2e-'));
    const repo = join(base, 'user1', 'main.git');
    const store = createBareGitStore(repo);
    const events: StoreEvent[] = [];
    store.subscribe((e) => events.push(e));
    const cache = createDerivedCache(store, join(base, '.cache'));
    const stats = createStatsView(repo);

    // 1. Provision: a client writes notes with attribution.
    await store.write(
      { path: 'inbox/idea.md', body: 'A galaxy of notes #seed', frontmatter: { tags: ['inbox'] } },
      { id: 'claude-desktop', name: 'Claude' }
    );
    await store.write({ path: 'work/plan.md', body: 'plan the galaxy rollout' });

    // 2. Search finds both, ranked; the connected client is in git history.
    const found = await store.search({ query: 'galaxy', limit: 10 });
    expect(found.results).toHaveLength(2);
    const authors = await sh(['log', '--format=%ae'], { GIT_DIR: repo });
    expect(authors).toContain('claude-desktop@clients.agentage.io');

    // 3. Edit with the canonical str_replace contract.
    await store.edit({
      path: 'work/plan.md',
      mode: 'str_replace',
      old_str: 'rollout',
      new_str: 'launch',
    });
    expect((await store.read('work/plan.md'))!.body).toBe('plan the galaxy launch');

    // 4. A device pushes out-of-band (sync). The store surfaces it as an event.
    const env = {
      GIT_DIR: repo,
      GIT_AUTHOR_NAME: 'dev',
      GIT_AUTHOR_EMAIL: 'd@x',
      GIT_COMMITTER_NAME: 'dev',
      GIT_COMMITTER_EMAIL: 'd@x',
    };
    const blob = (await sh(['hash-object', '-w', '--stdin'], env, 'pushed note')).trim();
    const parent = (await sh(['rev-parse', 'refs/heads/main'], env)).trim();
    const idx = join(base, 'idx');
    await sh(['read-tree', parent], { ...env, GIT_INDEX_FILE: idx });
    await sh(['update-index', '--add', '--cacheinfo', `100644,${blob},from-device.md`], {
      ...env,
      GIT_INDEX_FILE: idx,
    });
    const tree = (await sh(['write-tree'], { ...env, GIT_INDEX_FILE: idx })).trim();
    const commit = (await sh(['commit-tree', tree, '-m', 'push', '-p', parent], env)).trim();
    await sh(['update-ref', 'refs/heads/main', commit], env);

    const external = await store.refresh();
    expect(external).toHaveLength(1);
    expect(external[0]!.paths).toEqual(['from-device.md']);
    expect((await store.read('from-device.md'))!.body).toBe('pushed note');

    // 5. The pushed tree passes the security gate.
    expect(await validateBareRepoTree(repo)).toEqual([]);

    // 6. Derived stats reflect everything, from the same event stream.
    expect(await cache.get(stats)).toMatchObject({ files: 3, empty: false });

    // 7. Delete is recoverable (history keeps the note).
    await store.delete('inbox/idea.md');
    expect(await store.read('inbox/idea.md')).toBeNull();
    expect(await cache.get(stats)).toMatchObject({ files: 2 });

    // 8. Restart: a brand-new instance agrees on everything.
    const reopened = createBareGitStore(repo);
    expect(await reopened.version()).toBe(await store.version());
    expect((await reopened.search({ query: 'galaxy', limit: 10 })).results).toHaveLength(1);
    expect((await reopened.list({})).files).toBe(2);

    // 9. The event log told the whole story in order.
    expect(events.map((e) => e.type)).toEqual(['write', 'write', 'edit', 'external', 'delete']);
  }, 60_000);
});
