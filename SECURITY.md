# Security

The store is the trust boundary between untrusted input (paths, doc content, queries - from any MCP client or API caller) and the filesystem. Controls live in the contract layer and are enforced by the conformance kit, so every implementation inherits the same bar.

| Threat                                               | Control                                                                         | Enforced by                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Path traversal / escape                              | `safePath`: relative-only, no `..`, no control chars                            | `security-suite` hostile-path corpus                     |
| Reserved-namespace injection (`.git/`, `.agentage/`) | `safePath` reserved-segment rejection (case-insensitive)                        | same corpus                                              |
| Tenant escape via crafted ids                        | `SAFE_SEGMENT` allowlist + `parseMemoryId`                                      | contract tests                                           |
| Secrets/PII persisted into memory                    | restricted-data screen on write/edit (body + frontmatter); refuse, never redact | restricted corpus + benign corpus (false-positive guard) |
| Context flooding                                     | 64KB read clamp with truncation marker                                          | conformance                                              |
| Storage abuse                                        | 8MB per-doc cap, search page cap 50, list budgets                               | conformance                                              |
| YAML abuse                                           | codec never throws, alias expansion bounded test                                | conformance                                              |
| Partial-state corruption                             | failed write leaves prior doc + emits no event                                  | conformance                                              |

Planned with the git stores: pushed-content validation (`validateTree` pre-receive), symlink non-following, git args hygiene corpus, SSRF policy for webhook hooks, FTS injection corpus, nightly fuzzing.

Report issues directly to the repo owner (private repo).
