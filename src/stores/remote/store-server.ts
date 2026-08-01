// Reference HTTP handler exposing ANY VaultStore over a thin JSON wire (one
// POST per verb, bearer auth). This is what a service mounts to make a vault
// remotely reachable; createRemoteStore is its client. Mutation responses carry
// the events the operation emitted server-side, so the client can re-emit them
// and no-op semantics survive the wire.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { storeErrorCode } from '../../contract/errors.js';
import type { StoreEvent, VaultStore } from '../../contract/vault-store.js';

const VERBS = new Set(['read', 'list', 'search', 'write', 'edit', 'delete', 'version', 'refresh']);
export const WIRE_VERSION = '1';
const MAX_BODY = 32 * 1024 * 1024; // fits an 8MB doc with JSON escaping headroom

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export const createStoreHandler = (
  store: VaultStore,
  opts: { token?: string } = {}
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const withEvents = async <T>(
    fn: () => Promise<T>
  ): Promise<{ value: T; events: StoreEvent[] }> => {
    const events: StoreEvent[] = [];
    const off = store.subscribe((e) => events.push(e));
    try {
      return { value: await fn(), events };
    } finally {
      off();
    }
  };

  return async (req, res) => {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-store-wire': WIRE_VERSION });
      res.end(JSON.stringify(payload));
    };
    try {
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        return send(401, { error: { code: 'unauthorized', message: 'bad token' } });
      }
      const wire = req.headers['x-store-wire'];
      if (wire !== undefined && wire !== WIRE_VERSION) {
        return send(400, {
          error: { code: 'wire_version', message: `unsupported wire version: ${String(wire)}` },
        });
      }
      const verb = (req.url ?? '').replace(/^\//, '');
      if (req.method !== 'POST' || !VERBS.has(verb)) {
        return send(404, { error: { code: 'not_found', message: `no such verb: ${verb}` } });
      }
      const args = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      const { value, events } = await withEvents(async () => {
        switch (verb) {
          case 'read':
            return store.read(args.path as string, args.opts as never);
          case 'list':
            return store.list(args.query ?? {});
          case 'search':
            return store.search(args.query as never);
          case 'write':
            return store.write(args.input as never, args.author as never);
          case 'edit':
            return store.edit(args.input as never, args.author as never);
          case 'delete':
            return store.delete(args.path as string);
          case 'version':
            return store.version();
          default:
            return store.refresh();
        }
      });
      send(200, { value, events });
    } catch (err) {
      const code = storeErrorCode(err) ?? 'store_error';
      send(422, { error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  };
};
