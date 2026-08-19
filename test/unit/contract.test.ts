import { describe, expect, it } from 'vitest';
import { applyEdit } from '../../src/contract/edit.js';
import { StoreError, storeErrorCode } from '../../src/contract/errors.js';
import { parseDoc, serializeDoc } from '../../src/contract/memory-doc.js';
import { parseMemoryId, safePath } from '../../src/contract/paths.js';

describe('memory-doc codec', () => {
  it('round-trips frontmatter + body', () => {
    const doc = serializeDoc({ tags: ['a'] }, 'hello');
    expect(parseDoc(doc)).toEqual({ frontmatter: { tags: ['a'] }, body: 'hello' });
  });

  it('never throws on malformed frontmatter - keeps the raw content as body', () => {
    const raw = '---\n{{{ not yaml\n---\nbody';
    expect(parseDoc(raw)).toEqual({ frontmatter: {}, body: raw });
  });

  it('emits bare body when frontmatter is empty', () => {
    expect(serializeDoc({}, 'plain')).toBe('plain');
  });
});

describe('parseMemoryId', () => {
  it('defaults a bare id to the default vault', () => {
    expect(parseMemoryId('user123')).toEqual({ userId: 'user123', vault: 'default' });
  });

  it('accepts a real Better Auth id and every <user>/<vault> shape, rejects the rest', () => {
    const sub = 'knK7ALkomaSIel7R9jekdqKelAAbARDX'; // Better Auth user id = [A-Za-z0-9]{32}
    expect(parseMemoryId(sub)).toEqual({ userId: sub, vault: 'default' });
    expect(parseMemoryId(`${sub}/work`)).toEqual({ userId: sub, vault: 'work' });
    // Each segment is allowlisted: >2 segments, traversal, dots, control-ish
    // charsets, over-length and empties are all refused.
    for (const bad of [
      'has space',
      'a/b/c',
      '../evil',
      'a/..',
      'a/',
      '/b',
      'a..b',
      'a.b',
      'a;b',
      'café',
      'x'.repeat(65),
      '',
    ]) {
      expect(() => parseMemoryId(bad)).toThrow(/memoryId/);
    }
  });

  it('rejects extra segments and unsafe charsets', () => {
    expect(() => parseMemoryId('a/b/c')).toThrow();
    expect(() => parseMemoryId('../x')).toThrow();
    expect(() => parseMemoryId('a b/c')).toThrow();
  });

  it('rejects with a coded StoreError so consumers map it like any other path refusal', () => {
    for (const bad of ['a/b/c', '../x', 'a b/c']) {
      let thrown: unknown;
      try {
        parseMemoryId(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StoreError);
      expect(storeErrorCode(thrown)).toBe('invalid_path');
      expect((thrown as StoreError).message).toBe(`invalid memoryId: ${JSON.stringify(bad)}`);
    }
  });
});

describe('safePath', () => {
  it('accepts ordinary nested markdown paths', () => {
    expect(safePath('work/notes/plan.md')).toBe(true);
  });
});

describe('applyEdit', () => {
  const existing = { frontmatter: { a: 1 }, body: 'one two' };

  it('append preserves a trailing newline exactly once', () => {
    expect(
      applyEdit({ ...existing, body: 'line\n' }, { path: 'x', mode: 'append', body: 'next' }).body
    ).toBe('line\nnext');
  });

  it('str_replace splices literally (no $-pattern expansion)', () => {
    const out = applyEdit(existing, {
      path: 'x',
      mode: 'str_replace',
      old_str: 'two',
      new_str: "$' $1",
    });
    expect(out.body).toBe("one $' $1");
  });
});
