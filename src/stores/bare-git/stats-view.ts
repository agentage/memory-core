// First real derived view: aggregate vault stats with true byte sizes. Closes
// over the repo (needs `ls-tree -l`, which the reader contract doesn't expose) -
// the intended pattern for store-specific views.

import { execFile } from 'node:child_process';
import type { DerivedView } from '../../contract/derived.js';

export interface VaultStats {
  files: number;
  folders: number;
  sizeBytes: number;
  empty: boolean;
}

export const createStatsView = (repoDir: string): DerivedView<VaultStats> => ({
  name: 'stats',
  policy: { recompute: 'on-change' },
  compute: (_reader, version) =>
    new Promise((resolve) => {
      const empty: VaultStats = { files: 0, folders: 0, sizeBytes: 0, empty: true };
      if (!version) return resolve(empty);
      execFile(
        'git',
        ['ls-tree', '-r', '-t', '-l', version],
        { env: { ...process.env, GIT_DIR: repoDir }, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(empty);
          let files = 0;
          let folders = 0;
          let sizeBytes = 0;
          for (const line of stdout.split('\n')) {
            if (!line) continue;
            const [, type, , size] = line.slice(0, line.indexOf('\t')).trim().split(/\s+/);
            if (type === 'blob') {
              files++;
              sizeBytes += Number(size) || 0;
            } else if (type === 'tree') {
              folders++;
            }
          }
          resolve({ files, folders, sizeBytes, empty: files === 0 });
        }
      );
    }),
});
