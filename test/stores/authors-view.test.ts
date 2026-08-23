// What the conformance kit cannot state, because it is git's alone: the commit
// author IS the attribution record, so anything the kit asserts about `authors()`
// has to survive the round trip through a real address, a real clone and a real
// push from a real person.

import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBareGitStore } from '../../src/index.js';
import { clientAuthorOf, gitAuthorOf } from '../../src/stores/bare-git/commit.js';
import { externalCommit } from './external-git.js';

const newRepo = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'authors-view-')), 'vault.git');

describe('bare-git authors view', () => {
  it('reads back exactly what gitAuthorOf wrote', () => {
    const claude = { id: 'claude-desktop', name: 'Claude' };
    const address = gitAuthorOf(claude)!;
    expect(clientAuthorOf(address.name, address.email)).toEqual(claude);
    // The system identity every unattributed write carries is nobody's client.
    expect(clientAuthorOf('agentage memory', 'memory@agentage.io')).toBeUndefined();
    expect(clientAuthorOf('Ada', 'ada@example.com')).toBeUndefined();
  });

  it('an id the address cannot hold comes back sanitized, not invented', async () => {
    const store = createBareGitStore(await newRepo());
    await store.write({ path: 'a.md', body: 'x' }, { id: 'weird id/v1', name: 'Weird' });
    // Documented lossiness: the address is the record, so it is also the limit.
    expect((await store.authors())[0]!.author.id).toBe('weird-id-v1');
  });

  it('a push from a person adds history but no client', async () => {
    const dir = await newRepo();
    const store = createBareGitStore(dir);
    await store.write({ path: 'a.md', body: 'x' }, { id: 'claude', name: 'Claude' });
    const before = await store.authors();

    await externalCommit(dir, [{ path: 'pushed.md', content: 'from a laptop' }]);
    expect(await store.refresh()).toHaveLength(1);
    expect(await store.authors()).toEqual(before);
    expect((await store.describe()).files).toBe(2); // the commit did land
  });

  it('a clone of the repo answers the same, so history is the only record', async () => {
    const dir = await newRepo();
    const store = createBareGitStore(dir);
    await store.write({ path: 'a.md', body: 'x' }, { id: 'cursor', name: 'Cursor' });
    await store.write({ path: 'b.md', body: 'y' }, { id: 'cursor', name: 'Cursor' });
    await store.write({ path: 'c.md', body: 'z' }, { id: 'claude', name: 'Claude' });

    const clone = join(await mkdtemp(join(tmpdir(), 'authors-clone-')), 'clone.git');
    execFileSync('git', ['clone', '--bare', dir, clone]);
    expect(await createBareGitStore(clone).authors()).toEqual(await store.authors());
  });

  it('the latest write names the client, so a rename is picked up', async () => {
    const store = createBareGitStore(await newRepo());
    await store.write({ path: 'a.md', body: 'x' }, { id: 'claude', name: 'Claude 3' });
    await store.write({ path: 'b.md', body: 'y' }, { id: 'claude', name: 'Claude 4' });
    expect(await store.authors()).toEqual([
      { author: { id: 'claude', name: 'Claude 4' }, writes: 2, lastAt: expect.any(String) },
    ]);
  });

  it('costs one spawn cold and none warm, and moves with a write', async () => {
    let spawns: string[][] = [];
    const store = createBareGitStore(await newRepo(), { onSpawn: (a) => spawns.push(a) });
    await store.write({ path: 'a.md', body: 'x' }, { id: 'claude', name: 'Claude' });

    spawns = [];
    await store.authors();
    expect(spawns.map((a) => a[0])).toEqual(['log']);

    spawns = [];
    await store.authors();
    expect(spawns).toEqual([]);

    await store.write({ path: 'b.md', body: 'y' }, { id: 'claude', name: 'Claude' });
    spawns = [];
    expect((await store.authors())[0]!.writes).toBe(2);
    expect(spawns.map((a) => a[0])).toEqual(['log']);
  });
});
