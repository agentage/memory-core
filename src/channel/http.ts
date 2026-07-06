// Minimal fetch seam shared by the couch channel client. Matches the slice of the global
// fetch surface this module uses (status + json()), so a host injects globalThis.fetch and
// tests inject a mock with no network. Isomorphic: node 22 and the browser both satisfy it.

export interface FetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;
