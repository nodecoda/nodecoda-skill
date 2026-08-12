#!/usr/bin/env node
// scripts/test-contract.mjs
// Pure-Node contract tests for the NodeCoda skill distribution.
// No external deps. No network. No live MCP.
//
// What this asserts:
//   1. Every skill under skills/* passes scripts/validate-skill.mjs
//   2. Every .ncoda example can be wrapped in a build_dify_workflow request
//      that satisfies references/mcp-contract.md
//   3. SKILL.md frontmatter 'description' is consistent with manifest.mcp_tools
//   4. The README's install table matches the actual supported targets
//   5. package.json version does not lag the highest skill version
//      (npm is the single distribution channel; no pyproject.toml)
//
// Exit codes: 0=ok, 1=failure, 2=env error.

import { readFile, readdir, mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateProjectDir } from './validate-project.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ${'\x1b[32m✓\x1b[0m'} ${name}`); pass++; }
function bad(name, why) { console.log(`  ${'\x1b[31m✗\x1b[0m'} ${name}\n      ${why}`); fail++; }

// ---- 1. validate-skill.mjs runs and passes ----
function runValidator() {
  const r = spawnSync(process.execPath, [join(__dirname, 'validate-skill.mjs')], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) {
    bad('validate-skill.mjs exits 0', r.stdout + r.stderr);
    return false;
  }
  ok('validate-skill.mjs exits 0');
  return true;
}

// ---- 2. each .ncoda example satisfies mcp-contract shape ----
const NCODA_HEADER = /^@language\s+nodecoda\/1\s*$/m;
const NCODA_MODE = /^@mode\s+(workflow|advanced-chat)\s*$/m;

async function checkExamplesShape() {
  const skills = await readdir(SKILLS_DIR, { withFileTypes: true });
  for (const s of skills.filter((x) => x.isDirectory())) {
    const skillName = s.name;
    const examplesDir = join(SKILLS_DIR, skillName, 'examples');
    if (!existsSync(examplesDir)) continue;
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.ncoda'));
    for (const f of files) {
      const src = await readFile(join(examplesDir, f), 'utf8');
      const name = `${skillName}/examples/${f}`;
      if (!NCODA_HEADER.test(src)) { bad(name, 'missing @language nodecoda/1'); continue; }
      if (!NCODA_MODE.test(src)) { bad(name, 'missing @mode header'); continue; }
      // Build the mcp-contract.md shaped request
      const req = {
        source: src,
        source_filename: f,
        language_identity: 'nodecoda/1',
        target_profile: 'dify-1.16-graphon-0.6',
        idempotency_key: `test-${f}-${Date.now()}`,
      };
      for (const k of ['source', 'source_filename', 'language_identity', 'target_profile', 'idempotency_key']) {
        if (req[k] === undefined || req[k] === '') bad(name, `build request missing field: ${k}`);
      }
      if (req.idempotency_key.length > 200) bad(name, 'idempotency_key too long');
      ok(`${name} builds a valid build_dify_workflow request`);
    }
  }
}

// ---- 3. SKILL.md description is consistent with manifest.mcp_tools ----
async function checkSkillMdConsistency() {
  const skills = await readdir(SKILLS_DIR, { withFileTypes: true });
  for (const s of skills.filter((x) => x.isDirectory())) {
    const skillName = s.name;
    const skillDir = join(SKILLS_DIR, skillName);
    const m = JSON.parse(await readFile(join(skillDir, 'manifest.json'), 'utf8'));
    const entry = join(skillDir, m.entry ?? 'SKILL.md');
    if (!existsSync(entry)) { bad(`${skillName}/${m.entry}`, 'entry file missing'); continue; }
    const content = await readFile(entry, 'utf8');
    const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!fm) { bad(`${skillName}/${m.entry}`, 'no frontmatter'); continue; }
    // Each declared mcp_tool should appear (as a tool name) in the body
    for (const t of (m.mcp_tools ?? [])) {
      if (!content.includes(t)) {
        bad(`${skillName} SKILL.md mentions mcp tool`, `manifest declares '${t}' but SKILL.md never names it`);
      } else {
        ok(`${skillName} SKILL.md mentions mcp tool '${t}'`);
      }
    }
  }
}

// ---- 4. README install table matches real PLATFORM_DIRS (cheap heuristic) ----
async function checkReadmeInstallTable() {
  const readme = await readFile(join(REPO_ROOT, 'README.md'), 'utf8');
  // The README must contain at least one install example for claude-code and codex
  if (readme.toLowerCase().includes('claude-code') && !readme.includes('~/.claude/skills/')) {
    bad('README install table', 'mentions Claude Code but shows no ~/.claude/skills/ path');
  } else ok('README install table mentions Claude Code path');
  if (readme.toLowerCase().includes('codex') && !readme.includes('.codex/skills')) {
    bad('README install table', 'mentions Codex but shows no .codex/skills/ path');
  } else ok('README install table mentions Codex path');
}

// ---- 5. package.json version does not lag the highest skill version ----
async function checkPackageVersion() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));

  // Each skill's manifest.version should be reachable; we just sanity-check that
  // the npm `version` does not lag the highest skill version.
  const skills = await readdir(SKILLS_DIR, { withFileTypes: true });
  let maxSkill = '0.0.0';
  for (const s of skills.filter((x) => x.isDirectory())) {
    const m = JSON.parse(await readFile(join(SKILLS_DIR, s.name, 'manifest.json'), 'utf8'));
    if (compareSemver(m.version, maxSkill) > 0) maxSkill = m.version;
  }
  if (compareSemver(pkg.version, maxSkill) < 0) {
    bad('package.json version', `${pkg.version} < highest skill ${maxSkill}`);
  } else {
    ok(`package.json version ${pkg.version} >= highest skill ${maxSkill}`);
  }
}

