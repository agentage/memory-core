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
  vaultsDir: z.string().trim().min(1).optional(),
  autodiscover: z.boolean().optional(),
  autoInit: z.boolean().optional(),
  default: z.string().optional(),
  vaults: z.record(z.string(), entrySchema).optional(),
});

// Zero-config: with no vaults.json, serve a single default vault under the config dir
// (created on first write). So `npx @agentage/server-memory` works with no setup.
export const DEFAULT_VAULT_NAME = 'memory';
export const zeroConfig = (configDir: string): VaultsConfig => ({
  version: 1,
  autoInit: true,
  default: DEFAULT_VAULT_NAME,
  vaults: { [DEFAULT_VAULT_NAME]: { path: join(configDir, DEFAULT_VAULT_NAME), mcp: ['local'] } },
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
  const vaults = config.vaults ?? {};

  for (const [name, entry] of Object.entries(vaults)) {
    if (!entry.path && !(entry.origin && entry.origin.length)) {
      throw new ConfigError(`vaults.${name}`, 'needs an origin and/or a path');
    }
  }
  if (config.autodiscover && !config.vaultsDir) {
    throw new ConfigError('autodiscover', 'requires vaultsDir to scan');
  }
  // `default` must name an explicit vault; with autodiscover it may name a discovered
  // folder we can't see here, so only enforce when not auto-discovering.
  if (config.default && !vaults[config.default] && !config.autodiscover) {
    throw new ConfigError('default', `names a vault that does not exist: "${config.default}"`);
  }
  return config;
};

// Read + validate ${configDir}/vaults.json. A MISSING file is not an error - it yields
// the zero-config default (a single local vault under the config dir), so the server
// runs with no setup. Bad JSON or an invalid shape still throw ConfigError.
export const loadConfig = async (opts: { configDir?: string } = {}): Promise<VaultsConfig> => {
  const dir = getConfigDir(opts.configDir);
  const file = join(dir, 'vaults.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return zeroConfig(dir);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError('vaults.json', `invalid JSON: ${(e as Error).message}`);
  }
  return validateConfig(raw);
};
