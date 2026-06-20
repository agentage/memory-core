import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../backends/git.js';
import { getConfigDir } from '../config/config.js';
import type { VaultsConfig } from '../contract/types.js';
import { expandPath } from '../registry/registry.js';

export interface InitOptions {
  configDir?: string;
  vaultName?: string;
  vaultPath?: string;
}

export interface InitResult {
  configDir: string;
  configPath: string;
  vaultName: string;
  vaultPath: string;
  createdConfig: boolean;
  createdRepo: boolean;
}

const SCHEMA_URL = 'https://memory.agentage.io/schema/vaults.json';

// `agentage init` (local setup): create ~/.agentage (0700), a starter vaults.json,
// and git-init the vault folder. Idempotent (never clobbers an existing config) and
// strictly offline - no auth, no remote. Returns what it did.
export const init = async (opts: InitOptions = {}): Promise<InitResult> => {
  const configDir = getConfigDir(opts.configDir);
  const vaultName = opts.vaultName ?? 'personal';
  const vaultPath = expandPath(opts.vaultPath ?? join(homedir(), 'memory'));
  const configPath = join(configDir, 'vaults.json');

  if (!existsSync(configDir)) await mkdir(configDir, { recursive: true, mode: 0o700 });

  let createdConfig = false;
  if (!existsSync(configPath)) {
    const config: VaultsConfig = {
      $schema: SCHEMA_URL,
      version: 1,
      default: vaultName,
      vaults: { [vaultName]: { path: vaultPath, mcp: ['local'] } },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    createdConfig = true;
  }

  await mkdir(vaultPath, { recursive: true });
  let createdRepo = false;
  if (!existsSync(join(vaultPath, '.git'))) {
    await createGit(vaultPath).run(['init', '-b', 'main']);
    createdRepo = true;
  }

  return { configDir, configPath, vaultName, vaultPath, createdConfig, createdRepo };
};
