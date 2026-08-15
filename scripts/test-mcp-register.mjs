#!/usr/bin/env node
// scripts/test-mcp-register.mjs
// Pure-Node tests for the seamless MCP auto-registration module
// (scripts/mcp-register.mjs). No external deps. No real agent CLIs: the
// Claude CLI is replaced by a fake binary that records its arguments.
//
// Exit codes: 0=ok, 1=failure.

import { mkdtemp, writeFile, rm, readFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  MCP_SERVER,
  codexTomlHasServer,
  codexTomlBlock,
  addCodexMcp,
  claudeMcpNames,
  addClaudeMcp,
  registerClaudeMcp,
  mergeJsonMcp,
  addGeminiMcp,
  addCursorMcp,
  registerMcp,
} from './mcp-register.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
function bad(name, why) { console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); fail++; }
function assert(cond, name, why) { if (cond) ok(name); else bad(name, why); }

const tmp = await mkdtemp(join(tmpdir(), 'nodecoda-mcp-reg-'));
const T = { home: join(tmp, 'home'), proj: join(tmp, 'proj'), bin: join(tmp, 'bin') };
await mkdir(T.home, { recursive: true });
await mkdir(T.proj, { recursive: true });
await mkdir(T.bin, { recursive: true });

// --- Fake claude CLI -------------------------------------------------------
// Records every invocation to $T/home/claude.log; `mcp list` prints nothing
// (so registration attempts an add), everything else prints "ok" and exits 0.
const fakeClaude = join(T.bin, 'claude');
const claudeLog = join(T.home, 'claude.log');
await writeFile(fakeClaude, `#!/bin/sh\necho "$@" >> "$CLAUDE_LOG"\ncase "$1 $2" in\n  "mcp list") : ;;\n  *) echo ok ;;\nesac\nexit 0\n`);
await chmod(fakeClaude, 0o755);
const env = { ...process.env, PATH: `${T.bin}:${process.env.PATH}`, HOME: T.home, CLAUDE_LOG: claudeLog };
const readLog = async () => (existsSync(claudeLog) ? await readFile(claudeLog, 'utf8') : '');

// --- 1. codexTomlHasServer -------------------------------------------------
assert(!codexTomlHasServer(''), 'codexTomlHasServer: empty text -> false');
assert(codexTomlHasServer('[mcp_servers.nodecoda]\ncommand = "npx"'), 'codexTomlHasServer: plain [mcp_servers.nodecoda] -> true');
assert(codexTomlHasServer('\n  [mcp_servers."nodecoda"]\n'), 'codexTomlHasServer: quoted + indented header -> true');
assert(!codexTomlHasServer('[mcp_servers.other]\n'), 'codexTomlHasServer: other server -> false');
assert(!codexTomlHasServer('mcp_servers.nodecoda = "x"'), 'codexTomlHasServer: non-header line -> false');

// --- 2. codexTomlBlock -----------------------------------------------------
const block = codexTomlBlock();
assert(block.includes('[mcp_servers.nodecoda]'), 'codexTomlBlock: emits [mcp_servers.nodecoda]');
assert(block.includes('command = "npx"'), 'codexTomlBlock: emits command = "npx"');
assert(block.includes('args = ["-y", "@nodecoda/skill", "mcp"]'), 'codexTomlBlock: emits zero-install args');

// --- 3. addCodexMcp --------------------------------------------------------
const cfg1 = join(T.home, '.codex', 'config.toml');
let r = await addCodexMcp(cfg1);
assert(r.status === 'added', 'addCodexMcp: fresh config -> added');
const text1 = await readFile(cfg1, 'utf8');
assert(codexTomlHasServer(text1), 'addCodexMcp: config now has [mcp_servers.nodecoda]');
r = await addCodexMcp(cfg1);
assert(r.status === 'exists', 'addCodexMcp: second call -> exists');
const text1b = await readFile(cfg1, 'utf8');
assert(text1b === text1, 'addCodexMcp: idempotent (no duplicate table)');

// K-E1: try free-experience base is written when no key is configured.
const blockTry = codexTomlBlock(MCP_SERVER, { mcpBase: 'https://try.nodecoda.com/mcp' });
assert(blockTry.includes('NODECODA_MCP_JSONRPC_URL = "https://try.nodecoda.com/mcp"'), 'codexTomlBlock: try /mcp JSONRPC URL env written for keyless install');
assert(!blockTry.includes('NODECODA_KEY ='), 'codexTomlBlock: no secret key assignment is ever written');

