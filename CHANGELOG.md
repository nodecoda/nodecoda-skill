# Changelog

All notable changes to this distribution repository will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - 示例语法校验门 + 4 个新示例 (v0.2.16)

**校验门（治理先行）**：

- 新增 `scripts/validate-examples.mjs` — `.ncoda` 示例的结构化语法门，补上此前
  只有头部检查的缺口：`@language`/`@mode` 头部与顺序、`@conversation` 必须位于
  顶层声明之前（实证 G1）、全文件括号配平（模板串感知，Python source 块与
  `${}` 插值不误报）、顶层声明形状（const/type/enum/function/code/@conversation）、
  保留字禁止作声明名（实证 G8，覆盖 const/let/var/type/enum/function/code、
  参数、循环变量、@conversation 变量）、模式感知语句检查（workflow 禁 `answer()`、
  advanced-chat 禁 `output()`、`while` 必须带 `limit N`、`attempt` 必须含
  success/failure 块）。
- 新增 `scripts/test-examples.mjs` — 校验门自身回归（真实示例全过 + 10 个合成
  坏样例被拒 + 5 个易误报的合法写法不被拒），接入 `npm test` / `test:all`。
- `npm run lint` / `validate` 现同时跑 validate-skill + validate-language-pack +
  validate-examples 三道门。

**示例扩充（examples/ 4 → 8 个）**：

- `05-conditional-output.ncoda` — 条件分支 + 命名多输出：`if/else if/else`、
  比较运算、`output("key", value)`。
- `06-error-handling.ncoda` — 错误处理：`attempt/success/failure` +
  `with retry(max, interval), timeout(duration)` 操作策略叠加。
- `07-structured-extract.ncoda` — 结构化抽取：`extract<T>` + 具名 record +
  `.ok/.reason/.value` 检查 + 数组字段 + 三元表达式。
- `08-tool-and-http.ncoda` — 工具 + HTTP + LLM 链：`tool()`、`http()`、
  模板字符串 URL、结果字段访问。
- `manifest.examples` 扩到 8 项；`examples/README.md` 表格与"后续添加"清单
  同步（剩余 backlog：advanced-chat/知识库/会话变量/循环集合操作/parallel for/enum）；
  `language-reference.md` §13 常见模式速查表补示例文件列（同步重算
  language-pack `version.json` source_hash）。


## [0.2.14] — 2026-08-13

### Added - References 目录规范与实证文档

确立 `references/` 内容规范（放什么/什么格式），见 `docs/references-convention.md`：
5 类 12 文件 + 索引，统一来源声明/实证标注/对照表格式模板。

合入 3 份高价值文档（此前只在工作分支，发布包缺失）：

- `references/grammar-reference.md` — EBNF 文法参考（源真理 `lang/docs/dify-dsl.y` + `parser.py`，尾部带源码对照表）；
- `references/diagnostics-map.md` — 实证诊断码 → 修复动作映射表（真实 Build 回写）；
- `references/gotchas.md` — 实证反模式清单 G1–G8（现象 → 原因 → 正确写法）；
- `references/README.md` — 索引与维护规则。

`manifest.references` 扩到 13 项；`validate-skill.mjs` 新增反向校验：
references/ 下存在的 .md 必须声明在 manifest 中（防漏声明）；SKILL.md 参考区
同步补全链接。

## [0.2.13] — 2026-08-13

### Added - CLI `--version` / `-v`

`npx -y @nodecoda/skill --version`（安装自检最常用命令）之前报
`unknown subcommand: --version`。现在直接输出 package.json 版本号
（单一事实源，与 manifest 同步），`-v` 同义；help 文案同步补充。

## [0.2.12] — 2026-08-12

### Fixed - MCP stdio 应答帧格式：回显客户端输入格式（Claude Code JSONL 兼容）

Claude Code 2.1.132 的 MCP stdio 桥按**换行分隔 JSON（JSONL）**中继/解析，
只接受 `{...}\n` 格式的应答；老式 LSP `Content-Length` 帧（正文无尾换行）
永远不会被交付，导致 `claude mcp list` 对 `nodecoda` 报
`Failed to connect`，agent 拿不到 `build_dify_workflow` 工具——"无感 MCP"
因此从未真正生效。现代 MCP 规范（2025-11-25）与官方 SDK 的 stdio 传输
同样使用 JSONL。

修复：`scripts/mcp-stdio-server.mjs` 现在**回显客户端的输入帧格式**——
`parseFrame` 为每条消息标记线格式（`jsonl`/`lsp`），`runStdioMcp` 按首个
消息的格式切换应答帧。Claude Code（JSONL）收到 JSONL 应答，秒连；
Codex/Gemini/Cursor 等 LSP 客户端保持 `Content-Length` 帧不变。
不硬编码客户端名，新旧 SDK 客户端全部自适应。

验证：`claude mcp list` 中 `nodecoda` 由 `✗ Failed to connect`
变为 `✓ Connected`（同机对照：官方 filesystem 服务器、插件桥均 ✓，
纯 LSP 应答的极简服务器 ✗）。framing 单测新增 kind 标记与 jsonl 输出
回归（17 passed）。

