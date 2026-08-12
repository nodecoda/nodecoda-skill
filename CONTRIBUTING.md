# Contributing to nodecoda-skill

Thanks for your interest in improving nodecoda-skill! This repo distributes the
`nodecoda-workflow` skill that teaches AI coding agents to author NodeCoda
Source (`.ncoda`) and build Dify workflows via the NodeCoda MCP service.

## Repository layout

```
skills/nodecoda-workflow/   # the skill (source of truth): SKILL.md, references/, examples/, manifest.json
scripts/                    # operational scripts (project.mjs, save-build.mjs, ...) + dev tooling + tests
docs/                       # human-facing docs; design/ holds specs & plans
examples/project/           # a full project-mode example
builds/                     # generated artifacts (gitignored)
.codex/config.example.toml  # template for local Codex MCP wiring
```

The canonical skill lives in `skills/nodecoda-workflow/`. Any other copy (e.g.
`.codex/skills/`) is a local install and must never be edited directly — re-copy
from the canonical source.

## Before you start

- Open an issue first for new skills or breaking changes to the skill contract.
- Node >= 18 is required to run the scripts and tests.

## Making changes

1. Edit files under `skills/nodecoda-workflow/` (or `scripts/` for tooling).
2. Bump `skills/nodecoda-workflow/manifest.json` `version` and `package.json` /
   version together; add a `CHANGELOG.md` entry.
3. Validate locally:
   ```bash
   npm test                       # contract + project state-machine tests
   npm run validate               # skill manifest & references
   node scripts/validate-project.mjs examples/project
   ```
4. Keep diffs small and reviewable. Prefer reusing existing patterns over new
   abstractions; do not add dependencies without explicit request.

## Security

See [SECURITY.md](SECURITY.md). Never commit API keys or credentials. The local
`.codex/config.toml` (which holds a real key) is gitignored; commit only
`.codex/config.example.toml`.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) are
preferred. Keep the subject line <= 72 chars.
