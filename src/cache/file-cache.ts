// Disk cache: one flat file per key, written temp+rename so a reader never sees
// a half-written entry, and checksummed so a torn or rotted one reads as a miss
// instead of as wrong bytes. Construct ONCE per process per dir and share it -
// the dir is the state, so two instances over one dir are the same cache, and
// concurrent writers are safe by rename, not by locking.
//
// Entry layout: magic(8) | keyLen u32le | sha256(key||value)(32) | key | value.
// The value length is implied by the file length - the digest, not a stored
// count, is what proves an entry whole. The filename is sha256(key) hex, so every key -
// separators, `..`, `:`, `@`, unicode, 400 chars - lands on one safe flat name,
// and the key travels inside the file so a sweep and a restart can both read it.

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cache, CacheErrorHook } from './cache.js';

export interface FileCacheOptions {
  dir: string;
  onError?: CacheErrorHook;
}

const MAGIC = Buffer.from('ACACHE1\n', 'utf8');
const DIGEST_AT = MAGIC.length + 4;
const HEADER_BYTES = DIGEST_AT + 32;
const MAX_KEY_BYTES = 64 * 1024;
const ENTRY_NAME = /^[0-9a-f]{64}\.cache$/;

const isMissing = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const decode = (buf: Buffer): { key: string; value: Uint8Array } | null => {
  if (buf.length < HEADER_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const keyLen = buf.readUInt32LE(MAGIC.length);
  const body = buf.subarray(HEADER_BYTES);
  if (keyLen > body.length) return null; // corrupt length: the key cannot outrun the file
  if (!sha256(body).equals(buf.subarray(DIGEST_AT, HEADER_BYTES))) return null; // torn or rotted
  return {
    key: body.subarray(0, keyLen).toString('utf8'),
    value: new Uint8Array(body.subarray(keyLen)),
  };
};

export class FileCache implements Cache {
  readonly dir: string;
  readonly #onError: CacheErrorHook | undefined;
  #dirReady: Promise<void> | null = null;

  constructor(options: FileCacheOptions) {
    this.dir = options.dir;
    this.#onError = options.onError;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.#fileOf(key);
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch (err) {
      if (!isMissing(err)) this.#fail('get', key, err);
      return null;
    }
    const entry = decode(buf);
    if (entry && entry.key === key) return entry.value;
    // Corrupt, or another key's entry under a hash collision: never serve it, drop it.
    this.#fail('get', key, new Error(`unreadable cache entry: ${file}`));
    await rm(file, { force: true }).catch(() => {});
    return null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const keyBuf = Buffer.from(key, 'utf8');
    if (keyBuf.length > MAX_KEY_BYTES) return;
    const tmp = join(this.dir, `${randomUUID()}.tmp`);
    try {
      await this.#ensureDir();
      const body = Buffer.concat([keyBuf, value]);
      const header = Buffer.alloc(HEADER_BYTES);
      MAGIC.copy(header, 0);
      header.writeUInt32LE(keyBuf.length, MAGIC.length);
      sha256(body).copy(header, DIGEST_AT);
      await writeFile(tmp, Buffer.concat([header, body]));
      await rename(tmp, this.#fileOf(key)); // atomic swap: readers see old or new, never both
    } catch (err) {
      this.#fail('set', key, err);
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async delete(prefix: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (!isMissing(err)) this.#fail('delete', prefix, err);
      return;
    }
    await Promise.all(
      names
        .filter((name) => ENTRY_NAME.test(name))
        .map(async (name) => {
          const file = join(this.dir, name);
          try {
            // An entry whose key is unreadable is unreachable anyway - sweep it as garbage.
            const key = await this.#readKey(file);
            if (key === null || key.startsWith(prefix)) await rm(file, { force: true });
          } catch (err) {
            this.#fail('delete', prefix, err);
          }
        })
    );
  }

  #fileOf(key: string): string {
    return join(this.dir, `${sha256(Buffer.from(key, 'utf8')).toString('hex')}.cache`);
  }

  #ensureDir(): Promise<void> {
    this.#dirReady ??= mkdir(this.dir, { recursive: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        this.#dirReady = null; // a transient mkdir failure must not poison every later write
        throw err;
      });
    return this.#dirReady;
  }

  // Reads the header + key only: a sweep must not page multi-MB values into memory.
  // Never throws - an entry it cannot read is an entry nothing can read.
  async #readKey(file: string): Promise<string | null> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, 'r');
      const header = Buffer.alloc(HEADER_BYTES);
      const head = await handle.read(header, 0, HEADER_BYTES, 0);
      if (head.bytesRead < HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
        return null;
      }
      const keyLen = header.readUInt32LE(MAGIC.length);
      if (keyLen > MAX_KEY_BYTES) return null;
      const keyBuf = Buffer.alloc(keyLen);
      const body = await handle.read(keyBuf, 0, keyLen, HEADER_BYTES);
      return body.bytesRead < keyLen ? null : keyBuf.toString('utf8');
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }

  #fail(op: 'get' | 'set' | 'delete', key: string, err: unknown): void {
    this.#onError?.(op, key, err);
  }
}
