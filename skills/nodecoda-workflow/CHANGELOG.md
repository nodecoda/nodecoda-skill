# Changelog — nodecoda-workflow skill

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
