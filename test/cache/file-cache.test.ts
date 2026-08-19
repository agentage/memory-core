// FileCache: the shared cache contract plus the failure modes only a disk-backed
// cache has - torn writes, bit rot, restarts, and keys no filesystem accepts raw.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileCache } from '../../src/index.js';
import { bytes, cacheSuite, same } from './cache-suite.js';

const makeDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'store-core-cache-'));

cacheSuite({ name: 'FileCache', make: async () => new FileCache({ dir: await makeDir() }) });

const entryFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.endsWith('.cache'));

const onlyEntry = async (dir: string): Promise<string> => {
  const files = await entryFiles(dir);
  expect(files).toHaveLength(1);
  return join(dir, files[0]!);
};

describe('FileCache: durability', () => {
  let dir: string;
  let errors: { op: string; key: string }[];
  let cache: FileCache;

  beforeEach(async () => {
    dir = await makeDir();
    errors = [];
    cache = new FileCache({ dir, onError: (op, key) => errors.push({ op, key }) });
  });

  it('returns null for a torn (truncated) entry and unlinks it', async () => {
    await cache.set('k/1', bytes('a value worth keeping'));
    const file = await onlyEntry(dir);
    const before = await stat(file);
    await truncate(file, Math.floor(before.size / 2));

    expect(await cache.get('k/1')).toBeNull();
    expect(await entryFiles(dir)).toHaveLength(0); // corrupt entries are swept on read
    expect(await cache.get('k/1')).toBeNull();
    expect(errors.map((e) => e.op)).toContain('get');
  });

  it('returns null when a stored byte flips (checksum mismatch)', async () => {
    await cache.set('k/1', bytes('the quick brown fox'));
    const file = await onlyEntry(dir);
    const raw = await readFile(file);
    const at = raw.length - 3; // a byte inside the value region
    raw.writeUInt8(raw.readUInt8(at) ^ 0xff, at);
    await writeFile(file, raw);

    expect(await cache.get('k/1')).toBeNull();
    expect(await entryFiles(dir)).toHaveLength(0);
  });

  it('returns null for a garbage file that merely looks like an entry', async () => {
    await cache.set('k/1', bytes('v'));
    const file = await onlyEntry(dir);
    await writeFile(file, Buffer.alloc(200, 0x41));
    expect(await cache.get('k/1')).toBeNull();
  });

  it('returns null for an entry truncated to a bare header', async () => {
    await cache.set('k/1', bytes('a value worth keeping'));
    await truncate(await onlyEntry(dir), 44); // header only: the key now outruns the file
    expect(await cache.get('k/1')).toBeNull();
  });

  it('returns null for a well-formed entry stored under another key name', async () => {
    await cache.set('k/1', bytes('one'));
    const raw = await readFile(await onlyEntry(dir));
    const other = createHash('sha256').update('k/2', 'utf8').digest('hex');
    await writeFile(join(dir, `${other}.cache`), raw); // the key inside says k/1
    expect(await cache.get('k/2')).toBeNull();
    expect(same(await cache.get('k/1'), bytes('one'))).toBe(true);
  });

  it('returns null for a corrupt entry even with no error hook attached', async () => {
    await cache.set('k/1', bytes('v'));
    await writeFile(await onlyEntry(dir), Buffer.alloc(80, 0x41));
    expect(await new FileCache({ dir }).get('k/1')).toBeNull();
  });

  it('returns null for a zero-length entry file', async () => {
    await cache.set('k/1', bytes('v'));
    await writeFile(await onlyEntry(dir), Buffer.alloc(0));
    expect(await cache.get('k/1')).toBeNull();
  });

  it('sees prior entries after a restart over the same dir', async () => {
    await cache.set('a/1', bytes('one'));
    await cache.set('a/2', bytes('two'));
    await cache.set('b/1', bytes('three'));

    const restarted = new FileCache({ dir });
    expect(same(await restarted.get('a/1'), bytes('one'))).toBe(true);
    expect(same(await restarted.get('b/1'), bytes('three'))).toBe(true);

    await restarted.delete('a/');
    const again = new FileCache({ dir });
    expect(await again.get('a/1')).toBeNull();
    expect(await again.get('a/2')).toBeNull();
    expect(same(await again.get('b/1'), bytes('three'))).toBe(true);
  });

  it('encodes fs-unsafe keys into flat safe filenames and round-trips them', async () => {
    const hostile = [
      '../../etc/passwd',
      'user@host:path/to/thing',
      'C:\\windows\\system32',
      'a/b/c/d/e',
      'spaces and "quotes"',
      'уникод/日本語/🔥',
      '.',
      '..',
      '.hidden',
      '/leading/slash',
      'trailing/',
      `${'x'.repeat(400)}/long`,
    ];
    for (const key of hostile) await cache.set(key, bytes(`v:${key}`));
    for (const key of hostile) expect(same(await cache.get(key), bytes(`v:${key}`))).toBe(true);

    const names = await readdir(dir);
    expect(names).toHaveLength(hostile.length);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{64}\.cache$/);
  });

  it('leaves no temp files behind', async () => {
    await Promise.all([cache.set('a', bytes('1')), cache.set('b', bytes('2'))]);
    const names = await readdir(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toHaveLength(0);
    expect(names).toHaveLength(2);
  });

  it('leaves foreign files in the dir untouched by a sweep', async () => {
    await cache.set('a/1', bytes('one'));
    await writeFile(join(dir, 'README.txt'), 'not mine');
    await cache.delete('');
    expect(await readdir(dir)).toEqual(['README.txt']);
  });

  it('purges unreadable entry files during any sweep', async () => {
    await cache.set('a/1', bytes('one'));
    await writeFile(await onlyEntry(dir), Buffer.alloc(10, 0x41));
    await cache.delete('no-such-prefix/');
    expect(await entryFiles(dir)).toHaveLength(0);
  });

  it('sweeps entries whose header lies about the key length', async () => {
    const forged = (keyLen: number, name: string): Promise<void> => {
      const header = Buffer.alloc(44);
      Buffer.from('ACACHE1\n', 'utf8').copy(header, 0);
      header.writeUInt32LE(keyLen, 8);
      return writeFile(join(dir, `${name.repeat(64)}.cache`), Buffer.concat([header, bytes('sh')]));
    };
    await forged(0x0fffffff, '0'); // longer than any cache would ever allocate
    await forged(1000, 'a'); // plausible, but the file is 2 bytes long

    await cache.delete('');
    expect(await entryFiles(dir)).toHaveLength(0);
  });

  it('reports nothing when sweeping a cache dir that was never created', async () => {
    const fresh = new FileCache({
      dir: join(dir, 'not-yet'),
      onError: (op, key) => errors.push({ op, key }),
    });
    await expect(fresh.delete('')).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('never throws on a directory masquerading as an entry file', async () => {
    await cache.set('a/1', bytes('one'));
    await mkdir(join(dir, `${'1'.repeat(64)}.cache`));
    await expect(cache.delete('')).resolves.toBeUndefined();
    expect(await cache.get('a/1')).toBeNull(); // the real entry was still swept
    expect(errors.map((e) => e.op)).toContain('delete');
  });

  it('never throws when the cache dir cannot exist, and reports it', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'i am a file');
    const broken = new FileCache({
      dir: join(blocker, 'nested'),
      onError: (op, key) => errors.push({ op, key }),
    });

    await expect(broken.set('k', bytes('v'))).resolves.toBeUndefined();
    expect(await broken.get('k')).toBeNull();
    await expect(broken.delete('')).resolves.toBeUndefined();
    expect(errors.map((e) => e.op)).toContain('set');
  });

  it('does not report a plain miss as an error', async () => {
    expect(await cache.get('never-written')).toBeNull();
    await cache.delete('never-written');
    expect(errors).toEqual([]);
  });

  it('silently refuses a key too large to store', async () => {
    await cache.set('x'.repeat(200_000), bytes('v'));
    expect(await cache.get('x'.repeat(200_000))).toBeNull();
    expect(await entryFiles(dir)).toHaveLength(0);
  });

  it('creates the cache dir lazily on first write', async () => {
    const nested = new FileCache({ dir: join(dir, 'deep', 'nested') });
    expect(await nested.get('k')).toBeNull();
    await nested.set('k', bytes('v'));
    expect(same(await nested.get('k'), bytes('v'))).toBe(true);
  });
});
