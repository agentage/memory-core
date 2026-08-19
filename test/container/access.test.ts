// The access matrix: every verb x every grant shape. Access is the container's
// only authority - a resolved decision the host hands in, never a claim it reads.

import { beforeEach, describe, expect, it } from 'vitest';
import type { VaultContainer } from '../../src/index.js';
import { access, containerAt, makeRoot } from './harness.js';

describe('container access matrix', () => {
  let container: VaultContainer;

  beforeEach(async () => {
    container = containerAt(await makeRoot());
  });

  it('allows every verb on an allowlisted vault', async () => {
    const a = access();
    const store = await container.create(a, 'main');
    expect(await container.open(a, 'main')).toBe(store);
    expect(await container.list(a)).toEqual(['main']);
    expect(await container.remove(a, 'main', '20260819T101500Z')).toBe(true);
  });

  it('refuses a vault outside the allowlist and hides it from list', async () => {
    const wide = access({ vaults: '*' });
    await container.create(wide, 'secret');
    const a = access();
    for (const call of [
      (): Promise<unknown> => container.open(a, 'secret'),
      (): Promise<unknown> => container.create(a, 'secret'),
      (): Promise<unknown> => container.remove(a, 'secret', 's1'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await container.list(a)).toEqual([]);
    expect(await container.list(wide)).toEqual(['secret']);
  });

  it("'*' grants every vault the user actually has, and only those", async () => {
    const wide = access({ vaults: '*' });
    await container.create(wide, 'anything');
    expect(await container.open(wide, 'anything')).toBeTruthy();
    expect(await container.list(wide)).toEqual(['anything']);
    await expect(container.open(wide, 'ghost')).rejects.toMatchObject({ code: 'unknown_vault' });
  });

  it('list intersects the allowlist and stays sorted', async () => {
    const wide = access({ vaults: '*' });
    for (const v of ['zeta', 'main', 'work', 'archive']) await container.create(wide, v);
    expect(await container.list(wide)).toEqual(['archive', 'main', 'work', 'zeta']);
    expect(await container.list(access())).toEqual(['main', 'work']);
    expect(await container.list(access({ vaults: new Set(['nope']) }))).toEqual([]);
  });

  it('an unprovisioned vault is unknown to open, false to remove, created by create', async () => {
    const a = access();
    await expect(container.open(a, 'work')).rejects.toMatchObject({
      code: 'unknown_vault',
      message: 'unknown vault: work',
    });
    expect(await container.remove(a, 'work', 's1')).toBe(false);
    expect(await container.create(a, 'work')).toBeTruthy();
    expect(await container.open(a, 'work')).toBeTruthy();
  });

  it('canCreate=false refuses create and nothing else', async () => {
    const seed = access();
    await container.create(seed, 'main');
    const a = access({ canCreate: false });
    await expect(container.create(a, 'work')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(container.create(a, 'main')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await container.open(a, 'main')).toBeTruthy();
    expect(await container.list(a)).toEqual(['main']);
    expect(await container.remove(a, 'main', 's1')).toBe(true);
  });

  it('canDelete=false refuses remove and nothing else', async () => {
    const a = access({ canDelete: false });
    await container.create(a, 'main');
    await expect(container.remove(a, 'main', 's1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await container.open(a, 'main')).toBeTruthy();
    expect(await container.list(a)).toEqual(['main']);
  });

  it('the allowlist gate fires before any storage fact leaks', async () => {
    const denied = access({ vaults: new Set(['main']), canCreate: false, canDelete: false });
    // A vault that does not exist and is not granted reads as forbidden, never as unknown.
    await expect(container.open(denied, 'work')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(container.remove(denied, 'work', 's1')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
