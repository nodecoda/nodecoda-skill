# Changelog

All notable changes to this distribution repository will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

（进行中；下次发布时归档。）

## [0.2.8] — 2026-08-12

### Added - CLI Project Mode passthrough (npx-reachable project tooling)

- `nodecoda-skill project <cmd> [args]` and `nodecoda-skill save-build <build_id>`
  now re-exec the repo-local Project Mode scripts, so the state machine
  (`init / resolve / get-state / set-state / validate-transition`) and build
  artifact saving work from anywhere via `npx -y @nodecoda/skill project ...`
  — no clone, no global install. The underlying scripts keep their own CLI
  and tests (single source of truth); `SKILL.md` and
  `references/project-workflow.md` now document the npx form.
- Regression coverage: contract suite +5 (project init / get-state /
  set-state / unknown-action / save-build usage routing).

### Changed - License: MIT -> Apache-2.0

- `LICENSE` is the official Apache License 2.0 text; new `NOTICE` (copyright +
  attribution) ships in the npm tarball (`package.json` `files`); package
  metadata `license` and the skill `manifest.json` `license` are now
  consistent (Apache-2.0). README badge updated.

### Changed - Docs: bilingual README + refreshed installation guide

- `README.md` (EN) + new `README.zh-CN.md`: marketing-first rewrite with an
  architecture diagram, quick start, "get an API key" step, compatibility
  matrix, and www.nodecoda.com call-to-action. `docs/installation.md`
  restyled with the same tone (all technical content kept). README links to
  docs/config templates now use absolute GitHub URLs so they survive the npm
  tarball.

### Fixed - public build verified end-to-end (launch blocker resolved)

- Real build with a live key: `QUEUED -> BUILDING -> SUCCEEDED` (2026-08-12),
  Dify Workflow YAML artifact saved with `sha256` verification. The 0.2.0-era
  "L4 launch blocker" (401/503 on the public MCP gateway) is resolved on the
  backend.
- CI resilience: the contract suite's public round-trip probe skips (instead
  of failing) when `www.nodecoda.com` is unreachable, so transient outages no
  longer turn CI red.
- `release.yml`: new post-publish `smoke-npx` job installs the published
  package (`npx add`) and asserts manifest version parity before the release
  is considered done.

### Removed - internal-only tooling and leaked internals (external-readiness audit)

- Deleted `docs/l4-e2e-report.md` (internal docker images/versions, local
  registry, port mappings, admin test credentials, internal endpoints and Go
  source paths, developer home path) and `scripts/test-l4-e2e.sh` (internal
  workspace admin auth flow) + `test:l4`.
- Deleted `scripts/sync-from-upstream.sh` (pulls from the private main repo's
  internal layout) + `sync:check`, the manifest `sync` block, and
  `scripts/test-examples.sh` (requires internal `nclang-compile`) + `test:examples`.
- Removed the `contract-freshness` CI job (referenced the private repo's
  internal paths) and genericized `ncmcp` mentions in `.codex/config.example.toml`.
- Redacted internal absolute paths / source paths from CHANGELOG, README,
  CONTRIBUTING, `references/failure-modes.md`, `scripts/live-mcp.mjs`, and the
  skill CHANGELOG.
- Repository history was re-created as a single clean snapshot commit; the
  prior history (which contained the deleted internal files) is gone from the
  repository.

## [0.2.7] — 2026-08-12

### Fixed - CI (`.github/workflows/ci.yml`)

- `validate-skill` "Check all referenced files exist": fixed a double
  `references/` path prefix that reported every manifest reference as MISSING
  (the manifest entries already carry the `references/` prefix). The check now
  passes locally and in CI.
- New `npm-test` job runs the full `npm test` suite (contract + framing +
  project + http + live-mcp + agent-detect) on every push/PR — previously CI
  never executed the 100+ tests.
- `contract-freshness` job removed: it referenced the private `nodecoda/nodecoda`
  repo's internal layout, which a public runner cannot check out anyway.
- `release.yml` `publish-npm` needs an `NPM_TOKEN` repo secret (granular token
  with Bypass 2FA); the GitHub Release job already succeeds and attaches the
  npm tarball (verified on v0.2.7).
- `release.yml` `verify` guard now reports actionable errors: it distinguishes
  "not a tag ref" (e.g. manual dispatch on `main`) from "tag/version mismatch",
  and prints the exact commands to fix (git tag v<version> && git push).