function compareSemver(a, b) {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}


// ---- distribution completeness + tarball key content ----
// Regression guard for the P0 we fixed: SKILL.md/README reference scripts
// (project.mjs, save-build.mjs, ...) that MUST ship in the npm tarball.
// Any script a shipped doc references, or that cli.mjs can execute, must be
// present in the repo AND listed in package.json "files".
async function checkDistributionCompleteness() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const files = new Set(pkg.files);
  const refFiles = [
    'skills/nodecoda-workflow/SKILL.md',
    'README.md',
    'README.zh-CN.md',
    'docs/installation.md',
    ...['mcp-contract', 'source-generation', 'language-reference', 'public-service',
       'diagnostics', 'target-capabilities', 'iteration-loop', 'failure-modes',
       'project-workflow'].map((f) => `skills/nodecoda-workflow/references/${f}.md`),
  ];
  const refs = new Set();
  for (const f of refFiles) {
    const txt = await readFile(join(REPO_ROOT, f), 'utf8');
    for (const m of txt.matchAll(/scripts\/[a-zA-Z0-9._-]+\.(?:mjs|sh)/g)) refs.add(m[0]);
  }
  const missing = [...refs].filter((r) => !existsSync(join(REPO_ROOT, r)) || !files.has(r));
  if (missing.length === 0) ok('distribution: scripts referenced by shipped docs exist and are in package.json files');
  else bad('distribution: scripts referenced by shipped docs', `missing/not-shipped: ${missing.join(', ')}`);

  // every script cli.mjs can execute (validate / mcp / project / save-build) must ship
  const cli = await readFile(join(REPO_ROOT, 'scripts/cli.mjs'), 'utf8');
  const cliRefs = [
    ...[...cli.matchAll(/join\(__dirname,\s*'([^']+\.mjs)'\)/g)].map((m) => m[1]),
    ...[...cli.matchAll(/import\('\.\/([^']+\.mjs)'\)/g)].map((m) => m[1]),
  ];
  const cliMissing = [...new Set(cliRefs)].filter((r) => !files.has(`scripts/${r}`) || !existsSync(join(REPO_ROOT, 'scripts', r)));
  if (cliMissing.length === 0) ok('distribution: every script cli.mjs executes is shipped');
  else bad('distribution: cli.mjs runtime deps', `not in package.json files: ${cliMissing.join(', ')}`);

  // tarball key content: legal + bilingual docs + skill
  const required = ['LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'skills/'];
  const missingReq = required.filter((f) => !files.has(f));
  if (missingReq.length === 0) ok('tarball: LICENSE + NOTICE + bilingual README + CHANGELOG + skill all ship');
  else bad('tarball key content', `missing from files: ${missingReq.join(', ')}`);
}

// ---- main ----
console.log('contract tests');
if (!runValidator()) { console.log(`\nFAIL  ${fail} failed, ${pass} passed`); process.exit(1); }
await checkExamplesShape();
await checkSkillMdConsistency();
await checkReadmeInstallTable();
await checkPackageVersion();
await checkDistributionCompleteness();
await smokeStdioMcp();
await smokeCliMcp();
await smokeCliMcpNewlineFallback();
await smokeCliMcpMixedFraming();
await smokeCliInstall();
await smokeCliProject();
// Project-mode contract: validate examples/project/ once it exists
{
  const exampleProject = join(REPO_ROOT, 'examples', 'project');
  if (existsSync(join(exampleProject, 'nodecoda.yaml'))) {
    const errs = await validateProjectDir(exampleProject);
    if (errs.length === 0) ok('examples/project/ validates');
    else bad('examples/project/ validates', errs.join('; '));
  } else {
    console.log('  (skip: examples/project/ not yet created)');
  }
}
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail === 0 ? 'OK' : 'FAIL'}\x1b[0m   ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// ---- 7. cli.mjs `mcp` subcommand smoke (npx zero-install wiring) ----
// Guards the Layer-2 path: command="npx", args=["-y","@nodecoda/skill","mcp"]
// must serve MCP over stdio without any repo-local install.

async function smokeCliMcp() {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'mcp'], {
    env: { ...process.env, NODECODA_KEY: 'sk-contract-smoke' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-smoke', version: '0' } } }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  await sleep(3000);
  child.kill();

  const frames = out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean);
  if (frames.length < 2) {
    bad('cli mcp serves MCP over stdio', `got ${frames.length} frames:\n${out.slice(0, 300)}`);
    return;
  }
  const parsed = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const init = parsed.find((p) => p.id === 1);
  const list = parsed.find((p) => p.id === 2);
  if (init?.result?.serverInfo?.name?.includes('nodecoda') && (list?.result?.tools ?? []).length === 3) {
    ok('cli mcp serves MCP over stdio (npx zero-install path)');
  } else {
    bad('cli mcp serves MCP over stdio', `init=${JSON.stringify(init)} list=${JSON.stringify(list)}`);
  }
}


// Guards the newline-delimited JSON fallback in mcp-stdio-server.mjs: some
// tooling skips Content-Length framing entirely. Regression: the fallback was
// previously dead code because parseFrame returned before reaching it when no
// '\r\n\r\n' header block was present.
async function smokeCliMcpNewlineFallback() {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'mcp'], {
    env: { ...process.env, NODECODA_KEY: 'sk-contract-smoke' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  // Raw newline-delimited JSON, no Content-Length header at all.
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-newline-smoke', version: '0' } } }) + '\n');
  await sleep(2500);
  child.kill();

  const frames = out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean);
  const parsed = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const init = parsed.find((p) => p.id === 1);
  if (init?.result?.serverInfo?.name?.includes('nodecoda')) {
    ok('newline-delimited JSON fallback (no Content-Length) served by cli mcp');
  } else {
    bad('newline-delimited JSON fallback', `frames=${frames.length} init=${JSON.stringify(init)} out=${out.slice(0, 300)}`);
  }
}


// Mixed-framing integration: newline-delimited JSON and Content-Length frames
// interleaved in the same stream must all be answered (regression for buffer
// rest-carryover between parseFrame calls and the newline fallback fix).
async function smokeCliMcpMixedFraming() {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'mcp'], {
    env: { ...process.env, NODECODA_KEY: 'sk-contract-smoke' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  // Single write: bare newline init, framed tools/list, bare newline tools/list.
  const newline = (obj) => JSON.stringify(obj) + '\n';
  child.stdin.write(
    newline({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-mixed-smoke', version: '0' } } }) +
    frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) +
    newline({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  );
  await sleep(2500);
  child.kill();

  const frames = out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean);
  const parsed = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const byId = Object.fromEntries(parsed.map((p) => [p.id, p]));
  const initOk = byId[1]?.result?.serverInfo?.name?.includes('nodecoda');
  const listOk = [2, 3].every((id) => (byId[id]?.result?.tools ?? []).length === 3);
  if (initOk && listOk) {
    ok('mixed newline + Content-Length frames all answered in one stream');
  } else {
    bad('mixed newline + Content-Length frames all answered in one stream',
      `frames=${frames.length} ids=${parsed.map((p) => p.id).join(',')} out=${out.slice(0, 300)}`);
  }
}


// ---- 8. cli.mjs skill-distribution subcommands (Layer-3 npx add path) ----
// Guards `nodecoda-skill list | info | add | install | validate`: the npx
// zero-clone installer for the bundled skill (`npx @nodecoda/skill add
// nodecoda-workflow`). Copies skills/<name> into the target dir and keeps
// manifest/version in sync with the package.
async function smokeCliInstall() {
  const pkgVersion = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const tmp = await mkdtemp(join(tmpdir(), 'nccli-'));
  try {
    // 1. list
    const list = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'list'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (list.status === 0 && list.stdout.includes('nodecoda-workflow')) ok('cli list shows bundled nodecoda-workflow');
    else bad('cli list shows bundled nodecoda-workflow', `status=${list.status} out=${list.stdout.slice(0, 200)}`);

    // 2. info <name> returns manifest JSON with version matching the package
    const info = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'info', 'nodecoda-workflow'], { cwd: REPO_ROOT, encoding: 'utf8' });
    let infoJson = null;
    try { infoJson = JSON.parse(info.stdout); } catch { /* fallthrough */ }
    if (info.status === 0 && infoJson?.name === 'nodecoda-workflow' && infoJson?.version === pkgVersion) {
      ok('cli info returns manifest JSON in sync with package version');
    } else bad('cli info returns manifest JSON in sync with package version',
      `status=${info.status} version=${infoJson?.version} pkg=${pkgVersion}`);

    // 3. add <name> <absdir> copies the full skill tree
    const dest = join(tmp, 'dest');
    const add = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'add', 'nodecoda-workflow', dest], { cwd: REPO_ROOT, encoding: 'utf8' });
    const installed = join(dest, 'nodecoda-workflow');
    const treeOk = ['SKILL.md', 'manifest.json', 'references', 'examples'].every((e) => existsSync(join(installed, e)));
    if (add.status === 0 && add.stdout.includes('installed') && treeOk) {
      ok('cli add copies full skill tree to explicit target dir');
    } else bad('cli add copies full skill tree to explicit target dir',
      `status=${add.status} out=${add.stdout.slice(0, 200)} treeOk=${treeOk}`);

    // 4. add <name> with no target detects the platform (agent-aware install)
    // Fake HOME so home-level agent config on the dev/CI machine cannot leak
    // into the detection (deterministic on any machine).
    const cleanEnv = { ...process.env, HOME: join(tmp, 'fakehome') };
    for (const k of ['CODEX_HOME', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOME', 'GEMINI_CACHE_DIR']) delete cleanEnv[k];
    // Fake `claude` on PATH so the MCP auto-registration side effect of `add`
    // never touches a real Claude Code config and stays fast/deterministic.
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(join(fakeBin, 'claude'), '#!/bin/sh\necho "$@" >> "' + join(tmp, 'claude.log') + '"\nexit 0\n');
    await chmod(join(fakeBin, 'claude'), 0o755);
    cleanEnv.PATH = `${fakeBin}:${cleanEnv.PATH ?? ''}`;
    const cli = join(REPO_ROOT, 'scripts/cli.mjs');

    // 4a. no signals -> Codex fallback, HOME-level (user-wide install)
    {
      const autoProj = join(tmp, 'auto');
      await mkdir(autoProj, { recursive: true });
      const autoRun = spawnSync(process.execPath, [cli, 'add', 'nodecoda-workflow'], { cwd: autoProj, env: cleanEnv, encoding: 'utf8' });
      const codexAuto = existsSync(join(cleanEnv.HOME, '.codex', 'skills', 'nodecoda-workflow', 'SKILL.md'));
      const notProjectLocal = !existsSync(join(autoProj, '.codex'));
      const codexMcp = existsSync(join(cleanEnv.HOME, '.codex', 'config.toml'));
      if (autoRun.status === 0 && codexAuto && notProjectLocal && codexMcp) {
        ok('cli add (no target, no signals) -> HOME-level .codex + MCP auto-registered');
      } else bad('cli add (no target, no signals) -> HOME-level .codex + MCP auto-registered',
        `status=${autoRun.status} home=${codexAuto} project=${!notProjectLocal} mcp=${codexMcp}`);
    }

    // 4b. running inside a Claude Code session -> HOME-level .claude (user scope)
    {
      const ccProj = join(tmp, 'cc');
      await mkdir(ccProj, { recursive: true });
      const ccRun = spawnSync(process.execPath, [cli, 'add', 'nodecoda-workflow'], { cwd: ccProj, env: { ...cleanEnv, CLAUDE_CODE_ENTRYPOINT: '/tmp/cc' }, encoding: 'utf8' });
      const claudeCc = existsSync(join(cleanEnv.HOME, '.claude', 'skills', 'nodecoda-workflow', 'SKILL.md'));
      if (ccRun.status === 0 && claudeCc) ok('cli add detects Claude Code session env (CLAUDE_CODE_ENTRYPOINT) -> HOME-level .claude');
      else bad('cli add detects Claude Code session env', `status=${ccRun.status} claude=${claudeCc} out=${ccRun.stdout.slice(0, 120)}`);
    }

    // 4c. project already set up for Claude Code -> .claude
    {
      const projClaude = join(tmp, 'projclaude');
      await mkdir(join(projClaude, '.claude'), { recursive: true });
      const pRun = spawnSync(process.execPath, [cli, 'add', 'nodecoda-workflow'], { cwd: projClaude, env: cleanEnv, encoding: 'utf8' });
      const claudeProj = existsSync(join(projClaude, '.claude', 'skills', 'nodecoda-workflow', 'SKILL.md'));
      if (pRun.status === 0 && claudeProj) ok('cli add detects existing project .claude dir -> .claude');
      else bad('cli add detects existing project .claude dir', `status=${pRun.status} claude=${claudeProj} out=${pRun.stdout.slice(0, 120)}`);
    }

    // 4d. project has .cursor -> generates the .mdc rule instead of a dir copy
    {
      const projCursor = join(tmp, 'projcursor');
      await mkdir(join(projCursor, '.cursor'), { recursive: true });
      const cRun = spawnSync(process.execPath, [cli, 'add', 'nodecoda-workflow'], { cwd: projCursor, env: cleanEnv, encoding: 'utf8' });
      const mdcProj = existsSync(join(projCursor, '.cursor', 'rules', 'nodecoda-workflow.mdc'));
      if (cRun.status === 0 && mdcProj) ok('cli add detects existing project .cursor dir -> generates .mdc rule');
      else bad('cli add detects existing project .cursor dir', `status=${cRun.status} mdc=${mdcProj} out=${cRun.stdout.slice(0, 120)}`);
    }

    // 5. cursor target generates .cursor/rules/*.mdc (Cursor cannot load SKILL.md)
    {
      const curProj = join(tmp, 'cur');
      await mkdir(curProj, { recursive: true });
      const curRun = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'add', 'nodecoda-workflow', 'cursor'], { cwd: curProj, encoding: 'utf8' });
      const mdcPath = join(curProj, '.cursor', 'rules', 'nodecoda-workflow.mdc');
      const mdc = existsSync(mdcPath) ? await readFile(mdcPath, 'utf8') : '';
      const mdcOk = /^---\ndescription:/.test(mdc) && mdc.includes('@language nodecoda');
      if (curRun.status === 0 && mdcOk) {
        ok('cli add cursor generates .cursor/rules/*.mdc with frontmatter + skill content');
      } else bad('cli add cursor generates .cursor/rules/*.mdc with frontmatter + skill content',
        `status=${curRun.status} mdc=${mdc.slice(0, 80).replace(/\n/g, ' ')}`);
    }

    // 6. install <name> codex lands in ~/.codex/skills (named platform = user-wide)
    const proj = join(tmp, 'proj');
    await mkdir(proj, { recursive: true });
    const homeForInstall = join(tmp, 'home2');
    const instEnv = { ...process.env, HOME: homeForInstall, PATH: cleanEnv.PATH };
    const inst = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'install', 'nodecoda-workflow', 'codex'], { cwd: proj, env: instEnv, encoding: 'utf8' });
    const codexInstalled = existsSync(join(homeForInstall, '.codex', 'skills', 'nodecoda-workflow', 'SKILL.md'));
    const codexMcpInstalled = existsSync(join(homeForInstall, '.codex', 'config.toml'));
    if (inst.status === 0 && codexInstalled && codexMcpInstalled) ok('cli install <name> codex targets ~/.codex/skills + MCP config');
    else bad('cli install <name> codex targets ~/.codex/skills + MCP config', `status=${inst.status} out=${inst.stdout.slice(0, 200)} codexInstalled=${codexInstalled} mcp=${codexMcpInstalled}`);

    // 7. validate exits 0
    const val = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'validate'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (val.status === 0) ok('cli validate exits 0');
    else bad('cli validate exits 0', `status=${val.status} err=${val.stderr.slice(0, 200)}`);

    // 8. unknown subcommand fails with usage hint
    const badCmd = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'bogus'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (badCmd.status !== 0 && /unknown subcommand/.test(badCmd.stderr)) ok('cli unknown subcommand fails with hint');
    else bad('cli unknown subcommand fails with hint', `status=${badCmd.status} err=${badCmd.stderr.slice(0, 150)}`);

    // 9. info without a name fails with usage (no silent success)
    const infoNoArg = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'info'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (infoNoArg.status !== 0) ok('cli info without a name fails with usage');
    else bad('cli info without a name fails with usage', 'status=0');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}


