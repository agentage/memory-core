import { fileURLToPath } from 'node:url';

// The committed JSON Schema artifact, shipped in the npm `files` whitelist so tooling can
// $ref it. Lives at <package>/schema/vaults.schema.json; this module resolves next to it
// from both src (dev/test) and dist (published), each one level under the package root.
export const VAULTS_SCHEMA_FILENAME = 'vaults.schema.json';

export const vaultsSchemaPath = (): string =>
  fileURLToPath(new URL(`../schema/${VAULTS_SCHEMA_FILENAME}`, import.meta.url));
