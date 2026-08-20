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

Shipped for the bare-git store: pushed content bypasses the write-path guards (a `git push` lands via receive-pack), so the tree itself is checkable. `validateBareRepoTree` is exported from the package root and returns every violation in a ref - `unsafe-path` (the same `safePath` screen, reserved namespaces included), `non-file-mode` (symlinks, submodules, exec bits) and `oversized` (over the 8MB doc cap) - so a pre-receive hook can refuse the push. Nightly fuzzing also runs today (`nightly.yml`: 500 property runs, 25 differential sequences).

Still planned: a git-args hygiene corpus, SSRF policy for webhook hooks, and an FTS injection corpus.

Report vulnerabilities privately via GitHub Security Advisories (Security tab) - do not open public issues.