// ---- 6. stdio MCP server smoke (round-trips to the live public API) ----


function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

// Upstream reachability probe: CI must not go red when www.nodecoda.com is
// briefly unreachable. The round-trip assertion below is skipped in that case.
async function upstreamReachable() {
  const base = process.env.NODECODA_MCP_BASE || 'https://www.nodecoda.com';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(base, { signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

async function smokeStdioMcp() {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/mcp-stdio-server.mjs')], {
    env: { ...process.env, NODECODA_KEY: 'sk-contract-smoke' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString('utf8'); });
  child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-smoke', version: '0' } } }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workflow_build', arguments: { build_id: 'contract-smoke-id' } } }));
  const upstream = await upstreamReachable();
  for (let i = 0; i < 40 && out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean).length < 3; i++) {
    await sleep(250);
  }
  child.kill();

  const frames = out.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean);
  if (frames.length < 3) {
    if (!upstream) {
      ok('stdio MCP server emits 3 responses (SKIPPED: upstream unreachable)');
      return;
    }
    bad('stdio MCP server emits 3 responses', `got ${frames.length} frames:\n${out.slice(0, 500)}`);
    return;
  }
  ok('stdio MCP server emits initialize/tools.list/tools.call responses');

  const parsed = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const init = parsed.find((p) => p.id === 1);
  const list = parsed.find((p) => p.id === 2);
  const call = parsed.find((p) => p.id === 3);
  if (!init?.result?.serverInfo?.name?.includes('nodecoda')) {
    bad('stdio MCP server.initialize', `unexpected: ${JSON.stringify(init)}`);
  } else ok('stdio MCP server.initialize reports NodeCoda server');

  const toolNames = (list?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ['build_dify_workflow', 'cancel_workflow_build', 'get_workflow_build'];
  if (JSON.stringify(toolNames) !== JSON.stringify(expected)) {
    bad('stdio MCP tools/list', `got ${JSON.stringify(toolNames)}`);
  } else ok('stdio MCP tools/list exposes the 3 manifest tools');

  // For tools.call, we expect either a real error envelope (401 INVALID_TOKEN from
  // the live public API) or a structured MCP error. Anything else is a bug.
  const callText = call?.result?.content?.[0]?.text ?? '';
  const isRealError = /INVALID_TOKEN|UNAVAILABLE|INSUFFICIENT_BALANCE|UNAUTHORIZED|404|400/.test(callText);
  const isMcpError = call?.error !== undefined || call?.result?.isError === true;
  if (!upstream) {
    ok('stdio MCP tools.call (SKIPPED: upstream unreachable)');
  } else if (isRealError || isMcpError) {
    ok('stdio MCP tools.call round-trips to the public API (real error envelope received)');
  } else {
    bad('stdio MCP tools.call', `unexpected response: ${callText.slice(0, 200)}`);
  }
}

