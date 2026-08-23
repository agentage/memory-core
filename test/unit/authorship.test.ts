// The arithmetic both stores share. Real histories date to the second, so the
// interesting cases are the ties - which the stores cannot exercise on demand,
// because they cannot make two writes land on the same stamp to order.

import { describe, expect, it } from 'vitest';
import { rankAuthors, recordAuthored, type AuthorTally } from '../../src/contract/authorship.js';

const feed = (rows: Array<[string, string, string]>): AuthorTally => {
  const tally: AuthorTally = new Map();
  for (const [id, name, at] of rows) recordAuthored(tally, { id, name }, at);
  return tally;
};

describe('authorship tally', () => {
  it('counts per client and dates the row from the latest change', () => {
    expect(
      rankAuthors(
        feed([
          ['claude', 'Claude', '2026-08-01T00:00:00Z'],
          ['claude', 'Claude', '2026-08-03T00:00:00Z'],
          ['claude', 'Claude', '2026-08-02T00:00:00Z'],
        ])
      )
    ).toEqual([
      { author: { id: 'claude', name: 'Claude' }, writes: 3, lastAt: '2026-08-03T00:00:00Z' },
    ]);
  });

  it('breaks a same-stamp tie in favour of the last change fed', () => {
    const at = '2026-08-01T00:00:00Z';
    const rows = rankAuthors(
      feed([
        ['claude', 'Claude 3', at],
        ['claude', 'Claude 4', at],
      ])
    );
    expect(rows[0]!.author.name).toBe('Claude 4');
  });

  it('an undatable change still yields to one that carries a stamp', () => {
    const rows = rankAuthors(
      feed([
        ['claude', 'Claude', ''],
        ['claude', 'Claude', '2026-08-01T00:00:00Z'],
      ])
    );
    expect(rows[0]!.lastAt).toBe('2026-08-01T00:00:00Z');
    // ...and never the other way round.
    const back = rankAuthors(
      feed([
        ['cursor', 'Cursor', '2026-08-01T00:00:00Z'],
        ['cursor', 'Cursor', ''],
      ])
    );
    expect(back[0]!.lastAt).toBe('2026-08-01T00:00:00Z');
  });

  it('ranks busiest first, then by id - the clock never decides', () => {
    expect(
      rankAuthors(
        feed([
          ['zed', 'Zed', '2026-08-09T00:00:00Z'],
          ['cursor', 'Cursor', '2026-08-01T00:00:00Z'],
          ['cursor', 'Cursor', '2026-08-02T00:00:00Z'],
          ['claude', 'Claude', '2026-08-03T00:00:00Z'],
        ])
      ).map((r) => [r.author.id, r.writes])
    ).toEqual([
      ['cursor', 2],
      ['claude', 1],
      ['zed', 1],
    ]);
  });

  it('an empty tally ranks to nothing', () => {
    expect(rankAuthors(new Map())).toEqual([]);
  });
});
