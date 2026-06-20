import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { tmpVault } from './fixtures/index.js';

// TC3 - git-grep search ranking. M1-R3.
describe('TC3 search', () => {
  it('ranks by occurrence count (desc)', async () => {
    const b = createLocalBackend({
      path: tmpVault({
        'a.md': 'pkce pkce pkce here',
        'b.md': 'one pkce mention',
        'c.md': 'nothing relevant',
      }),
    });
    const r = await b.search({ query: 'pkce' });
    expect(r.results.map((h) => h.path)).toEqual(['a.md', 'b.md']);
    expect(r.results[0].score).toBe(3);
    expect(r.results[1].score).toBe(1);
    expect(r.results[0].snippet).toContain('pkce');
  });

  it('is case-insensitive and literal (substring, not tokenized)', async () => {
    const b = createLocalBackend({
      path: tmpVault({ 'x.md': 'The OAuth Flow', 'y.md': 'oauth and flow apart' }),
    });
    const r = await b.search({ query: 'oauth flow' });
    expect(r.results.map((h) => h.path)).toEqual(['x.md']); // exact phrase only
  });

  it('honors the folder scope', async () => {
    const b = createLocalBackend({
      path: tmpVault({ 'work/a.md': 'token', 'personal/b.md': 'token' }),
    });
    const r = await b.search({ query: 'token', folder: 'work' });
    expect(r.results.map((h) => h.path)).toEqual(['work/a.md']);
  });

  it('filters by tags (AND)', async () => {
    const b = createLocalBackend({
      path: tmpVault({
        'a.md': '---\ntags: [active, project]\n---\ntoken here',
        'b.md': '---\ntags: [active]\n---\ntoken here',
      }),
    });
    const r = await b.search({ query: 'token', tags: ['active', 'project'] });
    expect(r.results.map((h) => h.path)).toEqual(['a.md']);
  });

  it('paginates with limit + cursor', async () => {
    const b = createLocalBackend({
      path: tmpVault({ 'a.md': 'kw', 'b.md': 'kw', 'c.md': 'kw' }),
    });
    const page1 = await b.search({ query: 'kw', limit: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await b.search({ query: 'kw', limit: 2, cursor: page1.nextCursor });
    expect(page2.results).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('returns no results for an empty query or zero hits', async () => {
    const b = createLocalBackend({ path: tmpVault({ 'a.md': 'something' }) });
    expect((await b.search({ query: '   ' })).results).toEqual([]);
    expect((await b.search({ query: 'absent' })).results).toEqual([]);
  });
});
