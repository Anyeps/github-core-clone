# forge — a single-process GitHub-compatible git forge

Node 22 + TypeScript, standard library only. No dependencies, no build step, no
network, no git binary. Run as `node main.ts` (Node 22 type-stripping).

## What it serves

- **Git smart HTTP** (`git-protocol.ts`, `git-objects.ts`, `git-pack.ts`): upload-pack
  v2 (`ls-refs`, `fetch`, shallow/deepen, sideband packfile) and v0, receive-pack v0
  with report-status. Packfiles are written plain (no deltas) and read with full
  OFS_DELTA / REF_DELTA resolution. Fast-forward is enforced per ref; a refused
  update still answers `unpack ok` with an `ng … non-fast-forward` line.
- **REST v3** (`rest.ts`): repos, branches, commits, contents (real git commits),
  labels, issues, comments, pull requests, squash merge with three-way conflict
  detection. Pagination through `Link: rel="next"`.
- **GraphQL** (`graphql.ts`): a small executor for the gh CLI documents — `viewer`,
  `repository` (fields, issues, pullRequests, `__type` introspection), `node(id:)`,
  and the createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations. Unknown fields answer 200 with `errors[]`.
- **MCP** (`mcp.ts`): JSON-RPC 2.0 over Streamable HTTP — `server/discover`
  (2026-07-28 era), legacy `initialize`, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`)
  sharing the same store as REST.

## Determinism

All state is in memory (`store.ts`). Every timestamp comes from the trial clock
(`MAKEFUN_TRIAL_NOW` + a counter) — no `Date.now()`, no randomness, no UUIDs —
so a live trial and its replay produce byte-identical exports. The token's owner
is the scenario viewer (`adaiversen`); any other owner reads 404, never 403.

## Performance

Raw `node:http`, explicit `Content-Length`, a request-id counter, no logging in
the hot path. Shallow-clone packs are cached per (repo version, wants, haves,
depth) and invalidated on every ref move, so 50 concurrent clones share one pack
build. Issue reads/writes are synchronous Map lookups with small prebuilt JSON.