### Added - Layer 3: one-shot agent-detection test script

- `scripts/test-agent-detect.sh` (`npm run test:agent-detect`): standalone
  automation of the no-target `add` detection matrix (no-signal Codex
  fallback, `CODEX_HOME` session, `CLAUDE_CODE_ENTRYPOINT` session, project
  `.claude` dir, project `.cursor` dir -> `.mdc`). Uses a fake `HOME` so it is
  deterministic on any machine regardless of the operator's own agent config.
  Wired into `npm test` and `test:all`; `smokeCliInstall` in
  `test-contract.mjs` hardened the same way (fake HOME in the spawned env).
## [0.2.6] — 2026-08-12

### Added - Layer 3: agent-aware no-target install

- `add <name>` with no target now **detects the platform** instead of guessing:
  (1) the agent session that invoked the CLI (env markers `CODEX_HOME`,
  `CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_HOME`, `GEMINI_CACHE_DIR`), (2) an
  agent already set up in the current project (`.codex/`, `.claude/`,
  `.gemini/`, `.cursor/`), (3) an agent configured in the home directory,
  (4) Codex project-local fallback. A detected Cursor project generates the
  `.mdc` rule automatically.
- Regression coverage: `smokeCliInstall` in `test-contract.mjs` now exercises
  the no-signal fallback, the Claude Code session-env branch, the project
  `.claude` branch, and the project `.cursor` -> `.mdc` branch (contract 27 ->
  30). `docs/installation.md` Option B documents the detection order.
## [0.2.5] — 2026-08-12

### Fixed - Layer 3: agent platform differences in `add`/`install`

- **Default target**: no-target `add` now prefers project-local **Codex**
  (`.codex/skills`) with a fixed preference order `codex -> claude-code ->
  gemini-cli -> cursor`, falling back to `~/.codex/skills`. Previously it took
  the first entry of `manifest.platforms` (claude-code), contradicting the
  documented intent.
- **Cursor**: `add ... cursor` no longer copies into `.cursor/skills/` (which
  Cursor never reads); it generates `.cursor/rules/nodecoda-workflow.mdc` with
  YAML frontmatter and the SKILL.md content inlined.
- Regression coverage: `smokeCliInstall` in `test-contract.mjs` +2 cases
  (no-target default -> `.codex/skills`; cursor -> `.mdc` with frontmatter +
  skill content). docs/installation.md Option B documents both behaviors.
## [0.2.4] — 2026-08-12

### Removed - Python (pip / uv) distribution channel

- `pyproject.toml`, `docs/installation.md` Option C, the `publish-pypi` job in
  `.github/workflows/release.yml`, and the pyproject version-sync assertion in
  `test-contract.mjs` are removed. npm (`@nodecoda/skill`) is the single
  distribution channel: it covers every mainstream agent via `npx` (MCP server
  and skill installer), so the Python channel had no concrete consumer and only
  added dual-maintenance cost. Reintroduce when a Python-only consumer needs it.
- `.github/workflows/release.yml` GitHub Release job now attaches the npm
  tarball (`npm pack` -> `*.tgz`) instead of the never-uploaded Python
  `dist/*.whl` assets.
## [0.2.3] — 2026-08-12

### Added - Layer 3: npx skill installer (regression-hardened)

- `nodecoda-skill list | info | add | install | validate` — the npx zero-clone
  installer (`npx -y @nodecoda/skill add nodecoda-workflow`) ships in the same
  package as the MCP server. `add`/`install` copy `skills/<name>` into the
  detected agent dir (project `.codex` first, explicit platform or path target
  supported); `validate` runs the full skill contract checks.
- Regression coverage: `smokeCliInstall` in `test-contract.mjs` (6 cases:
  list, info manifest/version sync, full-tree add, codex platform target,
  validate exit 0, unknown-subcommand hint).
- `docs/installation.md` Option B is now marked live (was "planned v0.2.0")
  with target examples; `cli.mjs` header comment updated.
## [0.2.2] — 2026-08-12

### Fixed - Layer 2

