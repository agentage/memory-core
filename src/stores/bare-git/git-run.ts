// Process-level git access for the bare store. EVERY git spawn in this package
// goes through here: one countable place (onSpawn) and one hermetic environment,
// so engine semantics never depend on the host's gitconfig or ambient vars. Also
// the two spawn-savers: version() reads the ref FILE (zero spawns) and
// batchRead() fetches N docs through one `cat-file --batch` process. And the one
// place that separates "git answered no" from "git could not run".

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StoreError } from '../../contract/errors.js';

const SHA_RE = /^[0-9a-f]{40}$/;

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const BATCH_MAX_BUFFER = 256 * 1024 * 1024;

// A process that never ran (missing binary, EACCES) or was killed (timeout, byte
// cap) carries NO answer - only git's own non-zero exits may read as "no".
const infraFailure = (err: unknown): string | null => {
  const e = err as { code?: unknown; killed?: boolean; signal?: string | null };
  if (typeof e?.code === 'string') return e.code;
  if (e?.killed || e?.signal) return `killed ${e?.signal ?? 'by signal'}`;
  return null;
};

const unavailable = (what: string, err: unknown): StoreError =>
  err instanceof StoreError
    ? err
    : new StoreError('unavailable', `git store unavailable: ${what}`, { cause: err });

// Only an absent file is "not there"; EACCES and friends are infrastructure.
const isMissingFile = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export interface RunOpts {
  input?: string;
  indexFile?: string;
  date?: string;
  author?: { name: string; email: string };
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface GitRunner {
  run(args: string[], opts?: RunOpts): Promise<string>;
  tryRun(args: string[], opts?: RunOpts): Promise<string | null>;
  runBuffer(args: string[], opts?: RunOpts): Promise<Buffer>;
  batchRead(ref: string, paths: string[]): Promise<Map<string, string>>;
  readVersion(): Promise<string | null>;
  ensureRepo(): Promise<void>;
  repoExists(): boolean;
}

export const createGitRunner = (
  gitDir: string,
  onSpawn: (args: string[]) => void = () => {}
): GitRunner => {
  // Hermetic: git sees ONLY what the engine states, never the host's ambient
  // environment. PATH is the single legitimate inherited value (it finds the git
  // binary); HOME is withheld and both config files are voided, so a machine's
  // gitconfig (autocrlf, hooksPath, identity, proxies...) can't alter semantics.
  const env = (opts: RunOpts): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_DIR: gitDir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
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

  const exec = (
    args: string[],
    opts: RunOpts,
    encoding: 'utf8' | 'buffer'
  ): Promise<string | Buffer> =>
    new Promise((resolve, reject) => {
      onSpawn(args);
      const child = execFile(
        'git',
        args,
        {
          env: env(opts),
          encoding,
          maxBuffer: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
          timeout: opts.timeoutMs ?? 0,
        },
        (err, stdout) => {
          if (!err) return resolve(stdout);
          const infra = infraFailure(err);
          reject(infra ? unavailable(`${args[0]} (${infra})`, err) : err);
        }
      );
      if (opts.input !== undefined) {
        child.stdin?.on('error', () => {}); // a spawn that died owns its failure via the callback
        child.stdin?.end(opts.input);
      }
    });

  const run = async (args: string[], opts: RunOpts = {}): Promise<string> =>
    (await exec(args, opts, 'utf8')) as string;

  // Binary stdout (bundles, packfiles) - same env, same spawn accounting.
  const runBuffer = async (args: string[], opts: RunOpts = {}): Promise<Buffer> =>
    (await exec(args, opts, 'buffer')) as Buffer;

  // null = git ran and said no (grep found nothing, object missing). An
  // infrastructure failure is NOT an answer, so it keeps travelling.
  const tryRun = async (args: string[], opts: RunOpts = {}): Promise<string | null> => {
    try {
      return await run(args, opts);
    } catch (err) {
      if (err instanceof StoreError) throw err;
      return null;
    }
  };

  // One process for N docs. Responses come back in request order:
  // "<oid> <type> <size>\n<bytes>\n" per hit, "<request> missing\n" per miss.
  const batchRead = async (ref: string, paths: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    if (!paths.length || !existsSync(gitDir)) return out;
    // Misses are IN-BAND ("<request> missing"), so a non-zero exit here means the
    // repo could not be read at all - never a not-found.
    const buf = await runBuffer(['cat-file', '--batch'], {
      input: paths.map((p) => `${ref}:${p}`).join('\n') + '\n',
      maxBufferBytes: BATCH_MAX_BUFFER,
    }).catch((err: unknown) => {
      throw unavailable('cat-file --batch', err);
    });
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
    return out;
  };

  // The version token without a spawn: refs/heads/main is a plain sha file in a
  // bare repo (update-ref writes it atomically); packed-refs covers a gc'd repo.
  const readVersion = async (): Promise<string | null> => {
    try {
      const v = (await readFile(join(gitDir, 'refs', 'heads', 'main'), 'utf8')).trim();
      if (SHA_RE.test(v)) return v;
    } catch (err) {
      // absent ref = fall through to packed-refs; unreadable = not an empty vault
      if (!isMissingFile(err)) throw unavailable('read refs/heads/main', err);
    }
    try {
      const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        if (line.endsWith(' refs/heads/main') && SHA_RE.test(line.slice(0, 40))) {
          return line.slice(0, 40);
        }
      }
    } catch (err) {
      if (!isMissingFile(err)) throw unavailable('read packed-refs', err);
    }
    return null;
  };

  let ready: Promise<void> | undefined;
  const ensureRepo = (): Promise<void> => {
    if (!ready) {
      ready = existsSync(gitDir)
        ? Promise.resolve()
        : mkdir(dirname(gitDir), { recursive: true })
            .then(async () => {
              await run(['init', '--bare', '-b', 'main', gitDir]);
            })
            // A vault that cannot be created is infrastructure, not a bad request.
            .catch((err: unknown) => {
              throw unavailable('init --bare', err);
            });
      ready.catch(() => (ready = undefined));
    }
    return ready;
  };

  return {
    run,
    tryRun,
    runBuffer,
    batchRead,
    readVersion,
    ensureRepo,
    repoExists: () => existsSync(gitDir),
  };
};
