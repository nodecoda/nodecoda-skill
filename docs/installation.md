# Installation

The `nodecoda-workflow` skill can be installed on any agent that follows the Claude Code skill convention. Pick the path that matches your agent.

## Supported agents

| Agent | Default skill path | Notes |
|-------|--------------------|-------|
| **Claude Code** | `~/.claude/skills/nodecoda-workflow/` | Or `<project>/.claude/skills/nodecoda-workflow/` for project-scoped |
| **Codex CLI** | `.codex/skills/nodecoda-workflow/` | Project-scoped, lives next to AGENTS.md |
| **Gemini CLI** | `~/.gemini/skills/nodecoda-workflow/` | (assumed; check `gemini --help` for current path) |
| **Cursor** | `.cursor/rules/nodecoda.mdc` | Cursor doesn't load `SKILL.md` directly — see "Cursor" section below |


## Codex MCP wiring (optional)

For Codex CLI, this repo ships `.codex/config.example.toml` - a template that
registers the NodeCoda MCP server. The **primary** wiring is the public
Streamable HTTP endpoint (`https://www.nodecoda.com/mcp`); the key is read from
the `NODECODA_KEY` environment variable, so it never lives in a config file:

```bash
cp .codex/config.example.toml .codex/config.toml
export NODECODA_KEY=sk-...   # add to your shell profile
```

**Zero-install alternative** (no clone, no local npm install) — let Codex
fetch the server on demand each session:

```toml
[mcp_servers.nodecoda]
command = "npx"
args = ["-y", "@nodecoda/skill", "mcp"]
enabled = true
```

The npm package serves MCP over stdio via `nodecoda-skill mcp` (`--http
[--port N]` for the Streamable HTTP transport). Requires the package on the
npm registry (v0.2.0+); the key is read from `NODECODA_KEY` at request time.

The public `/mcp` route is live (verified 2026-08-12) — no SPA catch-all in
the way. For the routing rules and the self-hosted alternative, see
`skills/nodecoda-workflow/references/public-service.md` (公网 MCP 直连). Note:
the OAuth metadata endpoint is not served yet, so use `NODECODA_KEY` rather
than `codex mcp login`; keys must exist in the backend database.

For self-hosting or local dev, pick one of the commented-out alternatives in
the template:
- **local HTTP server**: `command = "node"`, `args = ["scripts/mcp-http-server.mjs", "--port", "4001"]`
- **local dev stack**: `url = "http://127.0.0.1:8000/mcp"` + `http_headers`
- **stdio bridge**: `command = "node"`, `args = ["scripts/mcp-stdio-server.mjs"]`

`.codex/config.toml` is gitignored (it may hold a real key in the local-dev
variants). The skill itself is installed to `.codex/skills/nodecoda-workflow/`
(also local/gitignored):

```bash
cp -R skills/nodecoda-workflow .codex/skills/
```

## Option A — git clone (works today, no CLI)

```bash
# Pick a destination matching your agent
DEST=~/.claude/skills/nodecoda-workflow
git clone --depth 1 https://github.com/nodecoda/nodecoda-skill.git /tmp/nodecoda-skill
cp -R /tmp/nodecoda-skill/skills/nodecoda-workflow "$DEST"
rm -rf /tmp/nodecoda-skill
```

Verify:

```bash
ls "$DEST"      # should show SKILL.md, manifest.json, references/, examples/
```

## Option B — npx (live, v0.2.x)

```bash
npx -y @nodecoda/skill add nodecoda-workflow
```

The CLI (`nodecoda-skill`, published as `@nodecoda/skill`) resolves the
current agent's skill directory and copies `skills/nodecoda-workflow/` there.
Same package also serves the MCP server (`nodecoda-skill mcp`) — one package
for both skill install and zero-install MCP wiring. Targets:

```bash
npx -y @nodecoda/skill add nodecoda-workflow              # auto: detects the agent (see below)
npx -y @nodecoda/skill add nodecoda-workflow codex        # ./.codex/skills
npx -y @nodecoda/skill add nodecoda-workflow claude-code  # ./.claude/skills
npx -y @nodecoda/skill add nodecoda-workflow cursor       # generates .cursor/rules/*.mdc
npx -y @nodecoda/skill add nodecoda-workflow ~/.claude/skills   # explicit dir
npx -y @nodecoda/skill list / info / validate             # inspect & self-check
```

`install` is an alias for `add`. Platform differences handled: Codex /
Claude Code / Gemini CLI get the skill copied into their `SKILL.md`-based
search dirs; **Cursor is the exception** — it cannot load `SKILL.md`, so
`add ... cursor` (or an auto-detected Cursor project) generates a
`.cursor/rules/nodecoda-workflow.mdc` rule with YAML frontmatter and the
skill content inlined.

**No-target `add` auto-detects the platform** in this order:
1. the agent session that invoked the CLI (`CODEX_HOME` /
   `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_HOME` / `GEMINI_CACHE_DIR`)
2. an agent already set up in the current project (`.codex/`, `.claude/`,
   `.gemini/`, `.cursor/` dir present)
3. an agent configured in your home directory
4. fallback: Codex, project-local (`./.codex/skills`)

Restart your agent after installing so it picks up the new skill.

## Option C — Python (pip / uv) — deferred

The Python distribution channel is intentionally **not shipped yet**: the npm
package covers every mainstream agent (they all launch the MCP server or the
skill installer via `npx`, no Python runtime required). Reintroduce
`pyproject.toml` + a PyPI release only when a concrete Python-only consumer
shows up.

## Cursor (special case)

Cursor reads `.cursor/rules/*.mdc` instead of `SKILL.md`. Until we ship a generated `.mdc` (planned v0.2.0), create it manually:

```bash
# One-time setup
mkdir -p .cursor/rules
curl -L https://raw.githubusercontent.com/nodecoda/nodecoda-skill/main/skills/nodecoda-workflow/SKILL.md \
  -o .cursor/rules/nodecoda-workflow.mdc
```

The `.mdc` is just a markdown wrapper; Cursor will treat it as rules.

## Verifying the install

After install, ask the agent:

> "用 NodeCoda 写一个最小工作流,接受字符串输入并原样返回。"

A correctly installed skill should produce a `.ncoda` file that starts with `@language nodecoda/1` and uses `function main(...) -> string { return ... }` — without any additional explanation.

If the agent does not know about `build_dify_workflow`, the install failed; check that `SKILL.md` is at the top level of the installed path (not nested).

## Versioning & upgrades

The skill and NodeCoda core are versioned independently. To check compatibility:

```bash
cat ~/.claude/skills/nodecoda-workflow/manifest.json | grep -E 'min_nodecoda|target_profile'
```

If your NodeCoda version is below `min_nodecoda`, the skill's MCP contract may differ from what your MCP server speaks. Upgrade NodeCoda, or pin the skill to an older release:

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/nodecoda/nodecoda-skill.git
cp -R nodecoda-skill/skills/nodecoda-workflow ~/.claude/skills/
```

## Uninstalling

```bash
rm -rf ~/.claude/skills/nodecoda-workflow    # Claude Code
rm -rf .codex/skills/nodecoda-workflow        # Codex
rm -f  .cursor/rules/nodecoda-workflow.mdc    # Cursor
```

Restart your agent to clear any cached context.
