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
  type VaultStore,
} from '../../src/index.js';

const SCALE = Number(process.env.PERF_SCALE ?? 1000);
// The commit-count axis: history length, independent of how many notes exist.
// A year of daily use is thousands of commits over a few hundred notes.
const COMMITS = Number(process.env.PERF_COMMITS ?? 4000);
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

const sh = (cwd: string, args: string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 64 }, (e, so) =>
      e ? reject(e) : resolve(so)
    );
    if (input !== undefined) child.stdin?.end(input);
  });

// A commit ARRIVING from outside, the way a sync push does: plumbing only, no
// working tree, no store involvement.
const pushExternally = async (bare: string, path: string, body: string): Promise<void> => {
  const blob = (await sh(bare, ['hash-object', '-w', '--stdin'], body)).trim();
  const parent = (await sh(bare, ['rev-parse', 'refs/heads/main'])).trim();
  await sh(bare, ['read-tree', parent]);
  await sh(bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  const tree = (await sh(bare, ['write-tree'])).trim();
  const commit = (
    await sh(bare, [
      '-c',
      'user.email=push@test',
      '-c',
      'user.name=push',
      'commit-tree',
      tree,
      '-m',
      'external',
      '-p',
      parent,
    ])
  ).trim();
  await sh(bare, ['update-ref', 'refs/heads/main', commit]);
};

// The second axis the 1-commit fixture cannot see: a vault accrues one commit per
// write, and the snapshot build walks all of them. One fast-import builds the
// history in a single process - CHURN real commits would be CHURN spawns.
const churnedRepo = async (dir: string, commits: number): Promise<void> => {
  await sh(tmpdir(), ['init', '--bare', '-b', 'main', dir]);
  const at = 1_750_000_000;
  const out: string[] = [];
  for (let i = 0; i < commits; i++) {
    const path = `folder-${i % 10}/note-${i % 200}.md`;
    const body = `---\ntags: [t${i % 7}]\n---\nRevision ${i} of ${path}, about ordinary things.\n`;
    const msg = `write: ${path}`;
    out.push(
      'blob',
      `mark :${i + 1}`,
      `data ${Buffer.byteLength(body, 'utf8')}`,
      body,
      'commit refs/heads/main',
      `author perf <perf@test> ${at + i} +0000`,
      `committer perf <perf@test> ${at + i} +0000`,
      `data ${Buffer.byteLength(msg, 'utf8')}`,
      msg,
      `M 100644 :${i + 1} ${path}`,
      ''
    );
  }
  await sh(dir, ['fast-import', '--quiet'], out.join('\n'));
};

let wcDir: string;
let bareDir: string;
let churnedDir: string;

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
  churnedDir = join(base, 'churned.git');
  await churnedRepo(churnedDir, COMMITS);
}, 300_000);

afterAll(() => {
  const table = [
    `### memory-core non-functional proof (scale: ${SCALE} notes, ${COMMITS} commits)`,
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

  beforeAll(async () => {
    bare = createBareGitStore(bareDir);
    const t0 = performance.now();
    await bare.list({}); // cold snapshot: the once-per-version history walk
    record('bare cold first list (snapshot build)', performance.now() - t0, 5_000);
  }, 60_000);

  it('read: bare p50 <= 30ms', async () => {
    const b = await time(30, (i) => bare.read(`folder-${i % 10}/note-${i * 7}.md`));
    record('bare read p50', quantile(b, 0.5), 30);
  }, 60_000);

  // The fan-out this verb exists for: one folder page of notes, enriched. Priced
  // against a measured single read, so the claim is a ratio, not a wall clock.
  it('bulk read: 200 docs cost far less than the 200 reads they replace', async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `folder-${i % 10}/note-${i}.md`);
    const perDoc = await time(20, (i) => bare.read(paths[i]!));
    const avgRead = perDoc.reduce((a, x) => a + x, 0) / perDoc.length;
    const bulk = await time(3, () => bare.readMany(paths));
    const best = Math.min(...bulk);
    record('bare readMany 200 docs', best, 150);
    // Earns its place only by beating the reads it replaces by an order of magnitude.
    record(
      `bare readMany 200 vs 200x read (${(avgRead * 200).toFixed(0)}ms), 20% ceiling`,
      best,
      Math.max(Math.round(avgRead * 200 * 0.2), 20)
    );
    const views = await bare.readMany(paths);
    expect(views.filter(Boolean)).toHaveLength(200);
  }, 60_000);

  it('search: p95 within the ADR-011 300ms trigger', async () => {
    const b = await time(10, () => bare.search({ query: 'galaxy', limit: 50 }));
    record('bare search p95', quantile(b, 0.95), 300);
    const hits = await bare.search({ query: 'galaxy', limit: 50 });
    expect(hits.results.length).toBe(50); // full page at this scale
  }, 60_000);

  it('list warm: <= 25ms average', async () => {
    const b = await time(10, () => bare.list({}));
    record('bare list warm avg', b.reduce((a, x) => a + x, 0) / b.length, 25);
  }, 60_000);

  it('write: bare p50 <= 250ms (20 sequential writes; p95 is a loose sanity ceiling)', async () => {
    // p95 of 20 samples is "the single worst write" - pure runner noise on
    // shared CI. Median catches structural regressions; the ceiling catches hangs.
    const b = await time(20, (i) => bare.write({ path: `perf-write/w${i}.md`, body: `w ${i}` }));
    record('bare write p50', quantile(b, 0.5), 250);
    record('bare write p95 (sanity)', quantile(b, 0.95), 2_000);
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

// The axis the note-count fixture cannot see. Everything here scales with HISTORY:
// the snapshot build walks it once, and a push must not make that happen again.
describe(`commit-count axis @ ${COMMITS} commits`, () => {
  let churned: VaultStore;

  beforeAll(() => {
    churned = createBareGitStore(churnedDir);
  });

  it('cold first list pays the history walk exactly once', async () => {
    const t0 = performance.now();
    const first = await churned.list({});
    record('churned cold first list', performance.now() - t0, 5_000);
    expect(first.files).toBe(200);
    const warm = await time(5, () => churned.list({}));
    record('churned list warm avg', warm.reduce((a, x) => a + x, 0) / warm.length, 25);
  }, 60_000);

  it('an external push costs a bounded patch, not another history walk', async () => {
    await churned.list({}); // warm at the current version
    await pushExternally(churnedDir, 'folder-3/pushed.md', 'pushed from outside');
    const t0 = performance.now();
    const events = await churned.refresh();
    const after = await churned.list({});
    const patched = performance.now() - t0;
    expect(events.map((e) => e.paths)).toEqual([['folder-3/pushed.md']]);
    expect(after.files).toBe(201);

    // The cost this replaces, measured in the same run: a fresh instance has to
    // walk the whole history to answer the same question.
    const t1 = performance.now();
    await createBareGitStore(churnedDir).list({});
    const rebuild = performance.now() - t1;
    record(
      `churned external push -> fresh answer (rebuild is ${rebuild.toFixed(0)}ms)`,
      patched,
      Math.max(Math.round(rebuild * 0.5), 10)
    );
  }, 60_000);

  it('describe is computed once per version, then free', async () => {
    const cold = await time(1, () => churned.describe());
    record('churned describe (cold)', cold[0]!, 2_000);
    const warm = await time(10, () => churned.describe());
    record('churned describe warm avg', warm.reduce((a, x) => a + x, 0) / warm.length, 2);
    expect((await churned.describe()).files).toBe(201);
  }, 60_000);
});
