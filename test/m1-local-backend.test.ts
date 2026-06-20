import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { tmpVault } from './fixtures/index.js';

const backend = (files?: Record<string, string>) => createLocalBackend({ path: tmpVault(files) });

// TC2 - round-trip write -> read. M1-R6 + M1-R4.
describe('TC2 write -> read round-trip', () => {
  it('writes a doc and reads it back verbatim', async () => {
    const b = backend();
    const w = await b.write({
      path: 'work/tasks/foo.md',
      body: 'Body text with #project tag.',
      frontmatter: { type: 'task', tags: ['active'] },
    });
    expect(w.path).toBe('work/tasks/foo.md');
    expect(w.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(w.updated).toMatch(/^\d{4}-\d\d-\d\dT/);

    const view = await b.read('work/tasks/foo.md');
    expect(view).not.toBeNull();
    expect(view!.title).toBe('foo');
    expect(view!.frontmatter).toEqual({ type: 'task', tags: ['active'] });
    expect(view!.body).toBe('Body text with #project tag.');
    expect(view!.tags).toEqual(['active', 'project']); // frontmatter ∪ inline
    expect(view!.deleted).toBe(false);
  });

  it('read returns null for a missing path', async () => {
    expect(await backend().read('nope.md')).toBeNull();
  });

  it('write is idempotent (overwrite replaces body + frontmatter)', async () => {
    const b = backend();
    await b.write({ path: 'n.md', body: 'one', frontmatter: { a: 1 } });
    await b.write({ path: 'n.md', body: 'two' });
    const view = await b.read('n.md');
    expect(view!.body).toBe('two');
    expect(view!.frontmatter).toEqual({});
  });

  it('materializes the file on disk as plain markdown (files-first)', async () => {
    const path = tmpVault();
    const b = createLocalBackend({ path });
    await b.write({ path: 'note.md', body: 'hello', frontmatter: { k: 'v' } });
    const onDisk = readFileSync(join(path, 'note.md'), 'utf8');
    expect(onDisk).toBe('---\nk: v\n---\nhello');
  });

  it('reports local capabilities', () => {
    expect(backend().capabilities()).toEqual({ kind: 'local', mutate: true, search: 'git-grep' });
  });
});
