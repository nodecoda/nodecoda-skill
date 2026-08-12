# Changelog — nodecoda-workflow skill

## [0.2.15] — 2026-08-13

### Added
- **机器可读语言包** `language-pack/`（研究文档 `docs/research/teaching-ai-a-new-c-style-dsl.md`
  Phase 0/1 skill 侧落地）：
  - `grammar.ebnf` — 带 `[feature]` 标签的 EBNF（源自 grammar-reference.md）
  - `builtins.json` — 内置函数签名/效应/输出字段/retry 支持
  - `diagnostics.json` — 诊断分类（L1-L4）+ 实证 code→修复映射
  - `targets/dify-1.16-graphon-0.6.json` — 能力矩阵 + capability gate
  - `antipatterns.json` — G1–G8 反模式结构化（id/codes/symptom/cause/correct）
  - `version.json` — 文件 hash + source_docs 原文 hash（版本漂移检测）
- `scripts/validate-language-pack.mjs` — 语言包校验（JSON schema、hash 一致性、
  源文档漂移检测）；已纳入 `npm run validate` / `npm run test:all`
- `scripts/test-language-pack.mjs` — 语言包回归测试（含漂移检测用例）
- manifest.json 新增 `language_pack` 字段；references 规范新增 §4 语言包章节

### Changed
- `SKILL.md` 新增语言包检索指引：按 feature 取最小规则集，不整卷塞 prompt

## [0.1.0] — 2026-08-11

### Added
- Initial split-out from the main NodeCoda repository
- Full content from the original skill:
  - `SKILL.md` — workflow contract, 6-step process, final report template
  - `references/mcp-contract.md` — 3 MCP tools + invariants
  - `references/source-generation.md` — minimal Source and 5 core operations
  - `references/language-reference.md` — full DSL reference
  - `references/public-service.md` — client config, admission, polling, readiness
- New references added during split-out:
  - `references/diagnostics.md` — Diagnostic shape, code taxonomy, severity, repair priority
  - `references/target-capabilities.md` — Dify 1.16 capability matrix (supported / partial / unsupported)
  - `references/iteration-loop.md` — bounded repair loop (5 iterations max) and stop signals
  - `references/failure-modes.md` — `failure_kind` handling table
- 4 runnable examples in `examples/`
- `manifest.json` with cross-platform metadata
