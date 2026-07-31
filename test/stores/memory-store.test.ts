import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createMemoryStore } from '../../src/index.js';

const target = { name: 'memory-store', make: () => createMemoryStore() };

contractSuite(target);
securitySuite(target);
