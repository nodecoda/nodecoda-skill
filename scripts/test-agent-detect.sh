#!/usr/bin/env bash
# scripts/test-agent-detect.sh
# Standalone automation of the agent-aware no-target `add` detection matrix
# (session env markers -> project agent dirs -> home config -> Codex fallback).
# Same assertions as smokeCliInstall in test-contract.mjs, runnable on its own:
#   npm run test:agent-detect
# Uses a fake HOME so results are deterministic on any machine (real ~/.claude
# or ~/.codex must not leak in). Exit codes: 0=ok, 1=failure.

set -u
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
CLI=(node "$REPO_ROOT/scripts/cli.mjs" add nodecoda-workflow)
TMP=$(mktemp -d)
FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME"
trap 'rm -rf "$TMP"' EXIT

green() { printf "\033[32m✓\033[0m %s\n" "$*"; }
red()   { printf "\033[31m✗\033[0m %s\n" "$*"; }
PASS=0; FAIL=0
ok()  { green "$1"; PASS=$((PASS+1)); }
bad() { red "$1";   FAIL=$((FAIL+1)); }

# Neutral base: no agent session markers, fake home (no agent config there).
NEUTRAL=(env -u CODEX_HOME -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR HOME="$FAKE_HOME")

# 1. no signals -> Codex fallback, project-local
D1="$TMP/fallback"; mkdir -p "$D1"
(cd "$D1" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D1/.codex/skills/nodecoda-workflow/SKILL.md" ] && [ ! -e "$D1/.claude" ]; then
  ok "no signals -> project-local .codex/skills (Codex fallback)"
else bad "no signals -> project-local .codex/skills (Codex fallback)"; fi

# 2. Codex session (CODEX_HOME) -> codex
D2="$TMP/codex-env"; mkdir -p "$D2"
(cd "$D2" && env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR CODEX_HOME=/tmp/codex HOME="$FAKE_HOME" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D2/.codex/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "CODEX_HOME session -> project-local .codex/skills"
else bad "CODEX_HOME session -> project-local .codex/skills"; fi

# 3. Claude Code session (CLAUDE_CODE_ENTRYPOINT) -> claude-code
D3="$TMP/claude-env"; mkdir -p "$D3"
(cd "$D3" && env -u CODEX_HOME -u CLAUDE_CODE_HOME -u GEMINI_CACHE_DIR CLAUDE_CODE_ENTRYPOINT=/tmp/cc HOME="$FAKE_HOME" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D3/.claude/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "CLAUDE_CODE_ENTRYPOINT session -> project-local .claude/skills"
else bad "CLAUDE_CODE_ENTRYPOINT session -> project-local .claude/skills"; fi

# 4. project already set up for Claude Code -> claude-code
D4="$TMP/proj-claude"; mkdir -p "$D4/.claude"
(cd "$D4" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D4/.claude/skills/nodecoda-workflow/SKILL.md" ]; then
  ok "existing project .claude dir -> project-local .claude/skills"
else bad "existing project .claude dir -> project-local .claude/skills"; fi

# 5. project has .cursor -> generates the .mdc rule
D5="$TMP/proj-cursor"; mkdir -p "$D5/.cursor"
(cd "$D5" && "${NEUTRAL[@]}" "${CLI[@]}" >/dev/null 2>&1)
if [ -f "$D5/.cursor/rules/nodecoda-workflow.mdc" ]; then
  ok "existing project .cursor dir -> .cursor/rules/nodecoda-workflow.mdc"
else bad "existing project .cursor dir -> .cursor/rules/nodecoda-workflow.mdc"; fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf "OK   %d passed, 0 failed\n" "$PASS"
  exit 0
else
  printf "FAIL %d passed, %d failed\n" "$PASS" "$FAIL"
  exit 1
fi
