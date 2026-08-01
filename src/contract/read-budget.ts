// Bounds the body a read returns to the model. A memory can be up to the store's per-doc
// cap; returning it verbatim floods the model's context, so read output is clamped to a
// fixed byte budget with a marker making clear the stored file is complete. The clamp
// lives on the read path only - an edit's internal full-body read is untouched.

import { StoreError } from './errors.js';
import type { MemoryView } from './types.js';

// Max UTF-8 bytes of body returned by a read. Not a storage limit - only bounds output.
export const READ_BODY_BUDGET = 64 * 1024;

// Per-doc storage cap, enforced by every store before persisting.
export const MAX_DOC_BYTES = 8 * 1024 * 1024;

export const ensureSize = (content: string): void => {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_DOC_BYTES) {
    throw new StoreError(
      'doc_too_large',
      `document is ${bytes} bytes, over the ${MAX_DOC_BYTES}-byte cap`
    );
  }
};

export interface ClampedBody {
  body: string;
  truncated: boolean;
  totalBytes: number;
}

// Clamp `body` to at most `max` UTF-8 bytes, cutting on a codepoint boundary (a partial
// trailing multi-byte sequence is dropped, never emitted as U+FFFD).
export const clampBody = (body: string, max: number = READ_BODY_BUDGET): ClampedBody => {
  const totalBytes = Buffer.byteLength(body, 'utf8');
  if (totalBytes <= max) return { body, truncated: false, totalBytes };
  const sliced = Buffer.from(body, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/u, '');
  return { body: sliced, truncated: true, totalBytes };
};

// The marker appended after a clamped body. States the shown/total byte counts and that
// the stored file is intact, so a model (or user) knows the note continues on disk.
export const truncationMarker = (shownBytes: number, totalBytes: number): string =>
  `\n\n[Truncated for display: showing the first ${shownBytes} of ${totalBytes} bytes. The stored memory file is complete and unchanged.]`;

// Return a read view whose body is clamped to the budget (marker appended when cut).
export const clampView = (view: MemoryView, max: number = READ_BODY_BUDGET): MemoryView => {
  const clamped = clampBody(view.body, max);
  if (!clamped.truncated) return view;
  return {
    ...view,
    body:
      clamped.body + truncationMarker(Buffer.byteLength(clamped.body, 'utf8'), clamped.totalBytes),
  };
};
