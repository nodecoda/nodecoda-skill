#!/usr/bin/env bash
# scripts/test-agent-detect.sh
# Standalone automation of the agent-aware no-target `add` detection matrix
# (session env markers -> project agent dirs -> home config -> Codex fallback)
# plus the seamless MCP auto-registration side effects.
# Same assertions as smokeCliInstall in test-contract.mjs, runnable on its own:
#   npm run test:agent-detect
# Uses a fake HOME (and a fake `claude` in PATH) so results are deterministic
# on any machine (real ~/.claude or ~/.codex must not leak in, and the real
# claude CLI must not be invoked). Exit codes: 0=ok, 1=failure.

set -u
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CLI=(node "$REPO_ROOT/scripts/cli.mjs" add nodecoda-workflow)
TMP=$(mktemp -d)
FAKE_HOME="$TMP/home"
FAKE_BIN="$TMP/bin"
FAKE_CLAUDE_LOG="$TMP/claude.log"
mkdir -p "$FAKE_HOME" "$FAKE_BIN"
trap 'rm -rf "$TMP"' EXIT

# Fake `claude` CLI: records invocations; `mcp list` shows nothing (so add is
# attempted), everything else exits 0. Registration must never touch a real
# Claude Code config during tests.
cat > "$FAKE_BIN/claude" <<'SH'
#!/bin/sh
echo "$@" >> "$FAKE_CLAUDE_LOG"
case "$1 $2" in
  "mcp list") : ;;
  *) echo ok ;;
esac
exit 0
SH
chmod +x "$FAKE_BIN/claude"

green() { printf "\033[32m✓\033[0m %s\n" "$*"; }
red()   { printf "\033[31m✗\033[0m %s\n" "$*"; }
PASS=0; FAIL=0
ok()  { green "$1"; PASS=$((PASS+1)); }
bad() { red "$1";   FAIL=$((FAIL+1)); }

# Neutral base: no agent session markers, fake home (no agent config there),
# fake claude on PATH.
NEUTRAL=(env -u CODEX_HOME -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR \
  HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG")

# 1. no signals -> Codex fallback, HOME-level (user-wide, not project-local)
D1="$TMP/fallback"; mkdir -p "$D1"
(cd "$D1" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$FAKE_HOME/.codex/skills/nodecoda-workflow/SKILL.md" ] && [ ! -e "$D1/.codex" ]; then
  ok "no signals -> HOME-level .codex/skills (Codex fallback)"
else bad "no signals -> HOME-level .codex/skills (Codex fallback)"; fi
if grep -q '\[mcp_servers.nodecoda\]' "$FAKE_HOME/.codex/config.toml" 2>/dev/null; then
  ok "fallback: MCP auto-registered in ~/.codex/config.toml"
else bad "fallback: MCP auto-registered in ~/.codex/config.toml"; fi

# 2. Codex session (CODEX_HOME) -> codex, HOME-level
D2="$TMP/codex-env"; mkdir -p "$D2"
rm -f "$FAKE_HOME/.codex/config.toml"
(cd "$D2" && env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR \
  CODEX_HOME=/tmp/codex HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$FAKE_HOME/.codex/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "CODEX_HOME session -> HOME-level .codex/skills"
else bad "CODEX_HOME session -> HOME-level .codex/skills"; fi

# 3. Claude Code session (CLAUDE_CODE_ENTRYPOINT) -> claude-code, HOME-level,
#    and MCP registered via `claude mcp add --scope user`
D3="$TMP/claude-env"; mkdir -p "$D3"
rm -f "$FAKE_CLAUDE_LOG"
(cd "$D3" && env -u CODEX_HOME -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR \
  CLAUDE_CODE_ENTRYPOINT=/tmp/cc HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$FAKE_HOME/.claude/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "CLAUDE_CODE_ENTRYPOINT session -> HOME-level .claude/skills"
else bad "CLAUDE_CODE_ENTRYPOINT session -> HOME-level .claude/skills"; fi
if grep -q 'mcp add nodecoda --scope user -- npx -y @nodecoda/skill mcp' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  ok "claude session: MCP auto-registered via 'claude mcp add --scope user'"
else bad "claude session: MCP auto-registered via 'claude mcp add --scope user'"; fi

# 4. project already set up for Claude Code -> project-level, project-scope MCP
D4="$TMP/proj-claude"; mkdir -p "$D4/.claude"
rm -f "$FAKE_CLAUDE_LOG"
(cd "$D4" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D4/.claude/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "existing project .claude dir -> project-level .claude/skills"
else bad "existing project .claude dir -> project-level .claude/skills"; fi
if grep -q 'mcp add nodecoda --scope project' "$FAKE_CLAUDE_LOG" 2>/dev/null; then
  ok "project claude dir: MCP auto-registered with --scope project"
else bad "project claude dir: MCP auto-registered with --scope project"; fi

# 5. project has .cursor -> generates the .mdc rule + .cursor/mcp.json
D5="$TMP/proj-cursor"; mkdir -p "$D5/.cursor"
(cd "$D5" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D5/.cursor/rules/nodecoda-workflow.mdc" ]; then
  ok "existing project .cursor dir -> .cursor/rules/nodecoda-workflow.mdc"
else bad "existing project .cursor dir -> .cursor/rules/nodecoda-workflow.mdc"; fi
if grep -q '"nodecoda"' "$D5/.cursor/mcp.json" 2>/dev/null; then
  ok "cursor project: MCP auto-registered in .cursor/mcp.json"
else bad "cursor project: MCP auto-registered in .cursor/mcp.json"; fi

# 6. mcp-register subcommand: repair path registers without reinstalling
D6="$TMP/repair"; mkdir -p "$D6"
rm -f "$FAKE_CLAUDE_LOG"
(cd "$D6" && env -u CODEX_HOME -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR \
  CLAUDE_CODE_ENTRYPOINT=/tmp/cc HOME="$FAKE_HOME" PATH="$FAKE_BIN:$PATH" FAKE_CLAUDE_LOG="$FAKE_CLAUDE_LOG" \
  node "$REPO_ROOT/scripts/cli.mjs" mcp-register >/dev/null 2>&1)
if grep -q 'mcp add nodecoda --scope user' "$FAKE_CLAUDE_LOG" 2>/dev/null && [ ! -d "$D6/.claude" ]; then
  ok "mcp-register: registers MCP without reinstalling the skill"
else bad "mcp-register: registers MCP without reinstalling the skill"; fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf "OK   %d passed, 0 failed\n" "$PASS"
  exit 0
else
  printf "FAIL %d passed, %d failed\n" "$PASS" "$FAIL"
  exit 1
fi
