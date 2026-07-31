// Process-level git access for the bare store. Spawns are the real cost of a
// file-backed store, so this module keeps them countable (onSpawn) and provides
// the two spawn-savers: version() reads the ref FILE (zero spawns) and
// batchRead() fetches N docs through one `cat-file --batch` process.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SHA_RE = /^[0-9a-f]{40}$/;

export interface RunOpts {
  input?: string;
  indexFile?: string;
  date?: string;
  author?: { name: string; email: string };
  timeoutMs?: number;
}

export interface GitRunner {
  run(args: string[], opts?: RunOpts): Promise<string>;
  tryRun(args: string[], opts?: RunOpts): Promise<string | null>;
  batchRead(ref: string, paths: string[]): Promise<Map<string, string>>;
  readVersion(): Promise<string | null>;
  ensureRepo(): Promise<void>;
  repoExists(): boolean;
}

export const createGitRunner = (
  gitDir: string,
  onSpawn: (args: string[]) => void = () => {}
): GitRunner => {
  const env = (opts: RunOpts): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: gitDir,
      // Author = the connected client when attributed; committer is always the
      // system identity so the store owns the commit.
      GIT_AUTHOR_NAME: opts.author?.name ?? 'agentage memory',
      GIT_AUTHOR_EMAIL: opts.author?.email ?? 'memory@agentage.io',
      GIT_COMMITTER_NAME: 'agentage memory',
      GIT_COMMITTER_EMAIL: 'memory@agentage.io',
    };
    if (opts.indexFile) e.GIT_INDEX_FILE = opts.indexFile;
    if (opts.date) {
      e.GIT_AUTHOR_DATE = opts.date;
      e.GIT_COMMITTER_DATE = opts.date;
    }
    return e;
  };

  const run = (args: string[], opts: RunOpts = {}): Promise<string> =>
    new Promise((resolve, reject) => {
      onSpawn(args);
      const child = execFile(
        'git',
        args,
        { env: env(opts), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 0 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });

  const tryRun = async (args: string[], opts: RunOpts = {}): Promise<string | null> => {
    try {
      return await run(args, opts);
    } catch {
      return null;
    }
  };

  // One process for N docs. Responses come back in request order:
  // "<oid> <type> <size>\n<bytes>\n" per hit, "<request> missing\n" per miss.
  const batchRead = (ref: string, paths: string[]): Promise<Map<string, string>> =>
    new Promise((resolve) => {
      if (!paths.length || !existsSync(gitDir)) return resolve(new Map());
      onSpawn(['cat-file', '--batch']);
      const child = execFile(
        'git',
        ['cat-file', '--batch'],
        { env: env({}), maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout) => {
          if (err) return resolve(new Map());
          const out = new Map<string, string>();
          const buf = stdout as unknown as Buffer;
          let off = 0;
          for (const p of paths) {
            const nl = buf.indexOf(0x0a, off);
            if (nl < 0) break;
            const header = buf.subarray(off, nl).toString('utf8');
            off = nl + 1;
            if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;
            const size = Number(header.split(' ')[2]);
            if (!Number.isFinite(size)) break;
            out.set(p, buf.subarray(off, off + size).toString('utf8'));
            off += size + 1;
          }
          resolve(out);
        }
      );
      child.stdin?.end(paths.map((p) => `${ref}:${p}`).join('\n') + '\n');
    });

  // The version token without a spawn: refs/heads/main is a plain sha file in a
  // bare repo (update-ref writes it atomically); packed-refs covers a gc'd repo.
  const readVersion = async (): Promise<string | null> => {
    try {
      const v = (await readFile(join(gitDir, 'refs', 'heads', 'main'), 'utf8')).trim();
      if (SHA_RE.test(v)) return v;
    } catch {
      // fall through to packed-refs
    }
    try {
      const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        if (line.endsWith(' refs/heads/main') && SHA_RE.test(line.slice(0, 40))) {
          return line.slice(0, 40);
        }
      }
    } catch {
      // no packed-refs either
    }
    return null;
  };

  let ready: Promise<void> | undefined;
  const ensureRepo = (): Promise<void> => {
    if (!ready) {
      ready = existsSync(gitDir)
        ? Promise.resolve()
        : mkdir(dirname(gitDir), { recursive: true }).then(async () => {
            await run(['init', '--bare', '-b', 'main', gitDir]);
          });
      ready.catch(() => (ready = undefined));
    }
    return ready;
  };

  return { run, tryRun, batchRead, readVersion, ensureRepo, repoExists: () => existsSync(gitDir) };
};
