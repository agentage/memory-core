import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildVaultsJsonSchema } from '../src/config/config.js';
import { VAULTS_SCHEMA_FILENAME, vaultsSchemaPath } from '../src/schema.js';

// Guards drift: the committed schema artifact must equal the live zod-derived schema.
// If this fails, run `npm run generate-schema` and commit schema/vaults.schema.json.
describe('vaults.schema.json', () => {
  it('committed artifact deep-equals the live schema', () => {
    const committed = JSON.parse(readFileSync(vaultsSchemaPath(), 'utf8'));
    expect(committed).toEqual(buildVaultsJsonSchema());
  });

  it('exposes a resolvable path to the committed file', () => {
    expect(VAULTS_SCHEMA_FILENAME).toBe('vaults.schema.json');
    expect(vaultsSchemaPath().endsWith(`/schema/${VAULTS_SCHEMA_FILENAME}`)).toBe(true);
  });
});
