// Regenerate schema/vaults.schema.json from the live zod config schema.
// Run `npm run generate-schema` (builds first, then emits from dist). The schema-sync test
// asserts the committed file matches this output, so drift fails CI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVaultsJsonSchema } from '../dist/index.js';

const out = fileURLToPath(new URL('../schema/vaults.schema.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildVaultsJsonSchema(), null, 2) + '\n', 'utf8');
console.log(`wrote ${out}`);
