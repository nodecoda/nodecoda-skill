# Changelog

All notable changes to this distribution repository will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.27] - 2026-08-15

### Changed - 减法:去掉 src/builds 拆分,一个目录管全部(源 + 产物)

按「不过度设计、降低心智负担」原则收敛目录结构:
- **build 默认输出 = 源文件同目录**:`build <file.ncoda>` 把 `<source-base>.dify.yaml`
  + `.build.json` 写到源文件旁边,不再默认 `builds/`(--out 保留作显式重定向)。
- **删除 source 副本**:源就在输出目录里,不再复制 `<name>.ncoda`(减一个文件、
  一段逻辑、一组断言)。
- **project init 不再建 src/ 和 builds/**:源文件直接落在项目根
  (`<project>.ncoda`),manifest `source` 同步;不再创建空目录脚手架。
- **.gitignore 删除 builds/ 条目**:产物默认进 git,版本化完全交给用户
  (与「版本由你主动 git 维护」自洽;save-build 的历史归档由用户决定是否提交)。
- **测试**:+「默认输出 = 源目录、无 builds/ 目录、无 source 副本」;happy path
  断言 3 文件→2 文件;init 断言无 src//builds/;examples/project 源文件移到根。
- **文档**:SKILL.md 产物保存/回退/最终报告、project-workflow.md 项目布局、
  Hash fidelity 与 Build loop 的路径全部改为单目录。

## [0.2.26] - 2026-08-15

### Added - 打包完整性校验测试 + device-id 漏包回归 (test-package-integrity)

新增 `scripts/test-package-integrity.mjs`(接入 `npm test` / `test:all`,含独立
`test:package`),锁定 0.2.21..0.2.24 的 `scripts/device-id.mjs` 漏包 bug:
- 白名单健全性:package.json `files` 每个条目都真实存在,展开为打包文件集合;
- 具体回归:`scripts/device-id.mjs` ∈ 白名单,且 `mcp-core.mjs` 仍 import 它
  (回归保持活跃);
- 依赖完整性:打包集合内全部 `.mjs` 的静态相对 import 目标都 ∈ 打包集合
  (防漏包同类问题);
- CLI 分发完整性:`cli.mjs` 每个 `runScript('<name>.mjs')` 子命令目标已打包;
- 真实加载 smoke:把白名单复制到临时目录后 `import mcp-core.mjs` 必须不抛
  `ERR_MODULE_NOT_FOUND`(精确复现旧 bug 的失败模式),`device-id.mjs` 可加载。
- 负向验证:临时移除白名单条目 → 测试以失败退出(exit 1),恢复后全绿。

## [0.2.25] - 2026-08-15

### Changed - 版本管理简化：build 产物平铺覆盖式，不再按 build_id 建目录

- **`build <file.ncoda>` 落盘布局**：`builds/<build_id>/...` → `builds/<source-base>.dify.yaml`
  + `.build.json` + `.ncoda` 平铺固定文件名，每次构建覆盖同名文件。版本化交由用户
  主动 git 维护（改源码 → 重新 build → `git diff` → commit），不再每次构建生成新目录、
  不再让 build_id 泄漏进磁盘路径。build_id 仍记录在 `.build.json` 中。
- **职责分工**：`save-build <build_id>` 保留按 id 拉取历史快照语义（归档到
  `builds/<build_id>/`，`--flat` 平铺）；日常构建/迭代走 `build` CLI。
- **失败路径**：build CLI 失败时诊断在控制台、不落盘（避免失败也覆盖记录）；
  需要留档用 `save-build` 拉取 `<build_id>.build.json`（含 diagnostics）。
- **测试**：test-build 断言改为平铺路径，新增「同一源文件二次构建覆盖同名文件、
  不新建 build_id 目录」回归；全量 0 失败。
- **文档**：SKILL.md「产物保存」「MCP 回退」「最终报告」、project-workflow.md 项目
  布局同步为 flat + git 管版本；save-build.mjs 头部注释标注历史归档职责。

## [0.2.24] - 2026-08-15

### Added - `nodecoda-skill build <file>` CLI 直连构建（打通无 MCP / 无 key 的 guest 路径）

- **场景**：会话内 `add` 后 MCP 工具不可用、或无 API key 的用户此前只能手搓 JSON-RPC——
  现在 `npx -y @nodecoda/skill build <file.ncoda>` 一行命令完成提交 → 轮询 → 落盘。
- **选路**：复用 `mcp-core.upstreamMode` 产品契约——无 `NODECODA_KEY` 自动走
  try.nodecoda.com/mcp guest JSON-RPC（会话式 + SSE + throttle 重试 + poll 状态归一化），
  有 `NODECODA_KEY` 走 www.nodecoda.com/v1 REST。`mcp-core` 新增 `callTool()` 导出，
  与 MCP server 共用同一套 TOOL_HANDLERS，行为处处一致。
- **输出**：SUCCEEDED 后落盘 `builds/<build_id>/<source-base>.dify.yaml` +
  `<source-base>.build.json` + source 副本（布局与 `save-build` 一致）；
  `--no-save` 只打印结果，`--json` 输出机器可读结果，`--dry-run` 只验选路不提交。
- **幂等 key**：默认按 `<source-base>-<sha256(source)[:16]>` 派生，同源码幂等、改源码即换。
- **测试**：新增 `scripts/test-build.mjs`（15 项：参数解析 / 幂等 key / 选路契约 /
  注入式端到端流程，覆盖 SUCCEEDED / FAILED / exhausted / throttled / timeout /
  dry-run / 无 artifact / 缺失源文件），接入 `npm test` 与 `test:all`。
- **文档**：SKILL.md「MCP 不可用时的回退」改为三步（build CLI → REST curl → 报告重启），
  自举第 4 条指向 build CLI；README 中英「接入 MCP」新增 CLI 直连构建条目。

### Added - guest 配方脚本化 + 传输文档归属标注 + add 后引导（摩擦修复 2/3/4）

- **wire trace（配方脚本化）**：`mcp-core.JsonRpcUpstream` 支持 `trace` 回调，新增
  `createToolCaller({ trace })` 导出；`NODECODA_MCP_TRACE=1` 让任何 mcp-core 消费者
  （MCP server / CLI）零改动打印完整 JSON-RPC 交换（headers + SSE `data:` 帧 +
  解析结果），真实 key 自动脱敏为 `<redacted>`。`build --trace` 把实时线上交换打到 stderr，
  与 `--json` 可同时用（stdout 保持机器可读）。
- **文档（完整可复现配方）**：`references/mcp-contract.md` 新增
  「Guest wire protocol — complete runnable example」——仅依赖 Node 18+ `fetch` 的
  独立脚本：initialize 取会话头 → notifications/initialized → tools/call → SSE 帧解析 →
  双重解码 → 轮询到终态 → artifact 内联读取，并逐条对应 `JsonRpcUpstream` 实现。
- **文档（部署归属）**：`references/public-service.md`「传输约定」标题标注
  （Streamable HTTP，www 生产端），并在认证条目后加交叉引用，明确 www 无状态 key 路径
  与 try 会话式 guest 路径是两套传输，不再混读。
- **add 后引导**：`mcp-register` 的 `exists` 分支提示追加
  "restart your agent to load it; no key? 'npx -y @nodecoda/skill build <file.ncoda>'
  works right now without MCP"。
- **健壮性**：JSON-RPC 工具分支统一 `unwrap`（与 REST 分支一致），内层 payload 无论
  裸 data 还是 `{code,data}` 信封都落到同一文档契约。
- **测试**：test-contract 新增 JsonRpcUpstream 线级 trace 测试（stub fetch 无网络：
  initialize→会话头→SSE 双重解码、trace 完整性、`createToolCaller` 绑定）；
  test-mcp-register 新增 exists 提示断言；test-build 新增 `--trace` 解析/usage 断言。

## [0.2.23] - 2026-08-15

### Fixed - key 优先于 guest 配置（产品契约：无 key=try 免费，有 key=www 正式）

- **场景**：用户先无 key 安装（config 写入 `NODECODA_MCP_JSONRPC_URL=try /mcp`），
  之后在 agent 环境设置 `NODECODA_KEY` 期望切到 www —— 旧优先级 JSONRPC_URL 高于 key，
  会继续走 try，违背"设置 key = 意愿证明 → 连 www"的契约。
- **修复**：`upstreamMode` 优先级调整为
  `NODECODA_MCP_TRANSPORT` 引脚 > `NODECODA_KEY`（→REST www）> `NODECODA_MCP_JSONRPC_URL`（→JSONRPC）> 默认 guest JSONRPC try。
  有 key 一律走 REST www，无论 config 是否残留 guest 接线；无 key 依旧零配置走 try 免费体验。
- **测试**：新增 6 项 transport-mode 优先级回归（含 key+stale-jsonrpc-url → rest、引脚覆盖）；
  JSON-RPC 测试 spawn 隔离宿主 `NODECODA_KEY`。HTTP server 测试 32/32 绿。
- 文档同步：SKILL.md 传输选择段、mcp-register 注释（"配置 NODECODA_KEY 后自动走 www，无需改配置"）。

## [0.2.22] - 2026-08-15

### Fixed - Guest 传输切换为 JSON-RPC `/mcp`（"默认 MCP 即用 try" 关键修复）

- **根因**：K-E1 曾把无 key 安装指向 `NODECODA_MCP_BASE=https://try.nodecoda.com/v1`（REST），
  但 try 的 guest 准入**只在 `/mcp`**（Streamable-HTTP JSON-RPC，会话式）——`/v1` REST 面与 www
  一样对占位 key 严格 `401 INVALID_API_KEY`（实测 2026-08-15）。旧接线会导致无 key 用户每次
  build 都 401。
- **修复**：`mcp-core.mjs` 新增双传输。无 `NODECODA_KEY`（且未显式指定）→ 自动走
  **JSON-RPC guest 通路**：`POST https://try.nodecoda.com/mcp`（默认，`NODECODA_MCP_JSONRPC_URL`
  可覆盖），initialize 取 `Mcp-Session-Id` 会话头、解析 SSE `data:` 帧、解双重编码
  `result.content[0].text`；有 `NODECODA_KEY` → 保持 REST `/v1`（www/自托管）不变。
  新增 `NODECODA_MCP_TRANSPORT=rest|jsonrpc` 显式引脚（自托管/测试）。
- **状态归一化**：try `/mcp` 返回小写状态（`succeeded`/`queued`），客户端把 poll 响应归一化为
  文档契约大写（`QUEUED`/`BUILDING`/`SUCCEEDED`/`FAILED`/`CANCELLED`）；admission 状态
  （`queued`/`throttled`/`exhausted`）保持小写；try 的 artifact **内联**在 poll 响应
  `artifact.content`（无需 /artifact REST）。
- **throttle/exhausted 适配**：`submitWithThrottleRetry` 与 K-E6 软停透传对两种传输同样生效
  （JSON-RPC 通路实测 throttled 自动退避、exhausted 透传不重试）。
- **HTTP server 鉴权**：guest（jsonrpc）模式允许匿名请求（与 stdio server 一致，零配置即用）；
  REST 模式保持严格 401。
- **注册接线**：`mcp-register.mjs` guest 安装写入 `NODECODA_MCP_JSONRPC_URL=https://try.nodecoda.com/mcp`。
- **测试**：`test-http-server.mjs` 新增 JSON-RPC /mcp 本地 stub（会话 + SSE + 双重编码）——
  guest 准入（queued + quota + device 头）、匿名零配置准入、throttled 自动重试、exhausted 透传、
  poll 状态归一化 + artifact 内联；REST 测试显式引脚 `NODECODA_MCP_TRANSPORT=rest`。HTTP server
  测试 26/26 绿。
- **实测**：零配置默认 stdio MCP → try `/mcp`：admission `queued`（quota 块 success_used=0）→
  poll `SUCCEEDED` → artifact 内联 YAML（1292B）。

## [0.2.21] - 2026-08-15

### Added - Guest free-campaign MCP wiring（PRD 模块 E · K-E1~E5）

- **K-E3 设备身份持久化**：新增 `scripts/device-id.mjs` —— 首次运行生成 UUID v4，
  持久化到 `~/.nodecoda/device.json`（0600），跨会话复用；`NODECODA_DEVICE_ID` /
  `NODECODA_DEVICE_DIR` env 覆盖（CI/容器），只读文件系统回退内存 id。
- **K-E2 零分支身份头**：`mcp-core.mjs` 每次请求附加 `X-NodeCoda-Device-Id`（sha256 服务端存储）
  与 `X-NodeCoda-Client`（`nodecoda-skill/<pkg-version>`，运行时读 package.json）；
  无 `NODECODA_KEY` 时用内置占位 key（`sk-try-placeholder`）—— try 实例按 guest 服务，
  www 严格 401，客户端不再自行抛 `NO_KEY`。
- **K-E1 开箱即用**：`mcp-register.mjs` 在未检测到 `NODECODA_KEY` 时为 Codex 写入
  `env.NODECODA_MCP_BASE=https://try.nodecoda.com/v1`（不落任何密钥），装完即走免费体验；
  已有 key 的正式路径不设 env（默认 www）。
- **K-E4 错误码 → 用户文案**：SKILL.md 新增映射表（`GUEST_QUOTA_EXHAUSTED`→注册引导、
  `GUEST_EPOCH_ENDED`/`GUEST_DISABLED`→关停引流、`GUEST_DEVICE_REQUIRED`→自动重试等）。
- **K-E5 战役叙事**：SKILL.md 免费体验章节——阶段 1 用户面无配额提示/倒计时/剩余次数，
  不制造稀缺性；注册话术仅在配额用尽时出现，叙事为「注册 = 专属服务器权益」。
- 新增 `scripts/test-device-id.mjs`（7 断言）并接入 `npm test` / `test:all`。


### Added - Guest 渐进限流客户端适配（nodecoda-guest-rate-limit-model.md §6 · K-E6）

- **`throttled` 自动退避重试**：`scripts/mcp-core.mjs` 新增 `submitWithThrottleRetry`——
  try 网关返回结构化 `{status:"throttled", reason, retry_after_ms, quota}` 时，
  MCP server 按 `retry_after_ms` sleep 后**重放同一提交**（同幂等 key，节流未建 build，
  幂等 key 依然有效），有界 ≤3 次；仍失败时结果带客户端注解 `_client_retries`
  （网关永不发送该字段），SKILL.md 指示 agent 温和提示"服务器繁忙"而非硬报错/改 Source。
- **`exhausted` 软停透传**：设备日限用尽返回 `{status:"exhausted", code:GUEST_QUOTA_EXHAUSTED,
  message, quota, register_hint}`——**非 error**，不重试，原样透传给 agent 渲染服务端
  温和文案 + 「已使用 N 次」（`quota.success_used`）；`register_hint:true` 才附加注册引导，
  无倒计时、无稀缺话术（阶段 1 无压力面）。
- **轮询 pacing**：放行响应的 `poll_after_ms` 原样透传（日限 ≥80% 时服务端 pacing 到 2000 ms）；
  `scripts/live-mcp.mjs` 的 `pollBuild` 尊重 admission 的 `poll_after_ms`，`submitBuild` 同步支持
  throttled 退避重试与 exhausted 温和退出。
- **文档契约**：SKILL.md 新增 K-E6 状态分派表（queued/throttled/exhausted），K-E4 错误码表同步
  双形态（结构化软停 + 429 硬拒）；`references/mcp-contract.md` 新增 "Guest admission statuses"，
  `references/public-service.md` 新增 guest 节流/软停小节与观测表行（2026-08-15）。
- **测试**：`scripts/test-http-server.mjs` 新增 4 项——throttle 后成功（3 次提交同 key）、
  持续 throttled 有界重试（4 次提交 + `_client_retries`）、exhausted 透传不重试、
  queued quota/poll_after_ms 透传。HTTP server 测试 21/21 绿。

### Fixed - Project Mode set-state 旗标强制 + 重建链指引；grammar 悬空非终结符守卫；live-mcp CLI 接线（v0.2.20）

- `project set-state` 旗标强制（实证回写，防止文档高估状态机）：
  `BUILDING` 必须带 `--build-id`、`SUCCEEDED` 必须带 `--sha256`；非法转移错误现在
  打印合法去向，`SUCCEEDED` 终态额外给出完整重建链
  `SOURCE_READY(rev+1) → BUILDING(--build-id) → SUCCEEDED(--sha256)` 与文档链接。
- 新增 `scripts/grammar-coverage.mjs` 守卫：检测 `grammar.ebnf` 引用但未定义且不在
  已知省略 allowlist 的非终结符（`else_clause_opt` 类漂移），接入
  `validate-language-pack.mjs` 与 `test-language-pack.mjs`；修复包内
  `else_clause_opt` 漂移并重新生成 language pack（version.json hash 更新）。
- CLI 新增 `live-mcp` 命令接线（`nodecoda-skill live-mcp`，仓库 clone 内亦可
  `node scripts/live-mcp.mjs`）；`test-contract.mjs` 分发完整性检查补
  `runScript(...)` 引用解析 + dry-run 路由冒烟。
- 文档：MCP stdio 子进程 `NODECODA_KEY` 环境传播指引（`config.example.toml`、
  `installation.md`）、`failure-modes.md` 401 排查表、`mcp-contract.md`
  Idempotency-Key 双份一致传输要求、`project-workflow.md` Rebuild protocol、
  `public-service.md` 网关行为汇总表；SKILL.md 统一改用 npx 命令示例。

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


### Added - 第二批示例 09–12（v0.2.17）

- `09-knowledge-rag.ncoda` — 知识库 RAG：`knowledge()` 多数据集检索、
  `extract_text()` + `file<>` 类型（实证 G2/G3）、`std.v1.rag_answer()` 标准库问答。
- `10-advanced-chat.ncoda` — 多轮对话 + 会话变量：`@mode advanced-chat`、
  `@conversation`（G1 顺序）、`answer()`、会话变量赋值/复合赋值/追加（G4/G5 边界）。
- `11-loop-transform.ncoda` — 循环 + 集合操作：`for` 表达式（yield 收集）、
  `split`/`filter`/`take`、lambda、字符串方法。
- `12-parallel-for.ncoda` — 并发处理：`parallel for` + `concurrency`/`on_error`。
- `manifest.examples` 扩到 12 项；`examples/README.md` 表格与 backlog 同步；
  `language-reference.md` §13 再补 5 行示例文件列（同步重算 source_hash）。
- ⚠️ 待真实 Build 冒烟：09/11/12 涉及 `file<>` 入参、`-> string[]` 数组返回、
  `parallel for` 语义（语法门已通过，完整合法性以 Build pipeline 为准，见
  `.github/workflows/e2e.yml`）。

### Added - 第三批示例 13–14 + e2e 全量冒烟（v0.2.18）

- `13-fetch-summarize.ncoda` — 标准库复合节点：`std.v1.fetch_and_summarize()`
  （HTTP 获取 + LLM 摘要；url/model 必须为字面量，§7）。
- `14-ffi-single-output.ncoda` — Python FFI 单输出契约（直接使用返回值，区别于
  04 的多输出结构体，§6）。
- `manifest.examples` 扩到 14 项；`examples/README.md` 表格与 backlog 同步；
  `language-reference.md` §13 补"HTTP 摘要"示例列（重算 source_hash）。
- **能力门决策**：`enum` / `request_input` 文法合法但当前 target 能力矩阵无条目，
  按能力门治理"改设计不改 Source"，**不写示例**，README backlog 已改为阻断说明。
- `.github/workflows/e2e.yml`：手动冒烟从仅构建 `01-hello-workflow` 扩展为
  **构建全部 14 个示例**——09/11/12 的 `file<>` 入参、`-> string[]` 返回、
  `parallel for` 等语法合法但 target 敏感的构造由此获得真实 Build 验证
  （需 `E2E_NODECODA_KEY`，仍为 workflow_dispatch 手动触发，不进 push 门禁）。

### Fixed - 实证回写：`llm` 不支持 `timeout` 操作策略（v0.2.19）

e2e 全量冒烟首个失败点：`06-error-handling.ncoda` 中
`llm(...) with retry(...), timeout(30s)` 被真实 Build 拒绝——
`OPERATION_POLICY: Operation 'llm' does not support timeout`。

- `examples/06-error-handling.ncoda` — 去掉 llm 上的 `timeout(30s)`，只保留
  实证支持的 `with retry(max: 3, interval: 1s)`；注释同步。
- `language-pack/builtins.json` — `operation_policies` 按主仓白名单修正：
  `retry` → llm/http/tool；`timeout` → 仅 http（llm 实证拒绝）；`default` → llm/http
  （attempt 组合冲突、值须匹配契约 E1045）。
- `references/gotchas.md` — 新增 **G9**：完整策略支持矩阵（白名单来源
  `lang/src/nclang/lang/operation_registry.py` + e2e 实证，主仓单测 9/9 佐证）。
- `references/diagnostics-map.md` — 实证表新增 `OPERATION_POLICY` 行。
- `language-pack/diagnostics.json` — capability 分类补 `OPERATION_POLICY` 码 +
  empirical 条目。
- `references/language-reference.md` §11 — 补策略白名单注记。
- `language-pack/version.json` — hash 重算。

### Fixed - 示例 07/10/12 降级限制实证回写（v0.2.19，主仓编译器本地预编译验证）

e2e 第二轮在 `07-structured-extract.ncoda` 报 `LOWERING_INVARIANT`。用主仓
编译器（`/home/dev/dcc/lang`，`compile_nodecoda_result`）本地复现并二分定位，
顺带预编译全部 14 个示例，发现并修复 3 个示例共 5 处降级限制：

- `07` — 三元结果变量在 if 分支模板串插值 → `Validated expression has no physical
  producer selector`；`extracted.value.days > 5`（2 级字段比较）→ `Condition expression
  BinaryExpr is not directly lowerable`。改为：字段先绑定局部变量再比较、裸 bool
  字段作条件、不插值三元结果变量。
- `10` — 会话变量模板串插值（`answer` 的模板串里引用 `${greeting}`）→ `Validated
  calculation identifier 'greeting' has no value`。改为直接作 `answer` 参数 + 条件判断
  （`visit_count += 1`、`history << user_input` 本身可用）。
- `12` — `on_error: continue` → `SYNTAX_ERROR: Expected parallel-for error mode,
  got KW_CONTINUE`；parser 白名单 `{terminate, keep_null, remove_failed}`，改用
  `remove_failed`。
- **治理增强**：新流程「e2e 失败 → 主仓编译器本地复现二分 → 修示例 → 本地预编译
  全部示例通过后再发下一轮 e2e」，减少往返。
- 回写：`gotchas.md` G10/G11/G12、`diagnostics-map.md` 4 行、`diagnostics.json`
  empirical 4 条 + codegen 分类补 `LOWERING_INVARIANT`、`language-reference.md`
  §5.1/§5.3/§10 注记、`grammar-reference.md` on_error 枚举注记。
- **当前状态**：14/14 示例经主仓编译器预编译通过（`compile_all` 全 OK）。

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
