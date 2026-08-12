# 项目化工作流（Project Workflow）设计

日期：2026-08-12
状态：已批准（brainstorming 确认，7 项决策 + 两节设计）
范围：nodecoda-skill —— 把「创建一个 Dify 工作流」从对话内一次性流程升级为项目化工作流

## 1. 背景与动机

当前 nodecoda-skill 的流程是「需求分析 → 设计确认 → 编写 Source → Build → 诊断修复 → 交付」，
Source 只存在于对话中，后端仅存 `source_sha256` 哈希（无 source 下载端点），artifact 约 24 小时过期。
结果是：DSL 无法反复编译、无法版本化、无法共享——它没有「源码」地位。

目标：让 DSL 成为一等公民（类比编程 agent 的编码过程：需求分析 → 编码 → 编译 → 修改 → 直到编译通过），
通过「项目」这一单位承载：稳定文件位置、可反复编译、git 版本化、可共享、状态机驱动、中断可恢复。

## 2. 已确认决策（brainstorming）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 项目粒度 | 一个项目 = 一个工作流（一个 Dify 应用） |
| 2 | 项目布局 | 清单驱动：`nodecoda.yaml` + `src/` + `design.md` + `builds/` |
| 3 | 需求澄清深度 | 精简版深访：一次一问、意图优先、≤5 轮、design.md 落盘 |
| 4 | 状态机实现 | 混合：SKILL.md 协议层 + `scripts/project.mjs` 实现层 |
| 5 | 项目创建位置 | 探测 + 默认新建（有标记就地复用，否则新建 `./<name>/`，创建时一问确认） |
| 6 | 版本化/共享 | git 原生 + 产物可选（src/清单/design 入 git；builds/ gitignore） |
| 7 | 向后兼容 | 保留轻量模式（快速验证 .ncoda 片段，显式标注为临时验证） |

## 3. 概念模型

**项目 = 工作流 = 一个 Dify 应用。** `src/<name>.ncoda` 是唯一事实源（可反复编译的对象），
`nodecoda.yaml` 是项目清单与状态机状态的落盘位置，其余文件（产物、记录、快照）均为派生。

## 4. 目录结构

```
<project-name>/
├── nodecoda.yaml            # 项目清单 + 状态机状态（唯一事实源之二）
├── design.md                # 需求分析产物（精简深访落盘）
├── src/
│   └── <project-name>.ncoda # 源码：可反复编译、版本化、共享
└── builds/                  # 编译历史（gitignore）
    ├── <build_id>/
    │   ├── <name>.dify.yaml     # 最终产物（成功时）
    │   ├── <name>.build.json    # 编译记录（sha256/诊断）
    │   └── <name>.ncoda         # 本次编译的源码副本（save-build --source，可复现审计）
    └── # 最近成功产物由 state.current_build_id 解析，无需 latest/ 目录
```

## 5. `nodecoda.yaml` 清单 schema

```yaml
project: customer-support
mode: advanced-chat
target_profile: dify-1.16-graphon-0.6
language_identity: nodecoda/1
source: src/customer-support.ncoda
created_at: "2026-08-12T..."
state:
  phase: DESIGNED        # INIT|CLARIFYING|DESIGNED|SOURCE_READY|BUILDING|SUCCEEDED|NEEDS_FIX|FAILED|CANCELLED
  rev: 0                 # 修复版本计数
  current_build_id: null
  source_sha256: null
  last_diagnostics: []
  history: []            # 审计链：[{phase, at, rev, build_id, diagnostics}]
```

## 6. 生命周期状态机

```
INIT ──探测──▶ 就地（有 nodecoda.yaml）｜新建 ./<name>/
INIT → CLARIFYING（一次一问 ≤5 轮）→ DESIGNED（design.md 落盘）
    → SOURCE_READY（src 写好）→ BUILDING（提交 build + 轮询）
    → SUCCEEDED（产物落盘 builds/<id>/，state.current_build_id 更新）
    → NEEDS_FIX（读 diagnostics → 改 src → rev+1 → SOURCE_READY → 再 BUILDING）
        ↺ 修复循环有界 ≤5 次；source_sha256 重复或错误不减少即停
    → FAILED / CANCELLED（终止态，诊断留痕）
```

