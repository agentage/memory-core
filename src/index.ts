// @agentage/store-core - storage-agnostic vault store contract + implementations.

export type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchHit,
  SearchQuery,
  SearchResult,
  TreeEntry,
  TreeFile,
  TreeFolder,
  VaultDescription,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from './contract/types.js';
export type {
  StoreCapabilities,
  StoreEvent,
  StoreObserver,
  VaultReader,
  VaultStore,
  VaultWriter,
} from './contract/vault-store.js';

export {
  deriveTags,
  makeExcerpt,
  makeSnippet,
  parseDoc,
  serializeDoc,
  titleFromPath,
} from './contract/memory-doc.js';
export {
  assertSafePath,
  isSafeSegment,
  parseMemoryId,
  SAFE_SEGMENT,
  safePath,
} from './contract/paths.js';
export { applyEdit, strReplace, type DocContent } from './contract/edit.js';
export {
  clampBody,
  clampView,
  ensureSize,
  MAX_DOC_BYTES,
  READ_BODY_BUDGET,
  truncationMarker,
  type ClampedBody,
} from './contract/read-budget.js';
export {
  assertNoRestricted,
  findRestricted,
  frontmatterText,
  RestrictedContentError,
  restrictedMessage,
} from './contract/restricted-data.js';
export {
  buildTree,
  DEFAULT_LIST_DEPTH,
  DEFAULT_LIST_LIMITS,
  MAX_LIST_LIMIT,
  normalizeFolder,
  pageTree,
  type ListLimits,
} from './contract/tree.js';
export { StoreError, storeErrorCode, type StoreErrorCode } from './contract/errors.js';
export {
  createStorePool,
  provisionIfEmpty,
  type StorePool,
  type StorePoolOptions,
} from './contract/store-pool.js';
export {
  bundleRepo,
  checkRootWritable,
  destroyRepo,
  listVaultDirs,
} from './stores/bare-git/git-admin.js';
export {
  countOccurrences,
  DEFAULT_SEARCH_LIMIT,
  decodeCursor,
  encodeCursor,
  MAX_SEARCH_LIMIT,
  rankAndPage,
  type RankedHit,
} from './contract/search.js';

export {
  createMemoryStore,
  type MemoryStoreOptions,
  type SeedFile,
} from './stores/memory-store.js';
export { createBareGitStore, type BareGitStoreOptions } from './stores/bare-git/bare-git-store.js';
export { validateBareRepoTree, type TreeViolation } from './stores/bare-git/validate-tree.js';
export { createStatsView, type VaultStats } from './stores/bare-git/stats-view.js';
export {
  createDerivedCache,
  type CachePolicy,
  type DerivedCache,
  type DerivedView,
} from './contract/derived.js';