- `mcp-stdio-server.mjs` `parseFrame`: the newline-delimited JSON fallback
  (for tooling that skips Content-Length framing) was dead code — `parseFrame`
  returned before reaching it whenever no `\r\n\r\n` header block was present.
  It now parses raw `\n`-delimited JSON messages while still waiting for more
  data on partial header lines; a first line starting with `{`/`[` is treated
  as JSON even when a framed block appears later in the same buffer
  (mixed-framing streams), and the header-block-without-Content-Length fallback
  no longer calls `.trim()` on a Buffer (latent TypeError).
- Regression coverage hardened: `scripts/test-stdio-framing.mjs` unit-tests
  `parseFrame`/`frameMessage` (framed + newline interleave, CRLF bare JSON,
  partial-header wait, chunked bodies, malformed/blank line skipping, header
  block without Content-Length); `smokeCliMcpMixedFraming` in
  `test-contract.mjs` verifies mixed framing over the real CLI process. The
  unit tests also exposed and fixed a second latent bug: the header-block-
  without-Content-Length fallback called `.trim()` on a Buffer, which always
  threw a TypeError.
## [0.2.1] — 2026-08-12

### Added - Layer 1: public MCP endpoint (Streamable HTTP)

- `scripts/mcp-http-server.mjs` — Streamable HTTP MCP server (POST JSON-RPC,
  GET SSE channel, OPTIONS CORS, DELETE 405, 401 without bearer). This is the
  deployable artifact for the public `https://www.nodecoda.com/mcp` endpoint;
  client bearer tokens pass through to the upstream Workspace REST API.
- `scripts/mcp-core.mjs` — shared MCP tool definitions + JSON-RPC dispatch,
  reused by both the stdio and HTTP servers (no duplication between transports).
- `scripts/test-http-server.mjs` — transport tests against a local upstream
  stub (no network): initialize / tools.list / tools.call / auth / CORS / SSE /
  405 / 406 / parse errors. Wired into `npm test` and `test:all`.
- `scripts/mcp-stdio-server.mjs` refactored to delegate to `mcp-core.mjs`
  (behavior unchanged).
- `.codex/config.example.toml` now leads with the remote wiring
  `url = "https://www.nodecoda.com/mcp"` + `bearer_token_env_var = "NODECODA_KEY"`
  (key never in config); local HTTP server / local dev stack / stdio bridge
  kept as commented alternatives.
- `skills/nodecoda-workflow/references/public-service.md` — 公网 MCP 直连部署
  指引: Caddy/Nginx 路由规则、Streamable HTTP 传输约定、Codex 客户端配置、故障提示.
- `docs/installation.md` — MCP wiring section documents the remote endpoint as
  the primary path.
- **Live-gateway fixes (verified against the real deployment)**: upstream base
  corrected from `/api/v1` to `/v1` (the MCP gateway surface that accepts
  `sk-` keys); tool results unwrap the gateway `{ code, message, data }`
  envelope; `get_workflow_build` fetches the raw artifact best-effort and
  attaches `artifact.content`; `live-mcp.mjs` unwraps the envelope and saves
  artifacts via `GET /workflow-builds/{id}/artifact` (previously it could
  never capture the build id or the artifact).
- `resolveUpstreamBase()` exported from `mcp-core.mjs` (single source of truth
  for the upstream base; `mcp-http-server.mjs` reuses it) with unit
  regression coverage for the `/v1` default and override order.
- `scripts/test-live-mcp.mjs` — full-chain regression for `live-mcp.mjs`
  against a stub gateway (envelope unwrap, artifact download + sha256 check,
  Idempotency-Key forwarding, FAILED terminal path). Wired into
  `npm test` / `test:all`.

### Added - Layer 2: npx zero-install MCP wiring

- `nodecoda-skill mcp` subcommand (`scripts/cli.mjs`): serves the MCP server
  in-process over stdio (default) or Streamable HTTP (`--http [--port N]`).
  `mcp-stdio-server.mjs` / `mcp-http-server.mjs` now export `runStdioMcp()` /
  `runHttpMcp()` with an is-main guard so the CLI can serve without a
  subprocess.
- Agents can wire the skill with zero local install:
  `command = "npx"`, `args = ["-y", "@nodecoda/skill", "mcp"]` (key from
  `NODECODA_KEY` at request time; nothing in config).
- Regression coverage: `smokeCliMcp` in `test-contract.mjs` (stdio via the
  CLI) and a `cli mcp --http` wiring test in `test-http-server.mjs`.
## [0.2.0] — 2026-08-11