**恢复**：任何中断后，skill 启动即读 `nodecoda.yaml` 的 `state` 回到对应阶段，不重新问需求。

状态转换必须经过 `project.mjs validate-transition` 校验，拒绝非法转换。

## 7. 交互协议（精简深访）

创建项目时按序澄清，一次一问、意图优先、上限 5 轮。
需求已足够清晰时（输入/输出/模式/边界均可回答）可提前进入 DESIGNED，不问满 5 轮。

1. 用途：这个工作流要解决什么？
2. 输入/输出：输入什么、产出什么（类型/格式）？
3. 模式与依赖：workflow 还是 advanced-chat？需要哪些模型/工具/知识库/HTTP 服务？
4. 边界与异常：明确不做什么；空数据、外部失败、信息不足时走哪个分支？

澄清结束 → 结论写为 `design.md`。平台无关实现：纯文本一问一答，不依赖 OMX 机制
（manifest 声明支持 claude-code/codex/gemini-cli/cursor）。

## 8. Build 数据流（编码循环）

```
CLARIFYING → DESIGNED(design.md) → SOURCE_READY(src 写好, state 校验通过)
  → build_dify_workflow(idempotency_key = <project>-rev-<n>)
  → get_workflow_build 轮询（≤180s，admission ≤3 次）
  → SUCCEEDED:
      node scripts/save-build.mjs <build_id> --source src/<name>.ncoda --out builds
      → builds/<build_id>/ 三件套 + state.phase=SUCCEEDED + current_build_id + history 追加
  → NEEDS_FIX:
      state.phase=NEEDS_FIX + last_diagnostics 落盘
      改 src → rev+1 → 新幂等 key → 回 SOURCE_READY（循环 ≤5 次）
  → FAILED/CANCELLED: 终止态 + 诊断留痕，不虚构原因
```

幂等 key 规则：`<project>-rev-<n>`；任何 Source/filename/language/target 变化必须换 key。

## 9. 错误处理与恢复

| 场景 | 处理 |
|---|---|
| 会话中断 | 读 `nodecoda.yaml` state 恢复，不重问需求 |
| 非法状态转换 | `project.mjs validate-transition` 拒绝并提示正确路径 |
| build 失败 | 终止态 + `builds/<build_id>.build.json` 留痕（本地持久化，不依赖后端 7 天保留） |
| 哈希不一致 | 落盘 `.ncoda` 的 sha256 必须 == record `source_sha256`，不一致即停止排查 |
| 凭据 | `NODECODA_KEY` 只从环境读取，绝不写入项目/产物/报告 |

## 10. 组件清单

| 组件 | 说明 |
|---|---|
| `scripts/project.mjs`（新增） | `init` / `get-state` / `set-state` / `validate-transition` / `resolve`（探测就地 or 新建） |
| `scripts/save-build.mjs` | 已升级（per-build 目录 + `--source`），复用 |
| `SKILL.md` | 新增「项目化工作流」章节：状态表、转换规则、恢复协议、清单 schema；轻量模式保留为显式 opt-in |

## 11. 测试策略

- `validate-skill.mjs` 扩展：校验项目目录结构 + 清单 schema 合法性
- `test-contract.mjs` 扩展：状态机转换表全遍历测试（合法/非法转换）
- `project.mjs` 单测：init/get/set/validate/resolve 各路径
- e2e：`examples/project/` 示例项目完整跑一遍（建项目→design→src→build→SUCCEEDED→产物落盘→状态正确）+ 中断恢复演练

## 12. 实施顺序

1. `scripts/project.mjs`（状态机实现层）
2. `SKILL.md` 项目化章节（协议层）+ 轻量模式说明
3. `examples/project/` 示例项目 + e2e 验证
4. 扩展 validate-skill / test-contract
5. README 更新（项目化使用说明）

## 13. 非目标

- 不做多工作流项目管理（一个项目一个工作流，多工作流 = 多目录）
- 不引入 OMX 专有机制（omx question / omx state），保持跨 agent 可移植
- 不改动后端编译服务（graphon），只改客户端 skill 侧
