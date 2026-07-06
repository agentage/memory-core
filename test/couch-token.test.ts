import { describe, it, expect, vi } from 'vitest';
import { CouchTokenClient, parseCouchToken } from '../src/channel/couch-token.js';
import type { FetchLike, FetchResponse } from '../src/channel/http.js';

const ok = (jwt: string, expSec = 3600): FetchResponse => ({
  status: 200,
  json: async () => ({ success: true, data: { jwt, db: 'mem_abc', sub: 'u/work', expSec } }),
});

describe('parseCouchToken', () => {
  it('reads the { data } envelope and defaults expSec', () => {
    expect(parseCouchToken({ data: { jwt: 'j', db: 'd', sub: 's', expSec: 60 } })).toEqual({
      jwt: 'j',
      db: 'd',
      sub: 's',
      expSec: 60,
    });
    expect(parseCouchToken({ data: { jwt: 'j' } }).expSec).toBe(3600);
  });

  it('throws on a missing data object or jwt', () => {
    expect(() => parseCouchToken(null)).toThrow('missing data');
    expect(() => parseCouchToken({})).toThrow('missing data');
    expect(() => parseCouchToken({ data: {} })).toThrow('missing jwt');
  });
});

describe('CouchTokenClient - mint + cache + refresh', () => {
  const make = (
    fetchLike: FetchLike,
    bearer: string | null = 'oauth-bearer',
    now: () => number = () => 0
  ): CouchTokenClient =>
    new CouchTokenClient(
      'https://auth.x/account/couch-token',
      'work',
      fetchLike,
      async () => bearer,
      now
    );

  it('mints once and serves the cache within the skew window', async () => {
    const fetchLike = vi.fn<FetchLike>(async () => ok('jwt-1'));
    const c = make(fetchLike);
    expect(await c.token()).toBe('jwt-1');
    expect(await c.token()).toBe('jwt-1');
    expect(fetchLike).toHaveBeenCalledTimes(1);
    // The mint POSTs { memory } with the OAuth bearer, never a signed credential.
    expect(fetchLike).toHaveBeenCalledWith('https://auth.x/account/couch-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer oauth-bearer', 'Content-Type': 'application/json' },
      body: JSON.stringify({ memory: 'work' }),
    });
  });

  it('re-mints ~60s before expiry (skew) and again after invalidate()', async () => {
    let now = 0;
    let n = 0;
    const fetchLike = vi.fn<FetchLike>(async () => ok(`jwt-${++n}`, 100)); // exp = now + 100s
    const c = make(fetchLike, 'oauth-bearer', () => now);
    expect(await c.token()).toBe('jwt-1');
    now = 39_000; // still >60s before the 100s expiry -> cache
    expect(await c.token()).toBe('jwt-1');
    now = 41_000; // within 60s of expiry -> re-mint
    expect(await c.token()).toBe('jwt-2');
    c.invalidate(); // e.g. a 401 from CouchDB
    expect(await c.token()).toBe('jwt-3');
    expect(fetchLike).toHaveBeenCalledTimes(3);
  });

  it('throws a clear error on a 401 (the known server OAuth-bearer gap)', async () => {
    const fetchLike = vi.fn<FetchLike>(async () => ({ status: 401, json: async () => null }));
    await expect(make(fetchLike).token()).rejects.toThrow('unauthorized');
  });

  it('throws on other non-2xx and when not signed in', async () => {
    await expect(
      make(async () => ({ status: 503, json: async () => null })).token()
    ).rejects.toThrow('HTTP 503');
    await expect(make(async () => ok('j'), null).token()).rejects.toThrow('not signed in');
  });
});
