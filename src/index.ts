// @agentage/memory-core public API. See features/memory-core/requirements.md.

// contract types + doc helpers + the frozen 6-tool schema
export * from './contract/types.js';
export {
  serializeDoc,
  parseDoc,
  titleFromPath,
  deriveTags,
  makeSnippet,
} from './contract/memory-doc.js';
export { MEMORY_TOOLS, type MemoryToolDef } from './contract/memory-tools.schema.js';

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

// router + server
export { createRouter, UnknownVaultError, type Router } from './router/router.js';
export {
  createMemoryServer,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  type CreateServerOptions,
} from './server/create-memory-server.js';
export { loadLocalServer } from './server/local-server.js';

// setup
export { init, type InitOptions, type InitResult } from './setup/init.js';
