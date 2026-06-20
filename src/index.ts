// @agentage/memory-core public API - the transport-agnostic engine.
// The MCP server layer lives in a separate package that builds on this one.

export * from './contract/types.js';
export {
  serializeDoc,
  parseDoc,
  titleFromPath,
  deriveTags,
  makeSnippet,
} from './contract/memory-doc.js';
