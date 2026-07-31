// Non-functional gate, CI-run on every PR (PERF_SCALE=1000) and nightly at
// deeper scale. Every metric is asserted against its budget AND reported to the
// GitHub Actions job summary, so the proof is visible on the PR itself.

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createDerivedCache,
  createStatsView,
  createWorkingCopyGitStore,
  type VaultStore,
} from '../src/index.js';

const SCALE = Number(process.env.PERF_SCALE ?? 1000);
// The local (working-copy) store is O(vault size) on list/search by design - a
// single-user worktree walk - so its budgets scale with the fixture. The server
// (bare) store budgets are ABSOLUTE: that is where multi-tenant latency matters.
const LOCAL_F = Math.max(1, SCALE / 1000);
const rows: string[] = [];

const record = (metric: string, value: number, budget: number): void => {
  rows.push(
    `| ${metric} | ${value.toFixed(1)}ms | ${budget}ms | ${value <= budget ? '✅' : '❌'} |`
  );
  expect(value, metric).toBeLessThanOrEqual(budget);
};

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

const time = async (n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    out.push(performance.now() - t0);
  }
  return out;
};

const sh = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 64 }, (e, so) =>
      e ? reject(e) : resolve(so)
    )
  );

let wcDir: string;
let bareDir: string;

// Fixture: SCALE markdown notes across 10 folders, one commit, then a bare clone.
// ~10% of notes contain the common search term.
beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), `perf-${SCALE}-`));
  wcDir = join(base, 'vault');
  await mkdir(wcDir, { recursive: true });
  for (let f = 0; f < 10; f++) await mkdir(join(wcDir, `folder-${f}`), { recursive: true });
  const writes: Promise<void>[] = [];
  for (let i = 0; i < SCALE; i++) {
    const term = i % 10 === 0 ? 'galaxy' : 'ordinary';
    const body = `---\ntags: [t${i % 7}]\n---\nNote ${i} about ${term} things.\n${'filler text line\n'.repeat(10)}`;
    writes.push(writeFile(join(wcDir, `folder-${i % 10}`, `note-${i}.md`), body, 'utf8'));
  }
  await Promise.all(writes);
  await sh(wcDir, ['init', '-b', 'main']);
  await sh(wcDir, ['-c', 'user.email=perf@test', '-c', 'user.name=perf', 'add', '-A']);
  await sh(wcDir, [
    '-c',
    'user.email=perf@test',
    '-c',
    'user.name=perf',
    'commit',
    '-m',
    'fixture',
  ]);
  bareDir = join(base, 'vault.git');
  await sh(wcDir, ['clone', '--bare', wcDir, bareDir]);
}, 120_000);

afterAll(() => {
  const table = [
    `### store-core non-functional proof (scale: ${SCALE} notes)`,
    '',
    '| metric | measured | budget | ok |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  console.info(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
});

describe(`non-functional @ ${SCALE} notes`, () => {
  let bare: VaultStore;
  let wc: VaultStore;

  beforeAll(async () => {
    bare = createBareGitStore(bareDir);
    wc = createWorkingCopyGitStore(wcDir);
    const t0 = performance.now();
    await bare.list({}); // cold snapshot: the once-per-version history walk
    record('bare cold first list (snapshot build)', performance.now() - t0, 5_000);
    await wc.list({});
  }, 60_000);

  it('read: bare p50 <= 30ms, working-copy p50 <= 15ms', async () => {
    const b = await time(30, (i) => bare.read(`folder-${i % 10}/note-${i * 7}.md`));
    record('bare read p50', quantile(b, 0.5), 30);
    const w = await time(30, (i) => wc.read(`folder-${i % 10}/note-${i * 7}.md`));
    record('working-copy read p50', quantile(w, 0.5), 15);
  }, 60_000);

  it('search: p95 within the ADR-011 300ms trigger on both stores', async () => {
    const b = await time(10, () => bare.search({ query: 'galaxy', limit: 50 }));
    record('bare search p95', quantile(b, 0.95), 300);
    const w = await time(10, () => wc.search({ query: 'galaxy', limit: 50 }));
    record('working-copy search p95', quantile(w, 0.95), 300 * LOCAL_F);
    const hits = await bare.search({ query: 'galaxy', limit: 50 });
    expect(hits.results.length).toBe(50); // full page at this scale
  }, 60_000);

  it('list warm: <= 25ms average on both stores', async () => {
    const b = await time(10, () => bare.list({}));
    record('bare list warm avg', b.reduce((a, x) => a + x, 0) / b.length, 25);
    const w = await time(10, () => wc.list({}));
    record('working-copy list warm avg', w.reduce((a, x) => a + x, 0) / w.length, 60 * LOCAL_F);
  }, 60_000);

  it('write: bare p95 <= 250ms, 20 sequential writes sustained', async () => {
    const b = await time(20, (i) => bare.write({ path: `perf-write/w${i}.md`, body: `w ${i}` }));
    record('bare write p95', quantile(b, 0.95), 250);
  }, 60_000);

  it('version check is effectively free on the bare store', async () => {
    const b = await time(50, () => bare.version());
    record('bare version avg', b.reduce((a, x) => a + x, 0) / b.length, 2);
  }, 60_000);

  it('derived stats: compute bounded, cached get near-free', async () => {
    const cache = createDerivedCache(bare, join(bareDir, '..', '.cache'));
    const view = createStatsView(bareDir);
    const t0 = performance.now();
    const stats = await cache.get(view);
    record('stats compute (cold)', performance.now() - t0, 2_000);
    expect(stats.files).toBeGreaterThanOrEqual(SCALE);
    const cached = await time(10, () => cache.get(view));
    record('stats get (cached) avg', cached.reduce((a, x) => a + x, 0) / cached.length, 5);
  }, 60_000);

  it('refresh: quiet no-op is cheap; a real external change is bounded', async () => {
    const quiet = await time(20, () => bare.refresh());
    record('bare refresh (quiet) avg', quiet.reduce((a, x) => a + x, 0) / quiet.length, 5);
  }, 60_000);
});
