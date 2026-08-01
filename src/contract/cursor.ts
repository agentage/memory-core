// One cursor idiom for every paged surface: opaque base64 offset token.

export const decodeCursor = (cursor?: string): number =>
  cursor ? Number(Buffer.from(cursor, 'base64').toString()) || 0 : 0;

export const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset)).toString('base64');