const cfgTry = join(T.home, '.codex', 'config.try.toml');
await addCodexMcp(cfgTry, MCP_SERVER, { mcpBase: 'https://try.nodecoda.com/mcp' });
const textTry = await readFile(cfgTry, 'utf8');
assert(textTry.includes('try.nodecoda.com'), 'addCodexMcp: try base persisted for keyless install');

const cfg2 = join(T.proj, '.codex', 'config.toml');
await mkdir(dirname(cfg2), { recursive: true });
await writeFile(cfg2, '[mcp_servers.other]\ncommand = "x"\n');
r = await addCodexMcp(cfg2);
assert(r.status === 'added', 'addCodexMcp: preserves existing other server, adds nodecoda');
const text2 = await readFile(cfg2, 'utf8');
assert(text2.includes('[mcp_servers.other]'), 'addCodexMcp: existing [mcp_servers.other] preserved');
assert(codexTomlHasServer(text2), 'addCodexMcp: nodecoda appended');

const cfg3 = join(T.proj, '.codex2', 'config.toml');
await mkdir(dirname(cfg3), { recursive: true });
await writeFile(cfg3, '[mcp_servers.nodecoda]\ncommand = "keep-me"\n');
r = await addCodexMcp(cfg3);
assert(r.status === 'exists', 'addCodexMcp: pre-existing nodecoda -> exists (never clobbers)');
const text3 = await readFile(cfg3, 'utf8');
assert(text3.includes('keep-me'), 'addCodexMcp: pre-existing server untouched');

// --- 4. claudeMcpNames -----------------------------------------------------
let names = claudeMcpNames({ claudeBin: fakeClaude, env, cwd: T.proj });
assert(names.ok === true && names.names.length === 0, 'claudeMcpNames: fake claude (empty list) -> ok, no names');
const missing = claudeMcpNames({ claudeBin: join(tmp, 'does-not-exist'), env, cwd: T.proj });
assert(missing.ok === false, 'claudeMcpNames: missing claude binary -> ok=false');

await writeFile(fakeClaude, `#!/bin/sh\necho "nodecoda - stdio - ✓ Connected" >> "$CLAUDE_LOG"\ncase "$1 $2" in\n  "mcp list") echo "nodecoda - stdio - ✓ Connected";;\n  *) echo ok ;;\nesac\nexit 0\n`);
await chmod(fakeClaude, 0o755);
names = claudeMcpNames({ claudeBin: fakeClaude, env, cwd: T.proj });
assert(names.ok === true && names.names.includes('nodecoda'), 'claudeMcpNames: listed server detected');

// --- 5. addClaudeMcp -------------------------------------------------------
await rm(claudeLog, { force: true });
await writeFile(fakeClaude, `#!/bin/sh\necho "$@" >> "$CLAUDE_LOG"\nexit 0\n`);
await chmod(fakeClaude, 0o755);
r = addClaudeMcp({ claudeBin: fakeClaude, scope: 'user', env, cwd: T.proj });
assert(r.status === 'added', 'addClaudeMcp: user scope -> added');
let log = await readLog();
assert(
  log.includes('mcp add nodecoda --scope user -- npx -y @nodecoda/skill mcp'),
  'addClaudeMcp: invokes `claude mcp add nodecoda --scope user -- npx -y @nodecoda/skill mcp`'
);
r = addClaudeMcp({ claudeBin: fakeClaude, scope: 'bogus', env, cwd: T.proj });
assert(r.status === 'failed', 'addClaudeMcp: invalid scope -> failed');

// --- 6. registerClaudeMcp --------------------------------------------------
await rm(claudeLog, { force: true });
r = await registerClaudeMcp({ claudeBin: fakeClaude, scope: 'user', env, cwd: T.proj });
assert(r.status === 'added', 'registerClaudeMcp: not registered -> add executed');
log = await readLog();
assert(log.includes('mcp add nodecoda --scope user'), 'registerClaudeMcp: add called with user scope');

await writeFile(fakeClaude, `#!/bin/sh\necho "$@" >> "$CLAUDE_LOG"\ncase "$1 $2" in\n  "mcp list") echo "nodecoda - stdio - ✓ Connected";;\n  *) echo ok ;;\nesac\nexit 0\n`);
await chmod(fakeClaude, 0o755);
await rm(claudeLog, { force: true });
r = await registerClaudeMcp({ claudeBin: fakeClaude, scope: 'user', env, cwd: T.proj });
assert(r.status === 'exists', 'registerClaudeMcp: already registered -> exists');
log = await readLog();
assert(!log.includes('mcp add'), 'registerClaudeMcp: no duplicate add when already registered');

