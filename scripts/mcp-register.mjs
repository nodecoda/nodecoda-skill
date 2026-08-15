#!/usr/bin/env node
// scripts/mcp-register.mjs
// @nodecoda/skill — idempotent MCP auto-registration.
//
// Makes `nodecoda-skill add <name>` truly seamless: after copying the skill
// files, register the `nodecoda` MCP server for the target agent so the agent
// gains the build_dify_workflow / get_workflow_build / cancel_workflow_build
// tools with zero manual wiring. Registration is best-effort and idempotent:
// a failure never fails the install — it prints a warning with the manual
// command instead.
//
// Supported agents (schema-verified against upstream docs 2026-08):
//   claude-code  -> `claude mcp add nodecoda --scope <user|project> -- ...`
//                   (writes ~/.claude.json or .mcp.json; official CLI)
//   codex        -> append [mcp_servers.nodecoda] to ~/.codex/config.toml
//                   (or <project>/.codex/config.toml)
//   gemini-cli   -> merge mcpServers.nodecoda into ~/.gemini/settings.json
//                   (or <project>/.gemini/settings.json)
//   cursor       -> merge mcpServers.nodecoda into <project>/.cursor/mcp.json
//
// The server itself runs zero-install via `npx -y @nodecoda/skill mcp`, so no
// local node_modules are required on the agent machine.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The zero-install MCP server definition shared by every target.
export const MCP_SERVER = {
  name: 'nodecoda',
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: ['-y', '@nodecoda/skill', 'mcp'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function pathExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

function tomlEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Does the TOML text already define [mcp_servers.nodecoda]?
export function codexTomlHasServer(tomlText, name = MCP_SERVER.name) {
  // Match a table header of the form [mcp_servers.nodecoda] or
  // [mcp_servers."nodecoda"] at line start (allows leading whitespace).
  const re = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${name}"?\\s*\\]`, 'm');
  return re.test(tomlText);
}

export function codexTomlBlock(server = MCP_SERVER, { mcpBase } = {}) {
  const lines = [
    '',
    `# NodeCoda MCP — auto-registered by 'nodecoda-skill add' (v0.2.10+).`,
    `# Zero-install stdio server: fetched on demand via npx.`,
    `# The API key is read from the NODECODA_KEY environment variable at`,
    `# request time and never stored in this file.`,
    `[mcp_servers.${server.name}]`,
    `command = "${tomlEscape(server.command)}"`,
    `args = [${server.args.map((a) => `"${tomlEscape(a)}"`).join(', ')}]`,
    `enabled = true`,
    `startup_timeout_sec = 5`,
  ];
  if (mcpBase) {
    lines.push(`env = { NODECODA_MCP_BASE = "${tomlEscape(mcpBase)}" }`);
    lines.push(`# ^ 未配置 NODECODA_KEY 时，自动走 try.nodecoda.com 免费体验（无需注册）；`);
    lines.push(`#   配置 NODECODA_KEY 后，移除该行或用 NODECODA_MCP_BASE 指回 www 正式实例。`);
  }
  lines.push('');
  return lines.join('\n');
}

// Idempotently register the NodeCoda MCP server in a Codex config.toml.
// Returns { status: 'added' | 'exists', configPath }.
export async function addCodexMcp(configPath, server = MCP_SERVER, { mcpBase } = {}) {
  const prev = existsSync(configPath) ? await readFile(configPath, 'utf8') : '';
  if (codexTomlHasServer(prev, server.name)) {
    return { status: 'exists', configPath };
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${prev}${codexTomlBlock(server, { mcpBase })}`, 'utf8');
  return { status: 'added', configPath };
}

// ---------------------------------------------------------------------------
// Claude Code (official CLI: `claude mcp add`)
// ---------------------------------------------------------------------------

// List configured MCP server names via `claude mcp list`.
// Returns { ok, names: string[] } — ok=false means the CLI is missing/failed.
export function claudeMcpNames({ claudeBin = 'claude', cwd, env = process.env, timeoutMs = 60000 } = {}) {
  const r = spawnSync(claudeBin, ['mcp', 'list'], {
    cwd, env, encoding: 'utf8', timeout: timeoutMs,
  });
  if (r.error || r.status !== 0) {
    return { ok: false, names: [] };
  }
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  // Server lines look like:  <name> - <transport> - ✓ Connected  (names may
  // carry a (scope) suffix). Match the leading token on every line.
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_.:-]+)\s*[-–(]/);
    if (m) names.add(m[1].replace(/^plugin:.*/, ''));
  }
  return { ok: true, names: [...names].filter(Boolean) };
}

// Register via `claude mcp add nodecoda --scope <user|project|local> -- npx ...`.
// Returns { status: 'added' | 'exists' | 'failed', reason? }.
export function addClaudeMcp({ claudeBin = 'claude', scope = 'user', cwd, env = process.env, timeoutMs = 120000 } = {}) {
  if (!['user', 'project', 'local'].includes(scope)) {
    return { status: 'failed', reason: `invalid scope: ${scope}` };
  }
  const args = ['mcp', 'add', MCP_SERVER.name, '--scope', scope, '--', MCP_SERVER.command, ...MCP_SERVER.args];
  const r = spawnSync(claudeBin, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { status: 'failed', reason: String(r.error?.message ?? r.error) };
  if (r.status !== 0) {
    return { status: 'failed', reason: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  }
  return { status: 'added' };
}

// Register Claude Code MCP, skipping the add when already configured.
// Returns { status: 'added' | 'exists' | 'skipped-cli-missing' | 'failed', reason? }.
export async function registerClaudeMcp({ scope = 'user', cwd, env = process.env, claudeBin = 'claude' } = {}) {
  const { ok, names } = claudeMcpNames({ claudeBin, cwd, env });
  if (!ok) {
    return {
      status: 'skipped-cli-missing',
      reason: `\`${claudeBin}\` not found or 'claude mcp list' failed`,
    };
  }
  if (names.includes(MCP_SERVER.name)) return { status: 'exists' };
  return addClaudeMcp({ claudeBin, scope, cwd, env });
}

// ---------------------------------------------------------------------------
// Gemini CLI (settings.json -> mcpServers)
// ---------------------------------------------------------------------------

export function mergeJsonMcp(existingText, server = MCP_SERVER) {
  let cfg = {};
  if (existingText && existingText.trim()) {
    try {
      cfg = JSON.parse(existingText);
    } catch {
      cfg = {}; // unreadable config: fall through and rewrite a clean file
    }
  }
  if (typeof cfg !== 'object' || cfg === null) cfg = {};
  cfg.mcpServers = cfg.mcpServers ?? {};
  if (cfg.mcpServers[server.name]) {
    return { changed: false, text: null, config: cfg };
  }
  cfg.mcpServers[server.name] = { command: server.command, args: server.args };
  return { changed: true, text: `${JSON.stringify(cfg, null, 2)}\n`, config: cfg };
}

// Idempotently register in a Gemini settings.json. Returns
// { status: 'added' | 'exists' | 'failed', reason? }.
export async function addGeminiMcp(settingsPath, server = MCP_SERVER) {
  const existing = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : '';
  const { changed, text } = mergeJsonMcp(existing, server);
  if (!changed) return { status: 'exists', settingsPath };
  try {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, text, 'utf8');
    return { status: 'added', settingsPath };
  } catch (e) {
    return { status: 'failed', reason: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Cursor (.cursor/mcp.json)
// ---------------------------------------------------------------------------

export async function addCursorMcp(projectDir, server = MCP_SERVER) {
  const p = join(projectDir, '.cursor', 'mcp.json');
  const existing = existsSync(p) ? await readFile(p, 'utf8') : '';
  const { changed, text } = mergeJsonMcp(existing, server);
  if (!changed) return { status: 'exists', path: p };
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, 'utf8');
    return { status: 'added', path: p };
  } catch (e) {
    return { status: 'failed', reason: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// Orchestration: register for one platform + scope, return printable lines.
// ---------------------------------------------------------------------------

// Human-readable one-liners for the install summary.
const PLATFORM_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  cursor: 'Cursor',
};

export async function registerMcp({
  platform,
  scope, // 'home' | 'project'
  projectDir = process.cwd(),
  homeDir = homedir(),
  claudeBin = 'claude',
  env = process.env,
} = {}) {
  const label = PLATFORM_LABEL[platform] ?? platform;
  const results = [];

  if (platform === 'claude-code') {
    const r = await registerClaudeMcp({ scope: scope === 'home' ? 'user' : 'project', cwd: projectDir, env, claudeBin });
    results.push({ target: `Claude Code (${scope === 'home' ? 'user scope' : 'project scope'})`, r });
  } else if (platform === 'codex') {
    const configPath = scope === 'home'
      ? join(homeDir, '.codex', 'config.toml')
      : join(projectDir, '.codex', 'config.toml');
    // K-E1: with no NODECODA_KEY configured, point the fresh install at the
    // try free-experience instance so it works out of the box (placeholder
    // key is synthesized by mcp-core at request time — nothing secret here).
    const mcpBase = env.NODECODA_KEY ? undefined : 'https://try.nodecoda.com/v1';
    const r = await addCodexMcp(configPath, MCP_SERVER, { mcpBase });
    results.push({ target: `Codex (${configPath})`, r });
  } else if (platform === 'gemini-cli') {
    const settingsPath = scope === 'home'
      ? join(homeDir, '.gemini', 'settings.json')
      : join(projectDir, '.gemini', 'settings.json');
    const r = await addGeminiMcp(settingsPath);
    results.push({ target: `Gemini CLI (${settingsPath})`, r });
  } else if (platform === 'cursor') {
    const r = await addCursorMcp(projectDir);
    results.push({ target: `Cursor (${join(projectDir, '.cursor', 'mcp.json')})`, r });
  } else {
    results.push({ target: label, r: { status: 'skipped', reason: 'unknown platform for MCP registration' } });
  }

  const lines = results.map(({ target, r }) => {
    switch (r.status) {
      case 'added': return `${target}: ✓ MCP server '${MCP_SERVER.name}' registered (npx zero-install)`;
      case 'exists': return `${target}: MCP server '${MCP_SERVER.name}' already registered (skipped)`;
      case 'skipped-cli-missing':
      case 'failed':
        return `${target}: ⚠ could not auto-register MCP (${r.reason}). Manual: claude mcp add ${MCP_SERVER.name} --scope ${scope === 'home' ? 'user' : 'project'} -- ${MCP_SERVER.command} ${MCP_SERVER.args.join(' ')}`;
      case 'skipped':
      default:
        return `${target}: MCP registration skipped (${r.reason ?? 'no supported target'})`;
    }
  });
  const ok = results.every(({ r }) => r.status === 'added' || r.status === 'exists' || r.status === 'skipped');
  return { ok, lines, results };
}
