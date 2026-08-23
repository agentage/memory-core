// Root facts, never exceptions: every shape a store root can be in - present,
// vanished, read-only, wrong-volume - comes back as a value a probe can report.

import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRoot, checkRootWritable } from '../../src/index.js';

const makeRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'root-health-'));

describe('checkRoot', () => {
  it('reports a reachable, writable root with real disk numbers', async () => {
    const root = await makeRoot();
    const facts = await checkRoot(root);
    expect(facts.reachable).toBe(true);
    expect(facts.writable).toBe(true);
    expect(facts.markerPresent).toBeNull(); // nothing was asked for
    expect(facts.diskTotalBytes).toBeGreaterThan(0);
    expect(facts.diskFreeBytes).toBeGreaterThan(0);
    expect(facts.diskFreeBytes).toBeLessThanOrEqual(facts.diskTotalBytes);
  });

  it('a vanished root is a fact - all false, zeros, no throw', async () => {
    const facts = await checkRoot(join(await makeRoot(), 'never-mounted'));
    expect(facts).toEqual({
      reachable: false,
      writable: false,
      markerPresent: null,
      diskFreeBytes: 0,
      diskTotalBytes: 0,
    });
    // a marker asked for on an unreachable root is absent, not unknown
    expect((await checkRoot('/definitely/not/here', { markerFile: '.volume' })).markerPresent).toBe(
      false
    );
    expect((await checkRoot('/definitely/not/here', { probeWrite: true })).writable).toBe(false);
  });

  it('a file where the root should be is not a root', async () => {
    const root = await makeRoot();
    const file = join(root, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');
    expect(await checkRoot(file)).toMatchObject({ reachable: false, writable: false });
  });

  it('reports a read-only root as reachable but not writable, both probe modes', async () => {
    const root = await makeRoot();
    const ro = join(root, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o500);
    try {
      expect(await checkRoot(ro)).toMatchObject({ reachable: true, writable: false });
      expect(await checkRoot(ro, { probeWrite: true })).toMatchObject({
        reachable: true,
        writable: false,
      });
      expect(await checkRootWritable(ro)).toEqual({ reachable: true, writable: false });
    } finally {
      await chmod(ro, 0o755);
    }
  });

  it('markerFile: present, absent, or never asked', async () => {
    const root = await makeRoot();
    expect((await checkRoot(root, { markerFile: '.volume' })).markerPresent).toBe(false);
    await writeFile(join(root, '.volume'), 'ok', 'utf8');
    expect((await checkRoot(root, { markerFile: '.volume' })).markerPresent).toBe(true);
    expect((await checkRoot(root)).markerPresent).toBeNull();
    // the marker is a fact ABOUT the root, never a gate on the rest of them
    expect(await checkRoot(root, { markerFile: 'missing' })).toMatchObject({
      reachable: true,
      writable: true,
      markerPresent: false,
    });
  });

  it('the default costs nothing on disk; probeWrite writes and cleans up', async () => {
    const root = await makeRoot();
    await checkRoot(root, { markerFile: '.volume' });
    expect(await readdir(root)).toEqual([]);
    expect(await checkRoot(root, { probeWrite: true })).toMatchObject({ writable: true });
    expect(await readdir(root)).toEqual([]); // the probe file never survives
  });
});

describe('checkRootWritable (the 1.x projection)', () => {
  it('reports reachable/writable honestly and nothing else', async () => {
    const root = await makeRoot();
    expect(await checkRootWritable(root)).toEqual({ reachable: true, writable: true });
    expect(await checkRootWritable(join(root, 'missing'))).toEqual({
      reachable: false,
      writable: false,
    });
  });
});