## [0.2.11] — 2026-08-12

### Fixed - 显式目录的 scope 判定（home 前缀误判）

`add <name> ./.codex/skills`（或任何在 `$HOME` 下的项目工作区，如
`~/work/proj/.codex/skills`）之前被 `dest.startsWith(homedir())` 误判为
"用户级"，导致 MCP 配置写到 `~/.codex/config.toml` 而不是项目
`.codex/config.toml`。现在按**平台对应的 HOME agent 目录**判定
（`~/.claude`、`~/.codex` 本身或之下才算 home scope）。`mcp-register <dir>`
同样修正。回归测试：explicit `./.codex/skills` under HOME → 项目级 + MCP 落在
skill 旁（agent-detect #6）。

### CI

- release smoke：先以未缓存 `npm view` 轮询 registry（≤3 分钟）再 `npx` 安装，
  消除 npm CDN 传播延迟导致的偶发 ETARGET；smoke 改走显式目录并断言
  `[mcp_servers.nodecoda]` 自动写入 `.codex/config.toml`。

## [0.2.10] — 2026-08-12

### Added - Seamless MCP auto-registration（真正"无感"接线）

`add`/`install` 之前只复制 skill 文件，**不注册 MCP server**——agent 拿不到
`build_dify_workflow` 三个工具，只能靠 SKILL.md 里的 npx 命令绕路。v0.2.10 起
装完 skill 后自动为当前代理注册 `nodecoda` MCP server：

- **Claude Code** — `claude mcp add nodecoda --scope user|project -- npx -y @nodecoda/skill mcp`（走官方 CLI，写 `~/.claude.json` 或 `.mcp.json`）
- **Codex** — 向 `~/.codex/config.toml`（或项目 `config.toml`）幂等追加 `[mcp_servers.nodecoda]`（零安装 stdio：`command = "npx"`）
- **Gemini CLI** — 向 `~/.gemini/settings.json` 合并 `mcpServers.nodecoda`
- **Cursor** — 向 `.cursor/mcp.json` 合并 `mcpServers.nodecoda`

注册逻辑（`scripts/mcp-register.mjs`）幂等、失败不阻断安装（只警告并给出手动
命令）。新增 `nodecoda-skill mcp-register <target>` 子命令，可单独修复/重注册。

### Changed - `add` 的落位层级：环境会话 → 用户级

- 代理会话内执行 `add`（如 Claude Code 会话）→ 装到**用户级**（`~/.claude/skills`），
  而不是当前项目的 `.claude/skills`——"装一次，处处可用"；
- 项目里已有该代理目录（`.claude/`、`.codex/` 等）→ 仍是**项目级**（MCP 也按
  project scope 注册）；
- 无信号兜底 → Codex 用户级（`~/.codex/skills`，此前是项目级）；
- 显式指定平台名（`add ... codex`）→ 用户级；显式目录 → 精确落位。

### Fixed - 旧版 skill 命令不可用

0.2.0 的 SKILL.md 用的是 `node scripts/project.mjs ...`（脚本只在 npm 包根，
skill 目录里没有），导致装在 `~/.claude/skills` 的旧 skill 报
`Cannot find module .../scripts/project.mjs`。0.2.8+ 已全量改为 npx 形式，
`add` 重装即可修复；本版再加 MCP 自动注册，装完两条腿都齐。

### Tests

- `scripts/test-mcp-register.mjs` — 47 项：TOML/JSON 幂等合并、假 claude CLI
  参数断言（`--scope user|project`）、路径推断、`registerMcp` 编排；
- `test-agent-detect.sh` 更新为 10 项：用户级/项目级落位 + MCP 副作用断言；
- `test-contract.mjs` 的 `smokeCliInstall` 同步新语义（假 HOME + 假 claude，
  不碰真实配置）。
- 全套 170 项检查绿。

## [0.2.9] — 2026-08-12

### Fixed - npm tarball: `validate-skill.mjs` now ships

- `scripts/validate-skill.mjs` was missing from `package.json` `files`, so
  `nodecoda-skill validate` inside the published package would fail (the CLI
  re-execs it). Caught by the new distribution-completeness guard in the
  contract suite; added to `files`.

### Added - Test governance round

- `scripts/test-save-build.mjs` — stub-backed coverage for the last shipped
  script with zero tests (SUCCEEDED artifact+record+sha256, FAILED
  record-only, missing key / missing build id). Wired into `npm test` /
  `test:all`.
- Contract suite: distribution-completeness guard (every script referenced by
  shipped docs or executable by `cli.mjs` must exist and be in `files`),
  tarball key-content check (LICENSE / NOTICE / bilingual README / CHANGELOG /
  skill), CLI `info`-no-arg usage edge. Suite is now 118 checks.
- `.github/workflows/e2e.yml` — manual `workflow_dispatch` job running a real
  build against www.nodecoda.com (requires `E2E_NODECODA_KEY` secret); not in
  push/PR gating.

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
