// Edit semantics defined ONCE - every store applies edits through this, so
// replace/append/str_replace behave identically across implementations.

import type { EditInput } from './types.js';

// str_replace mirrors Anthropic's memory/text-editor tool contract verbatim
// (exact + unique match, canonical error strings) - models are RL-trained on
// these exact phrasings, so bespoke wording would waste that prior.
const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

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
  const at = starts[0] ?? 0;
  // Literal splice - String.replace would interpret $-patterns in newStr.
  return body.slice(0, at) + newStr + body.slice(at + oldStr.length);
};

export interface DocContent {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Frontmatter shallow-merges; body follows the mode.
export const applyEdit = (existing: DocContent, input: EditInput): DocContent => {
  const frontmatter = { ...existing.frontmatter, ...(input.frontmatter ?? {}) };
  const body =
    input.mode === 'str_replace'
      ? strReplace(existing.body, input.path, input.old_str ?? '', input.new_str ?? '')
      : input.body === undefined
        ? existing.body
        : input.mode === 'append'
          ? `${existing.body}${existing.body.endsWith('\n') ? '' : '\n'}${input.body}`
          : input.body;
  return { frontmatter, body };
};
