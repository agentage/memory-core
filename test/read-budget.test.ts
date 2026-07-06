import { describe, expect, it } from 'vitest';
import {
  clampBody,
  clampView,
  READ_BODY_BUDGET,
  truncationMarker,
} from '../src/contract/read-budget.js';
import type { MemoryView } from '../src/contract/types.js';

const view = (body: string): MemoryView => ({
  path: 'notes/big.md',
  title: 'big',
  frontmatter: {},
  body,
  tags: [],
  updated: '2026-07-06',
  deleted: false,
});

describe('read-output size budget', () => {
  it('leaves a body under the budget untouched', () => {
    const body = 'a'.repeat(READ_BODY_BUDGET - 1);
    const c = clampBody(body);
    expect(c.truncated).toBe(false);
    expect(c.body).toBe(body);
    expect(clampView(view(body)).body).toBe(body);
  });

  it('leaves a body exactly at the budget untouched', () => {
    const body = 'a'.repeat(READ_BODY_BUDGET);
    const c = clampBody(body);
    expect(c.truncated).toBe(false);
    expect(Buffer.byteLength(c.body, 'utf8')).toBe(READ_BODY_BUDGET);
    expect(clampView(view(body)).body).toBe(body);
  });

  it('clamps a body over the budget and reports the true total', () => {
    const body = 'a'.repeat(READ_BODY_BUDGET + 1000);
    const c = clampBody(body);
    expect(c.truncated).toBe(true);
    expect(Buffer.byteLength(c.body, 'utf8')).toBeLessThanOrEqual(READ_BODY_BUDGET);
    expect(c.totalBytes).toBe(READ_BODY_BUDGET + 1000);
  });

  it('appends the marker on a clamped view, naming shown + total bytes', () => {
    const total = READ_BODY_BUDGET + 5000;
    const out = clampView(view('a'.repeat(total)));
    const shown = READ_BODY_BUDGET;
    expect(out.body).toContain(truncationMarker(shown, total));
    expect(out.body).toContain(`of ${total} bytes`);
    expect(out.body).toContain('complete and unchanged');
  });

  it('cuts on a codepoint boundary (no U+FFFD tail)', () => {
    // 4-byte emoji repeated past the budget - a naive byte cut would split one.
    const body = '😀'.repeat(Math.ceil(READ_BODY_BUDGET / 4) + 10);
    const c = clampBody(body);
    expect(c.truncated).toBe(true);
    expect(c.body).not.toContain('�');
  });

  it('preserves the rest of the view shape when clamping', () => {
    const out = clampView(view('a'.repeat(READ_BODY_BUDGET + 10)));
    expect(out.path).toBe('notes/big.md');
    expect(out.title).toBe('big');
    expect(out.deleted).toBe(false);
    expect(out.updated).toBe('2026-07-06');
  });
});
