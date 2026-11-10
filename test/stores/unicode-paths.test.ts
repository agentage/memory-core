import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBareGitStore, validateBareRepoTree } from '../../src/index.js';
import { externalCommit } from './external-git.js';

const ACCENTED_DIR = 'Área de exemplos sintéticos';
const ACCENTED_PATH = ACCENTED_DIR + '/Índice de ações.md';

const repoFor = async () => join(await mkdtemp(join(tmpdir(), 'agentage-unicode-')), 'vault.git');

describe('Git-backed memory: Unicode path regression', () => {
  it('lists a committed accented filename with canonical Unicode and searches its content', async () => {
    const repo = await repoFor();
    const writer = createBareGitStore(repo);
    await writer.write({ path: ACCENTED_PATH, body: 'CHAVEUNICODE7X9 resposta de teste' });
    const fresh = createBareGitStore(repo);
    const scoped = await fresh.list({ folder: ACCENTED_DIR, depth: 2 });
    expect(scoped.files).toBe(1);
    expect(scoped.entries.map((e) => e.path)).toContain(ACCENTED_PATH);
    const found = await fresh.search({ query: 'CHAVEUNICODE7X9', limit: 5 });
    expect(found.results.map((e) => e.path)).toContain(ACCENTED_PATH);
    expect((await fresh.read(ACCENTED_PATH))?.body).toContain('CHAVEUNICODE7X9');
  });

  it('reconciles a Unicode path added and removed by an external push (drift)', async () => {
    const repo = await repoFor();
    const store = createBareGitStore(repo);
    await store.write({ path: 'seed.md', body: 'ok' });
    await store.list({});
    await externalCommit(repo, [{ path: ACCENTED_PATH, content: 'drift Unicode' }]);
    await store.refresh();
    expect((await store.list({ folder: ACCENTED_DIR })).entries.map((e) => e.path)).toContain(
      ACCENTED_PATH
    );
    await externalCommit(repo, [{ path: ACCENTED_PATH, remove: true }]);
    await store.refresh();
    expect((await store.list({ folder: ACCENTED_DIR })).entries).toEqual([]);
  });

  it('does not flag an otherwise safe UTF-8 filename in pre-receive tree validation', async () => {
    const repo = await repoFor();
    const store = createBareGitStore(repo);
    await store.write({ path: ACCENTED_PATH, body: 'valid' });
    expect(await validateBareRepoTree(repo)).toEqual([]);
  });
});
