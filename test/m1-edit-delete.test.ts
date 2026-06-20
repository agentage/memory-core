import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { tmpVault } from './fixtures/index.js';

// TC5 - edit. M1-R6.
describe('TC5 edit', () => {
  const seeded = () =>
    createLocalBackend({ path: tmpVault({ 'n.md': '---\ntype: note\n---\nhello world' }) });

  it('str_replace swaps one exact match', async () => {
    const b = seeded();
    const r = await b.edit({
      path: 'n.md',
      mode: 'str_replace',
      old_str: 'world',
      new_str: 'there',
    });
    expect(r).not.toBeNull();
    expect((await b.read('n.md'))!.body).toBe('hello there');
  });

  it('str_replace throws when old_str is absent or not unique', async () => {
    const b = createLocalBackend({ path: tmpVault({ 'n.md': 'a a' }) });
    await expect(
      b.edit({ path: 'n.md', mode: 'str_replace', old_str: 'zzz', new_str: 'q' })
    ).rejects.toThrow(/did not appear verbatim/);
    await expect(
      b.edit({ path: 'n.md', mode: 'str_replace', old_str: 'a', new_str: 'q' })
    ).rejects.toThrow(/Multiple occurrences/);
  });

  it('append adds to the end with a newline guard', async () => {
    const b = seeded();
    await b.edit({ path: 'n.md', mode: 'append', body: 'more' });
    expect((await b.read('n.md'))!.body).toBe('hello world\nmore');
  });

  it('replace overwrites the whole body', async () => {
    const b = seeded();
    await b.edit({ path: 'n.md', mode: 'replace', body: 'fresh' });
    expect((await b.read('n.md'))!.body).toBe('fresh');
  });

  it('shallow-merges frontmatter (existing keys preserved)', async () => {
    const b = seeded();
    await b.edit({ path: 'n.md', frontmatter: { status: 'active' } });
    expect((await b.read('n.md'))!.frontmatter).toEqual({ type: 'note', status: 'active' });
  });

  it('returns null for a missing path', async () => {
    expect(await seeded().edit({ path: 'ghost.md', body: 'x' })).toBeNull();
  });
});

// TC6 - delete. M1-R6.
describe('TC6 delete', () => {
  it('removes the file from disk and returns true', async () => {
    const path = tmpVault({ 'n.md': 'bye' });
    const b = createLocalBackend({ path });
    expect(await b.delete('n.md')).toBe(true);
    expect(existsSync(join(path, 'n.md'))).toBe(false);
    expect(await b.read('n.md')).toBeNull();
  });

  it('is recoverable from git history (soft-delete)', async () => {
    const path = tmpVault({ 'n.md': 'recover me' });
    const b = createLocalBackend({ path });
    await b.delete('n.md');
    const { execFileSync } = await import('node:child_process');
    const prior = execFileSync('git', ['cat-file', '-p', 'HEAD~1:n.md'], { cwd: path }).toString();
    expect(prior).toBe('recover me');
  });

  it('returns false for a missing path', async () => {
    expect(await createLocalBackend({ path: tmpVault() }).delete('ghost.md')).toBe(false);
  });
});
