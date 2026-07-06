import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { createRouter } from '../src/router/router.js';
import { RestrictedContentError } from '../src/contract/restricted-data.js';
import { READ_BODY_BUDGET } from '../src/contract/read-budget.js';
import type { VaultHandle } from '../src/registry/registry.js';
import { tmpVault } from './fixtures/index.js';

const handle = (id: string, files?: Record<string, string>): VaultHandle => ({
  id,
  mcp: ['local'],
  backend: createLocalBackend({ path: tmpVault(files) }),
});

// The engine refuses restricted content on write+edit and clamps oversized read output,
// so every consumer (CLI verbs, local MCP) inherits one behavior.
describe('router secret refusal + read budget', () => {
  it('write refuses a secret in the body and persists nothing', async () => {
    const h = handle('work');
    const r = createRouter([h], h);
    await expect(
      r.write({ path: 'creds.md', body: 'AKIAIOSFODNN7EXAMPLE is the key' })
    ).rejects.toBeInstanceOf(RestrictedContentError);
    expect(await r.read('creds.md')).toBeNull();
  });

  it('write refuses a secret hidden in frontmatter', async () => {
    const h = handle('work');
    const r = createRouter([h], h);
    await expect(
      r.write({
        path: 'meta.md',
        body: 'clean body',
        frontmatter: { api_key: 'sk-abcdefghijklmnopqrstuvwxyz012345' },
      })
    ).rejects.toBeInstanceOf(RestrictedContentError);
  });

  it('write allows a clean body', async () => {
    const h = handle('work');
    const r = createRouter([h], h);
    const w = await r.write({ path: 'ok.md', body: 'notes on the auth flow' });
    expect(w.path).toBe('ok.md');
    expect((await r.read('ok.md'))!.body).toBe('notes on the auth flow');
  });

  it('edit (replace) refuses an introduced secret', async () => {
    const h = handle('work', { 'n.md': 'original' });
    const r = createRouter([h], h);
    await expect(
      r.edit({ path: 'n.md', mode: 'replace', body: 'password: hunter2secret' })
    ).rejects.toBeInstanceOf(RestrictedContentError);
  });

  it('edit (append) refuses an introduced secret', async () => {
    const h = handle('work', { 'n.md': 'original' });
    const r = createRouter([h], h);
    await expect(
      r.edit({ path: 'n.md', mode: 'append', body: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' })
    ).rejects.toBeInstanceOf(RestrictedContentError);
  });

  it('edit (str_replace) refuses a secret injected via new_str', async () => {
    const h = handle('work', { 'n.md': 'placeholder' });
    const r = createRouter([h], h);
    await expect(
      r.edit({
        path: 'n.md',
        mode: 'str_replace',
        old_str: 'placeholder',
        new_str: 'sk-abcdefghijklmnopqrstuvwxyz012345',
      })
    ).rejects.toBeInstanceOf(RestrictedContentError);
    // the note is untouched by the refused edit
    expect((await r.read('n.md'))!.body).toBe('placeholder');
  });

  it('edit allows a clean change', async () => {
    const h = handle('work', { 'n.md': 'original' });
    const r = createRouter([h], h);
    const res = await r.edit({ path: 'n.md', mode: 'append', body: 'more notes' });
    expect(res).not.toBeNull();
    expect((await r.read('n.md'))!.body).toContain('more notes');
  });

  it('read clamps an oversized body and marks it, disk copy stays whole', async () => {
    const big = 'x'.repeat(READ_BODY_BUDGET + 4096);
    const h = handle('work', { 'big.md': big });
    const r = createRouter([h], h);
    const view = await r.read('big.md');
    expect(view).not.toBeNull();
    expect(Buffer.byteLength(view!.body, 'utf8')).toBeLessThan(READ_BODY_BUDGET + 512);
    expect(view!.body).toContain('The stored memory file is complete and unchanged.');
  });

  it('read returns a small body verbatim (no marker)', async () => {
    const h = handle('work', { 'small.md': 'just a little note' });
    const r = createRouter([h], h);
    const view = await r.read('small.md');
    expect(view!.body).toBe('just a little note');
    expect(view!.body).not.toContain('Truncated for display');
  });
});
