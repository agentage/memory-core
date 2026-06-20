// Pure helpers for LocalBackend (path safety, str_replace, edit-body, git output parsing).
import type { EditInput } from '../contract/types.js';

const ISO_LINE = /^\d{4}-\d\d-\d\dT/;

export const safePath = (p: string): boolean =>
  !!p &&
  !p.startsWith('/') &&
  !p.includes('..') &&
  ![...p].some((c) => c.charCodeAt(0) < 0x20) &&
  !p.split('/').includes('.git');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

// str_replace mirrors Anthropic's memory/text-editor tool contract verbatim
// (exact + unique match, canonical error strings).
export const strReplace = (body: string, path: string, oldStr: string, newStr: string): string => {
  const starts: number[] = [];
  for (let i = body.indexOf(oldStr); i !== -1; i = body.indexOf(oldStr, i + 1)) starts.push(i);
  if (starts.length === 0) {
    throw new Error(
      `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`
    );
  }
  if (starts.length > 1) {
    throw new Error(
      `Multiple occurrences of old_str \`${oldStr}\` in ${path} (lines: ${starts
        .map((s) => lineOf(body, s))
        .join(', ')}). Please ensure it is unique.`
    );
  }
  return body.slice(0, starts[0]) + newStr + body.slice(starts[0] + oldStr.length);
};

// Resolve the new body from an edit's mode against the existing body.
export const editBody = (existingBody: string, input: EditInput): string => {
  if (input.mode === 'str_replace') {
    return strReplace(existingBody, input.path, input.old_str ?? '', input.new_str ?? '');
  }
  if (input.body === undefined) return existingBody;
  if (input.mode === 'append') {
    return `${existingBody}${existingBody.endsWith('\n') ? '' : '\n'}${input.body}`;
  }
  return input.body;
};

// One `git log --name-only` pass -> path -> most-recent commit date (newest first).
export const parseMtimes = (log: string | null): Map<string, string> => {
  const map = new Map<string, string>();
  if (!log) return map;
  let date = '';
  for (const line of log.split('\n')) {
    if (line === '') continue;
    if (ISO_LINE.test(line)) date = line.trim();
    else if (!map.has(line)) map.set(line, date);
  }
  return map;
};

// `git grep -o` (working tree) emits `<path>:<match>` per occurrence -> count per path.
export const parseGrepCounts = (grep: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const line of grep.split('\n')) {
    if (!line) continue;
    const path = line.slice(0, line.indexOf(':'));
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
};

const encode = (offset: number): string => Buffer.from(String(offset)).toString('base64');
const decode = (cursor?: string): number =>
  cursor ? Number(Buffer.from(cursor, 'base64').toString()) || 0 : 0;

export { encode as encodeCursor, decode as decodeCursor };
