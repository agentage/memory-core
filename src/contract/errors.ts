// Typed error taxonomy: consumers map `code`, never regex messages (message
// TEXT stays canonical - models are trained on it). Not-found is modeled by
// null/false returns and is never thrown; `unavailable` is its opposite - the
// store could not answer at all, so the caller must never read it as absence.
//
// Mapping table (the one true rendering, for every surface):
//   code            HTTP   MCP tool result
//   invalid_path    400    isError, message verbatim
//   doc_too_large   413    isError, message verbatim
//   restricted      422    isError, message verbatim (canonical refusal)
//   wire_version    400    n/a (transport-level)
//   unavailable     503    isError, message verbatim (transient - retryable)

export type StoreErrorCode =
  'invalid_path' | 'doc_too_large' | 'restricted' | 'wire_version' | 'unavailable';

export class StoreError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    message: string,
    // The underlying failure (spawn errno, fs error) - diagnosis needs the cause.
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export const storeErrorCode = (err: unknown): StoreErrorCode | undefined =>
  err instanceof StoreError ? err.code : undefined;
