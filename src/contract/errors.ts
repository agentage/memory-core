// Typed error taxonomy: consumers map `code`, never regex messages (message
// TEXT stays canonical - models are trained on it). Not-found is modeled by
// null/false returns and is never thrown.
//
// Mapping table (the one true rendering, for every surface):
//   code            HTTP   MCP tool result
//   invalid_path    400    isError, message verbatim
//   doc_too_large   413    isError, message verbatim
//   restricted      422    isError, message verbatim (canonical refusal)
//   wire_version    400    n/a (transport-level)

export type StoreErrorCode = 'invalid_path' | 'doc_too_large' | 'restricted' | 'wire_version';

export class StoreError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export const storeErrorCode = (err: unknown): StoreErrorCode | undefined =>
  err instanceof StoreError ? err.code : undefined;
