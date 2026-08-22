// Patch-on-drift is only an optimization if it is INVISIBLE. After an arbitrary
// sequence of external pushes - adds, rewrites, deletes, renames, force-pushes
// backwards - a store that followed them must answer exactly like a store that
// opened the same repo afterwards and built its view from scratch. Where it
// cannot patch faithfully (a non-fast-forward move), it must rebuild, and the
// only way to tell the two apart is the spawn count.

import fc from 'fast-check';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBareGitStore, type VaultStore } from '../../src/index.js';
import { externalCommit, forceRef, runGit } from './external-git.js';

const RUNS = Number(process.env.FUZZ_DIFF_RUNS ?? 3);

const NOTES = ['a.md', 'work/b.md', 'work/deep/c.md'];

type Push =
  | { op: 'add'; path: string; body: string }
  | { op: 'remove'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'rewind' };

const pushArb: fc.Arbitrary<Push> = fc.oneof(
  fc.record({
    op: fc.constant('add' as const),
    path: fc.constantFrom(...NOTES, 'pushed.md', 'work/pushed.md'),
    // `seed` restores the content a note started with: the change then has no
    // diff against the snapshot's base at all, though the note did age.
    body: fc.constantFrom('alpha note', 'beta note', 'gamma note', 'seed'),
  }),
  fc.record({ op: fc.constant('remove' as const), path: fc.constantFrom(...NOTES, 'pushed.md') }),
  fc.record({
    op: fc.constant('rename' as const),
    from: fc.constantFrom(...NOTES),
    to: fc.constantFrom('moved.md', 'work/moved.md'),
  }),
  fc.record({ op: fc.constant('rewind' as const) })
);

const apply = async (
  repo: string,
  push: Push,
  origin: string,
  seed: Map<string, string>
): Promise<void> => {
  switch (push.op) {
    case 'add':
      await externalCommit(repo, [
        {
          path: push.path,
          content: push.body === 'seed' ? (seed.get(push.path) ?? 'x') : push.body,
        },
      ]);
      return;
    case 'remove':
      await externalCommit(repo, [{ path: push.path, remove: true }]);
      return;
    // One commit that deletes and adds - what a client reorganizing files sends.
    case 'rename':
      await externalCommit(repo, [
        { path: push.from, remove: true },
        { path: push.to, content: `moved from ${push.from}` },
      ]);
      return;
    // A force-push landing on an older commit: NOT a fast-forward.
    case 'rewind':
      await forceRef(repo, origin);
      return;
  }
};

// Everything a caller can observe about vault content, in one comparable value.
const observable = async (store: VaultStore): Promise<unknown> => ({
  root: await store.list({}),
  shallow: await store.list({ depth: 1 }),
  scoped: await store.list({ folder: 'work' }),
  tagged: await store.list({ tags: ['keep'] }),
  search: await store.search({ query: 'note', limit: 50 }),
  describe: await store.describe(),
  docs: await store.readMany([...NOTES, 'pushed.md', 'moved.md', 'work/moved.md']),
});

describe('bare-git-store: snapshot patch is indistinguishable from a rebuild', () => {
  it('any sequence of external pushes leaves a followed store equal to a fresh one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(pushArb, { minLength: 2, maxLength: 12 }),
        fc.boolean(),
        async (pushes, refreshEagerly) => {
          const dir = await mkdtemp(join(tmpdir(), 'snap-patch-'));
          const repo = join(dir, 'vault.git');
          const followed = createBareGitStore(repo);
          for (const path of NOTES) {
            await followed.write({ path, body: `${path} note`, frontmatter: { tags: ['keep'] } });
          }
          // Warm the snapshot from git BEFORE the pushes: from here on every
          // date in it came from history, so a rebuild must reproduce it exactly.
          await followed.list({});
          const origin = (await followed.version())!;
          const seed = new Map(
            await Promise.all(
              NOTES.map(
                async (p) => [p, await runGit(repo, ['cat-file', '-p', `${origin}:${p}`])] as const
              )
            )
          );

          for (const push of pushes) {
            await apply(repo, push, origin, seed);
            // Either the host polls (refresh) or the next verb finds the drift -
            // both must land in the same place.
            if (refreshEagerly) await followed.refresh();
          }

          const fresh = createBareGitStore(repo);
          expect(await observable(followed)).toEqual(await observable(fresh));
        }
      ),
      { numRuns: RUNS }
    );
  }, 240_000);

  // The case the ancestor check exists for: a divergent force-push whose DIFF
  // looks perfectly patchable, while a path it does not mention silently changes
  // age - the old branch touched it and the new one never did.
  it('a divergent force-push rebuilds, even when the diff looks patchable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snap-patch-divergent-'));
    const repo = join(dir, 'vault.git');
    const followed = createBareGitStore(repo);
    await followed.write({ path: 'a.md', body: 'v1' });
    await followed.list({}); // warm at the version that wrote a.md
    const origin = (await followed.version())!;

    // Touch a.md and put it straight back: content identical, history longer.
    await externalCommit(repo, [{ path: 'a.md', content: 'v2' }], 'bump', '2026-08-20T10:00:00Z');
    await externalCommit(repo, [{ path: 'a.md', content: 'v1' }], 'revert', '2026-08-20T11:00:00Z');
    await followed.refresh();

    // A sibling of the ORIGINAL commit: a.md is untouched there, so the diff
    // against it names only y.md - every changed path dates cleanly.
    await forceRef(repo, origin);
    await externalCommit(repo, [{ path: 'y.md', content: 'y' }], 'sibling', '2026-08-20T12:00:00Z');

    const fresh = createBareGitStore(repo);
    expect(await followed.list({})).toEqual(await fresh.list({}));
    expect(await followed.describe()).toEqual(await fresh.describe());
  });

  it('a fast-forward push patches (no rebuild), a rewind rebuilds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snap-patch-cost-'));
    const repo = join(dir, 'vault.git');
    const spawns: string[][] = [];
    const store = createBareGitStore(repo, { onSpawn: (a) => spawns.push(a) });
    await store.write({ path: 'a.md', body: 'alpha' });
    await store.write({ path: 'work/b.md', body: 'beta' });
    await store.list({}); // warm
    const origin = (await store.version())!;

    await externalCommit(repo, [{ path: 'pushed.md', content: 'pushed' }]);
    spawns.length = 0;
    await store.refresh();
    await store.list({});
    // diff + is-ancestor + range log, and the listing itself costs nothing.
    expect(spawns.map((a) => a[0])).toEqual(['diff', 'merge-base', 'log']);
    expect((await store.list({})).files).toBe(3);

    await forceRef(repo, origin); // not a descendant: the range cannot date it
    spawns.length = 0;
    await store.refresh();
    await store.list({});
    expect(spawns.map((a) => a[0])).toContain('ls-tree'); // full rebuild
    expect((await store.list({})).files).toBe(2);
  });
});
