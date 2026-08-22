// Property-based + differential fuzzing. PR tier runs modest counts; nightly
// raises FUZZ_RUNS / FUZZ_DIFF_RUNS. Pure properties pin the security-critical
// primitives with oracles; the differential block replays random op sequences
// against the memory store and the bare-git store and demands identical
// observable behavior - the conformance kit's guarantee, machine-generated.

import fc from 'fast-check';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clampBody,
  countOccurrences,
  createBareGitStore,
  createMemoryStore,
  parseDoc,
  safePath,
  serializeDoc,
  strReplace,
  type VaultStore,
} from '../../src/index.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 75);
const DIFF_RUNS = Number(process.env.FUZZ_DIFF_RUNS ?? 3);

describe('fuzz: pure properties', () => {
  it('safePath never lets a path escape the root or touch reserved dirs', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (p) => {
        if (!safePath(p)) return true;
        const resolved = normalize(join('/vault-root', p));
        if (!resolved.startsWith(`/vault-root${sep}`) && resolved !== '/vault-root') return false;
        if (isAbsolute(p)) return false;
        const segs = normalize(p).split(sep);
        return !segs.some((s) => ['.git', '.agentage', '..'].includes(s.toLowerCase()));
      }),
      { numRuns: RUNS * 4 }
    );
  });

  it('doc codec round-trips arbitrary frontmatter + body', () => {
    const fmArb = fc.dictionary(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,15}$/),
      fc.oneof(
        fc.string({ maxLength: 40 }),
        fc.integer(),
        fc.boolean(),
        fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 })
      ),
      { maxKeys: 6 }
    );
    const bodyArb = fc.string({ maxLength: 300 }).filter((b) => !b.startsWith('---'));
    fc.assert(
      fc.property(fmArb, bodyArb, (fm, body) => {
        const parsed = parseDoc(serializeDoc(fm, body));
        expect(parsed.body).toBe(body);
        expect(parsed.frontmatter).toEqual(fm);
      }),
      { numRuns: RUNS }
    );
  });

  it('strReplace splices exactly at a unique needle (oracle)', () => {
    const part = fc.string({ maxLength: 40 });
    const needle = fc.string({ minLength: 1, maxLength: 10 });
    fc.assert(
      fc.property(part, needle, part, fc.string({ maxLength: 20 }), (a, n, c, replacement) => {
        const body = a + n + c;
        fc.pre(
          body.indexOf(n) === a.length && body.indexOf(n, a.length + 1) === -1 // unique, at the seam
        );
        expect(strReplace(body, 'f.md', n, replacement)).toBe(a + replacement + c);
      }),
      { numRuns: RUNS }
    );
  });

  it('countOccurrences agrees with the split oracle', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (text, q) => {
          const oracle = text.toLowerCase().split(q.toLowerCase()).length - 1;
          expect(countOccurrences(text, q)).toBe(oracle);
        }
      ),
      { numRuns: RUNS * 2 }
    );
  });

  it('clampBody: bounded, truncation-flagged, always a prefix', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.integer({ min: 8, max: 128 }), (body, max) => {
        const res = clampBody(body, max);
        expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThanOrEqual(max);
        expect(res.truncated).toBe(Buffer.byteLength(body, 'utf8') > max);
        expect(body.startsWith(res.body)).toBe(true);
      }),
      { numRuns: RUNS * 2 }
    );
  });
});

// Random op sequences: memory store and bare-git store must be indistinguishable.
describe('fuzz: differential (memory vs bare-git)', () => {
  const paths = ['a.md', 'b.md', 'sub/c.md'];
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  type Op =
    | { op: 'write'; path: string; body: string }
    | { op: 'edit'; path: string; mode: 'replace' | 'append'; body: string }
    | { op: 'delete'; path: string }
    | { op: 'read'; path: string }
    | { op: 'readMany'; paths: string[] }
    | { op: 'search'; q: string };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      op: fc.constant('write' as const),
      path: fc.constantFrom(...paths),
      body: fc
        .array(fc.constantFrom(...words), { minLength: 1, maxLength: 5 })
        .map((w) => w.join(' ')),
    }),
    fc.record({
      op: fc.constant('edit' as const),
      path: fc.constantFrom(...paths),
      mode: fc.constantFrom('replace' as const, 'append' as const),
      body: fc.constantFrom(...words),
    }),
    fc.record({ op: fc.constant('delete' as const), path: fc.constantFrom(...paths) }),
    fc.record({ op: fc.constant('read' as const), path: fc.constantFrom(...paths) }),
    fc.record({
      op: fc.constant('readMany' as const),
      // Misses, duplicates and hostile paths in one batch - all in-place nulls.
      paths: fc.array(fc.constantFrom(...paths, 'gone.md', '../escape.md'), { maxLength: 5 }),
    }),
    fc.record({ op: fc.constant('search' as const), q: fc.constantFrom(...words) })
  );

  const run = async (store: VaultStore, op: Op): Promise<unknown> => {
    try {
      switch (op.op) {
        case 'write':
          return { w: (await store.write({ path: op.path, body: op.body })).path };
        case 'edit': {
          const r = await store.edit({ path: op.path, mode: op.mode, body: op.body });
          return { e: r?.path ?? null };
        }
        case 'delete':
          return { d: await store.delete(op.path) };
        case 'read': {
          const v = await store.read(op.path);
          return v ? { body: v.body, tags: v.tags, fm: v.frontmatter } : null;
        }
        case 'readMany': {
          const vs = await store.readMany(op.paths);
          return vs.map((v) => (v ? { body: v.body, tags: v.tags, fm: v.frontmatter } : null));
        }
        case 'search': {
          // Compare rank-relevant fields with a store-independent order: `updated`
          // precision differs by store kind (git = seconds, memory = ms), so
          // recency tie-order across stores is legitimately unspecified.
          const rs = (await store.search({ query: op.q, limit: 10 })).results.map((r) => ({
            path: r.path,
            score: r.score,
          }));
          return rs.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        }
      }
    } catch (err) {
      return { threw: err instanceof Error ? err.message : String(err) };
    }
  };

  it('any op sequence yields identical observable behavior', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 15 }), async (ops) => {
        const mem = createMemoryStore();
        const dir = await mkdtemp(join(tmpdir(), 'fuzz-diff-'));
        const git = createBareGitStore(join(dir, 'v.git'));
        for (const op of ops) {
          const [a, b] = await Promise.all([run(mem, op), run(git, op)]);
          expect(b, JSON.stringify(op)).toEqual(a);
        }
        expect((await git.list({})).files).toBe((await mem.list({})).files);
      }),
      { numRuns: DIFF_RUNS }
    );
  }, 240_000);
});
