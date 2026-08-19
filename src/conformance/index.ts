// Public conformance kit: import from '@agentage/memory-core/conformance' inside
// a vitest suite (vitest is an optional peer dependency). A store passing both
// suites is guaranteed swappable behind the VaultStore contract; the corpora
// are exported so consumers can fire the same security inputs at their own
// HTTP/MCP edges.

export { contractSuite, type ConformanceTarget } from './contract-suite.js';
export {
  BENIGN_BODIES,
  HOSTILE_PATHS,
  RESTRICTED_BODIES,
  securitySuite,
} from './security-suite.js';
