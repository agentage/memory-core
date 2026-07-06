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

// restricted-data screen (secrets/credentials refused on write+edit)
export {
  findRestricted,
  frontmatterText,
  restrictedMessage,
  assertNoRestricted,
  RestrictedContentError,
} from './contract/restricted-data.js';

// read-output size budget
export {
  READ_BODY_BUDGET,
  clampBody,
  clampView,
  truncationMarker,
  type ClampedBody,
} from './contract/read-budget.js';

// the extension seam + backends
export type { VaultBackend, BackendCapabilities } from './backends/vault-backend.js';
export { createLocalBackend, type LocalBackendOptions } from './backends/local-backend.js';
export { createRemoteBackend } from './backends/remote-backend.js';

// config
export {
  loadConfig,
  validateConfig,
  getConfigDir,
  zeroConfig,
  DEFAULT_VAULT_NAME,
  ConfigError,
  isValidVaultName,
  VAULT_NAME_PATTERN,
  buildVaultsJsonSchema,
} from './config/config.js';

// published JSON Schema artifact (path to the committed schema/vaults.schema.json)
export { vaultsSchemaPath, VAULTS_SCHEMA_FILENAME } from './schema.js';

// registry
export {
  createRegistry,
  expandPath,
  isAccountVault,
  type VaultRegistry,
  type VaultHandle,
} from './registry/registry.js';

// account-vault discovery (candidate enumeration for the CLI daemon)
export { scanDiscoverRoots, type DiscoverCandidate, type ScanDeps } from './discover/discover.js';

// router (federation engine: @vault routing + fan-out - transport-agnostic)
export { createRouter, UnknownVaultError, type Router } from './router/router.js';

// setup
export { init, type InitOptions, type InitResult } from './setup/init.js';