### Added — Public MCP wiring
- `scripts/mcp-stdio-server.mjs` — stdio MCP/JSON-RPC 2.0 server implementing `build_dify_workflow` / `get_workflow_build` / `cancel_workflow_build` against the public Workspace REST API at `https://www.nodecoda.com/api/v1`. No external deps. LSP-style Content-Length framing with newline-delimited JSON fallback.
- `scripts/live-mcp.mjs` — end-to-end REST demo client. Walks login → key creation → build submission → poll → artifact save, with clear hints and clean skip when creds are missing. Writes artifacts to `./artifacts/<build_id>.{yaml,json}`.
- `.codex/config.toml` — project-local Codex configuration registering `[mcp_servers.nodecoda]` so the current Codex session and any checkout of this repo immediately wires up the 3 MCP tools.
- `skills/nodecoda-workflow/SKILL.md` — "Public Deployment" section with REST endpoints, stdio MCP wiring, and end-to-end verification script.
- `skills/nodecoda-workflow/references/public-service.md` — fully rewritten to document the actual public surface (`/api/v1/*`) plus the planned direct MCP URL (`/mcp` once Cloudflare/Caddy route is added). Includes both raw REST and MCP client paths.

### Changed
- `.gitignore` — narrow `.codex/` ignore to specific subdirs (`state/`, `cache/`, `logs/`, `sessions/`) so `.codex/config.toml` and `.codex/skills/<name>/` can be checked in.

### Verified
- `npm run validate` — OK
- `npm test` — 12 contract tests pass + stdio MCP smoke (initialize / tools.list / tools.call → real `401 INVALID_TOKEN` from `www.nodecoda.com`)
- `node scripts/mcp-stdio-server.mjs` boots cleanly with a fake `NODECODA_KEY`; the three MCP tools are listed and a `get_workflow_build` call round-trips to the live public Workspace API and returns its real error envelope.
- `node scripts/live-mcp.mjs` (no creds) — exits 0 with a clear hint to set `NODECODA_EMAIL` / `NODECODA_PASSWORD` (or `NODECODA_KEY`).

### Known limitations
- The direct JSON-RPC MCP endpoint at `https://www.nodecoda.com/mcp` is currently intercepted by the SPA catch-all; the stdio adapter is the canonical "always works" path until the reverse proxy routes `/mcp` to the MCP backend.

### Fixed — Public MCP path and 503 hint (live-test result, 2026-08-11)

- **Path discovery**: live test against the production deployment showed that the Workflow Build endpoint lives at `https://www.nodecoda.com/v1/workflow-builds` (MCP gateway), **not** `https://www.nodecoda.com/api/v1/workflow-builds` (Workspace admin). Updated `scripts/mcp-stdio-server.mjs` and `scripts/live-mcp.mjs` to use a separate `NODECODA_MCP_BASE` (default `https://www.nodecoda.com/v1`); the admin base stays at `https://www.nodecoda.com/api/v1` for login/keys.
- **L4 launch blocker is still live**: real `sk-...` key authenticated at the Workspace and was accepted by the request validator, but the MCP gateway returns `401 token missing expiration` and the Workspace maps that to `503 WORKFLOW_BUILD_SERVICE_UNAVAILABLE`. Same root cause as the L4 E2E report's finding #8 (`auth.RequireBearerToken` requires JWT exp before the introspect verifier). `scripts/live-mcp.mjs` now special-cases this and prints a clear, actionable hint instead of a bare 503. The failure mode is also documented in `references/failure-modes.md`.

**Net result of live testing the provided key:** the public Workspace accepts the key, but **no public Workflow Build can succeed until the main repo's MCP server auth wiring is fixed and the MCP image is rebuilt and rolled out.**

### Changed - Repository governance (GitHub best practices)

- Renamed `docs/superpowers/` -> `docs/design/` (neutral naming for a cross-agent
  portable repo; `superpowers` was an OMX-specific convention). Internal path
  references updated.
- `.gitignore` now ignores all agent runtime state dirs (`.omx/`, `.omc/`,
  `.omj/`) and auto-generated agent instruction files (`AGENTS.md`,
  `CLAUDE.md`), which were previously untracked root clutter.
- `.codex/config.toml` is now gitignored (it holds a real key). The stale
  duplicate under `.codex/skills/nodecoda-workflow/` was a diverged copy of the
  canonical skill; `.codex/skills/` is now gitignored (local install only -
  recreate via `cp -R skills/nodecoda-workflow .codex/skills/`).
