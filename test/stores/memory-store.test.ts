import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createMemoryStore } from '../../src/index.js';

const target = {
  name: 'memory-store',
  make: () => createMemoryStore(),
  // Nothing to spawn: the reference store answers every verb in-process, so its
  // budget is trivially zero and the kit's round-trip block still applies.
  makeCounted: () => ({ store: createMemoryStore(), trips: () => 0, reset: () => {} }),
};

contractSuite(target);
securitySuite(target);
