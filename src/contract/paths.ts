// memoryId = "<userId>/<vault>". Each segment is allowlisted (url-safe charset +
// length bound) before it becomes a path component, so traversal, control chars,
// extra slashes, and `.git`-style names are all rejected.
export const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export const isSafeSegment = (s: string): boolean => SAFE_SEGMENT.test(s);

const hasControlChar = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20);

export const parseMemoryId = (memoryId: string): { userId: string; vault: string } => {
  const parts = memoryId.split('/');
  const userId = parts[0] ?? '';
  const vault = parts.length === 1 ? 'default' : (parts[1] ?? '');
  if (parts.length > 2 || !SAFE_SEGMENT.test(userId) || !SAFE_SEGMENT.test(vault)) {
    throw new Error(`invalid memoryId: ${JSON.stringify(memoryId)}`);
  }
  return { userId, vault };
};

// Namespaces no user path may enter: git internals and the reserved system
// namespace (versioned store config - hooks etc. - reachable only via system APIs).
const RESERVED_SEGMENTS = new Set(['.git', '.agentage']);

// A doc path safe to store: relative, no traversal, no control chars, no reserved segment.
export const safePath = (p: string): boolean =>
  !!p &&
  !p.startsWith('/') &&
  !p.includes('..') &&
  !hasControlChar(p) &&
  !p.split('/').some((seg) => RESERVED_SEGMENTS.has(seg.toLowerCase()));

export const assertSafePath = (p: string): void => {
  if (!safePath(p)) throw new Error(`invalid path: ${JSON.stringify(p)}`);
};
