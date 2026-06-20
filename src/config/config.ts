import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { VaultsConfig } from '../contract/types.js';

// A single, loud config error: `key` points at the offending location
// (`default`, `vaults.<name>`, `vaults.json`) so the CLI can print one line.
export class ConfigError extends Error {
  constructor(
    public readonly key: string,
    message: string
  ) {
    super(`vaults.json: ${key}: ${message}`);
    this.name = 'ConfigError';
  }
}

const originSchema = z.object({
  remote: z.string().trim().min(1),
  interval: z.number().int().min(0).optional(),
  ignore: z.array(z.string()).optional(),
});

const entrySchema = z.object({
  origin: z.array(originSchema).optional(),
  path: z.string().trim().min(1).optional(),
  mcp: z.array(z.enum(['local', 'remote'])).optional(),
});

const configSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  default: z.string().optional(),
  vaults: z.record(z.string(), entrySchema),
});

// The directory holding vaults.json + auth.json. Honors AGENTAGE_CONFIG_DIR
// (CLI convention) so tests and isolated installs can redirect it.
export const getConfigDir = (configDir?: string): string =>
  configDir || process.env.AGENTAGE_CONFIG_DIR || join(process.env.HOME || homedir(), '.agentage');

// Validate a parsed object into a VaultsConfig, or throw ConfigError(key). Structural
// (zod) errors and the two semantic rules - an entry needs origin and/or path, and
// `default` must name a real vault - all surface as one keyed error.
export const validateConfig = (raw: unknown): VaultsConfig => {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path.length ? issue.path.join('.') : 'version';
    throw new ConfigError(key, issue?.message ?? 'invalid config');
  }
  const config = parsed.data as VaultsConfig;

  for (const [name, entry] of Object.entries(config.vaults)) {
    if (!entry.path && !(entry.origin && entry.origin.length)) {
      throw new ConfigError(`vaults.${name}`, 'needs an origin and/or a path');
    }
  }
  if (config.default && !config.vaults[config.default]) {
    throw new ConfigError('default', `names a vault that does not exist: "${config.default}"`);
  }
  return config;
};

// Read + validate ${configDir}/vaults.json. A missing file, bad JSON, or invalid
// shape all throw ConfigError and load nothing (M1-R1).
export const loadConfig = async (opts: { configDir?: string } = {}): Promise<VaultsConfig> => {
  const file = join(getConfigDir(opts.configDir), 'vaults.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new ConfigError('vaults.json', `not found at ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError('vaults.json', `invalid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw);
};
