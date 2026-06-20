// @agentage/memory-core public API - the transport-agnostic engine.
// The MCP server layer lives in a separate package that builds on this one.

// contract data types + doc helpers
export * from './contract/types.js';
export {
  serializeDoc,
  parseDoc,
  titleFromPath,
  deriveTags,
  makeSnippet,
} from './contract/memory-doc.js';

// the extension seam + backends
export type { VaultBackend, BackendCapabilities } from './backends/vault-backend.js';
export { createLocalBackend, type LocalBackendOptions } from './backends/local-backend.js';
export { createRemoteBackend } from './backends/remote-backend.js';

// config
export { loadConfig, validateConfig, getConfigDir, ConfigError } from './config/config.js';

// registry
export {
  createRegistry,
  expandPath,
  type VaultRegistry,
  type VaultHandle,
} from './registry/registry.js';

// setup
export { init, type InitOptions, type InitResult } from './setup/init.js';