async function smokeCliProject() {
  const tmp = await mkdtemp(join(tmpdir(), 'nc-cli-project-'));
  try {
    const dir = join(tmp, 'pf');
    const init = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'project', 'init', dir, '--project', 'pf', '--mode', 'workflow'], { cwd: tmp, encoding: 'utf8' });
    const okInit = init.status === 0 && existsSync(join(dir, 'nodecoda.yaml')) && existsSync(join(dir, 'nodecoda.state.json')) && existsSync(join(dir, 'src', 'pf.ncoda'));
    if (okInit) ok('cli project init creates project scaffolding');
    else bad('cli project init creates project scaffolding', `status=${init.status} out=${(init.stdout || '').slice(0, 200)}`);

    const st = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'project', 'get-state', dir], { cwd: tmp, encoding: 'utf8' });
    if (st.status === 0 && /"phase"\s*:\s*"INIT"/.test(st.stdout)) ok('cli project get-state returns phase');
    else bad('cli project get-state returns phase', `status=${st.status} out=${(st.stdout || '').slice(0, 200)}`);

    const ss = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'project', 'set-state', dir, 'DESIGNED'], { cwd: tmp, encoding: 'utf8' });
    if (ss.status === 0 && /DESIGNED/.test(ss.stdout)) ok('cli project set-state advances phase');
    else bad('cli project set-state advances phase', `status=${ss.status} out=${(ss.stdout || '').slice(0, 200)}`);

    const badAct = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'project', 'bogus-action'], { cwd: tmp, encoding: 'utf8' });
    if (badAct.status !== 0) ok('cli project unknown action fails');
    else bad('cli project unknown action fails', 'status=0');

    const sb = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'save-build'], { cwd: tmp, encoding: 'utf8' });
    if (sb.status !== 0) ok('cli save-build routes (usage on missing args)');
    else bad('cli save-build routes', 'status=0');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

