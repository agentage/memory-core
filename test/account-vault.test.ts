import { describe, expect, it } from 'vitest';
import { isAccountVault } from '../src/registry/registry.js';

// The reserved "agentage" origin is the account sync-channel sentinel.
describe('isAccountVault', () => {
  it('true when an origin uses the reserved agentage remote', () => {
    expect(isAccountVault({ origin: [{ remote: 'agentage' }] })).toBe(true);
  });

  it('true when agentage is one of several origins (mixed list)', () => {
    expect(
      isAccountVault({
        path: '~/n',
        origin: [{ remote: 'git@github.com:me/n.git' }, { remote: 'agentage' }],
      })
    ).toBe(true);
  });

  it('false for a plain git remote', () => {
    expect(isAccountVault({ origin: [{ remote: 'git@github.com:me/n.git' }] })).toBe(false);
  });

  it('false for a local-only entry (no origin)', () => {
    expect(isAccountVault({ path: '~/scratch' })).toBe(false);
  });
});