// --- 7. mergeJsonMcp / addGeminiMcp -----------------------------------------
const gem = join(T.home, '.gemini', 'settings.json');
r = await addGeminiMcp(gem);
assert(r.status === 'added', 'addGeminiMcp: fresh settings.json -> added');
let g = JSON.parse(await readFile(gem, 'utf8'));
assert(g.mcpServers?.nodecoda?.command === 'npx', 'addGeminiMcp: mcpServers.nodecoda.command = npx');
assert(JSON.stringify(g.mcpServers.nodecoda.args) === JSON.stringify(['-y', '@nodecoda/skill', 'mcp']), 'addGeminiMcp: zero-install args');
r = await addGeminiMcp(gem);
assert(r.status === 'exists', 'addGeminiMcp: second call -> exists');

await writeFile(gem, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }, null, 2) + '\n');
r = await addGeminiMcp(gem);
assert(r.status === 'added', 'addGeminiMcp: merges into existing config');
g = JSON.parse(await readFile(gem, 'utf8'));
assert(g.mcpServers.other.command === 'x' && g.theme === 'dark', 'addGeminiMcp: existing keys preserved');
assert(g.mcpServers.nodecoda.command === 'npx', 'addGeminiMcp: nodecoda added');

// --- 8. addCursorMcp ---------------------------------------------------------
const cursorProj = join(tmp, 'cursor-proj');
await mkdir(cursorProj, { recursive: true });
r = await addCursorMcp(cursorProj);
assert(r.status === 'added' && existsSync(join(cursorProj, '.cursor', 'mcp.json')), 'addCursorMcp: fresh project -> .cursor/mcp.json added');
await writeFile(join(cursorProj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { keep: { command: 'y' } } }, null, 2) + '\n');
r = await addCursorMcp(cursorProj);
assert(r.status === 'added', 'addCursorMcp: merges into existing .cursor/mcp.json');
const cj = JSON.parse(await readFile(join(cursorProj, '.cursor', 'mcp.json'), 'utf8'));
assert(cj.mcpServers.keep.command === 'y' && cj.mcpServers.nodecoda.command === 'npx', 'addCursorMcp: existing + nodecoda both present');
r = await addCursorMcp(cursorProj);
assert(r.status === 'exists', 'addCursorMcp: idempotent');

// --- 9. registerMcp orchestration --------------------------------------------
// Reset the fake claude to "not registered" (empty list, logs args).
await writeFile(fakeClaude, `#!/bin/sh\necho "$@" >> "$CLAUDE_LOG"\ncase "$1 $2" in\n  "mcp list") : ;;\n  *) echo ok ;;\nesac\nexit 0\n`);
await chmod(fakeClaude, 0o755);

let reg = await registerMcp({ platform: 'codex', scope: 'home', projectDir: T.proj, homeDir: join(tmp, 'reg-home') });
assert(reg.ok && reg.lines.length === 1, 'registerMcp: codex home -> ok');
assert(existsSync(join(tmp, 'reg-home', '.codex', 'config.toml')), 'registerMcp: codex home writes ~/.codex/config.toml');

reg = await registerMcp({ platform: 'codex', scope: 'project', projectDir: T.proj, homeDir: T.home });
assert(existsSync(join(T.proj, '.codex', 'config.toml')), 'registerMcp: codex project writes <proj>/.codex/config.toml');

await rm(claudeLog, { force: true });
reg = await registerMcp({ platform: 'claude-code', scope: 'home', projectDir: T.proj, homeDir: T.home, claudeBin: fakeClaude, env });
assert(reg.ok === true, 'registerMcp: claude-code home -> ok');
log = await readLog();
assert(log.includes('mcp add nodecoda --scope user'), 'registerMcp: claude-code home uses user scope');

await rm(claudeLog, { force: true });
reg = await registerMcp({ platform: 'claude-code', scope: 'project', projectDir: T.proj, homeDir: T.home, claudeBin: fakeClaude, env });
log = await readLog();
assert(log.includes('mcp add nodecoda --scope project'), 'registerMcp: claude-code project uses project scope');

reg = await registerMcp({ platform: 'gemini-cli', scope: 'home', projectDir: T.proj, homeDir: T.home });
assert(reg.ok === true, 'registerMcp: gemini-cli home -> ok');
reg = await registerMcp({ platform: 'cursor', scope: 'project', projectDir: cursorProj, homeDir: T.home });
assert(reg.ok === true, 'registerMcp: cursor project -> ok');

reg = await registerMcp({ platform: 'unknown', scope: 'home', projectDir: T.proj, homeDir: T.home });
assert(reg.ok === true && reg.lines[0].includes('skipped'), 'registerMcp: unknown platform -> skipped (never fails install)');

// --- cleanup ----------------------------------------------------------------
await rm(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}   ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