- Removed empty dead `skills/nodecoda-workflow/scripts/` directory.
- `package.json` `test` now runs contract + project state-machine tests; added
  `test:project`, `test:examples`, `test:l4`, `test:all`. `files` now includes
  the operational scripts (`project.mjs`, `save-build.mjs`,
  `validate-project.mjs`, `cli.mjs`, `live-mcp.mjs`, `mcp-stdio-server.mjs`)
  that `SKILL.md` references, so npm/PyPI installs are self-contained.

### Added
- `.codex/config.example.toml` - committed template for local Codex MCP wiring
  (placeholder key; real `config.toml` stays local/gitignored).
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` - community health
  files.
- `.github/PULL_REQUEST_TEMPLATE.md` and `.github/ISSUE_TEMPLATE/`
  (`bug_report.md`, `feature_request.md`, `config.yml`).

### Security
- No API key is committed. `.codex/config.toml` (real key) is gitignored; only
  the `config.example.toml` template ships.

### Verified
- `npm test` - 17 contract + 32 project tests pass.
- `npm run validate` - OK, 0 warnings.
- `node scripts/validate-project.mjs examples/project` - OK.

## [0.1.1] — 2026-08-11

### Added
- `scripts/validate-skill.mjs` — real contract validator (manifest fields, SKILL.md frontmatter, references/examples existence, .ncoda header, anti-slop). Replaces the placeholder `lint` script.
- `scripts/cli.mjs` — working `@nodecoda/skill` CLI with subcommands `list`, `info`, `install`/`add`, `validate`. Recognised install targets: `claude-code`, `codex`, `gemini-cli`, `cursor`, or any path.
- `scripts/test-contract.mjs` — pure-Node contract test suite (12 assertions). Replaces placeholder `test` script. Runs the validator, asserts every .ncoda example builds a valid `build_dify_workflow` request, asserts SKILL.md mentions every declared MCP tool, asserts package metadata version parity.
- `package.json` scripts now point to the real scripts: `lint`, `test`, `validate`, `test:contract`, `cli`, `sync:check`.

### Fixed
- `skills/nodecoda-workflow/manifest.json` `references[]` entries were missing the `references/` path prefix. The validator caught this on first run; all 8 entries now include the correct relative path.

### Changed
- `scripts/sync-from-upstream.sh` gains a `--local <path>` mode and `--ref <ref>` flag, so the sync is testable offline (e.g. against a local clone in CI) and can be pinned to a specific ref instead of always tracking `main`.

### Verified
- `npm run validate` — OK, 0 warnings.
- `npm test` — 12/12 contract tests pass.
- `node scripts/cli.mjs install nodecoda-workflow codex` — installs to `./.codex/skills/nodecoda-workflow/`.
- `scripts/sync-from-upstream.sh --local <path>` — reports no content drift in shared references; the 4 new `references/*.md` files are local-only additions (additive distribution).

## [0.1.0] — 2026-08-11

### Added
- Initial split-out of `nodecoda-workflow` skill from the main NodeCoda repository
- `skills/nodecoda-workflow/SKILL.md` with full workflow contract
- `skills/nodecoda-workflow/references/`:
  - `mcp-contract.md` — 3 MCP tool signatures, polling, cancellation, invariants
  - `source-generation.md` — minimal `.ncoda` and 5 core operations
  - `language-reference.md` — full DSL reference (modes, types, control flow, FFI, stdlib, errors)
  - `public-service.md` — client config, admission, polling, readiness
  - `diagnostics.md` (new) — how to interpret `Diagnostic(code, severity, message, location)`
  - `target-capabilities.md` (new) — Dify 1.16 target profile capability matrix
  - `iteration-loop.md` (new) — build → diagnose → fix bounded loop
  - `failure-modes.md` (new) — `failure_kind` taxonomy and handling
- `skills/nodecoda-workflow/examples/` with 4 runnable `.ncoda` files
- `skills/nodecoda-workflow/manifest.json` with cross-platform metadata
- `package.json` (`@nodecoda/skill`) and `pyproject.toml` (`nodecoda-skill`) — files-only for v0.1.0
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` stubs
- `scripts/sync-from-upstream.sh` to pull content from the main NodeCoda repo
- `docs/installation.md` for per-platform install
