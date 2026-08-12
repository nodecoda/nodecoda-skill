#!/usr/bin/env node
// scripts/cli.mjs
// @nodecoda/skill CLI — distribute, list, and install NodeCoda agent skills.
//
// v0.1.x: ships a working filesystem-based CLI for the locally-bundled skill.
// v0.2.x: registry-backed `add`/`install` (npx zero-clone installer) and `mcp`
//         (zero-install MCP server) shipped. See package.json description.
//
// Usage:
//   nodecoda-skill list                       List all bundled skills
//   nodecoda-skill info <name>                Print a skill's manifest
//   nodecoda-skill install <name> [target]    Copy skill into an agent's skills dir
//   nodecoda-skill add <name>                 Alias for `install` (npm-style wording)
//   nodecoda-skill validate [name]            Run contract validation
//   nodecoda-skill mcp                        Serve MCP over stdio (zero-install
//                                             wiring: command="npx",
//                                             args=["-y","@nodecoda/skill","mcp"])
//   nodecoda-skill mcp --http [--port N]      Serve MCP Streamable HTTP instead
//   nodecoda-skill help                       Show this help
//
// Recognised target platforms for `install`:
//   codex         -> ./.codex/skills/  (project) or ~/.codex/skills/ (fallback)
//   claude-code   -> ./.claude/skills/  (project) or ~/.claude/skills/
//   gemini-cli    -> ./.gemini/skills/  (project) or ~/.gemini/skills/
//   cursor        -> generates ./.cursor/rules/<skill>.mdc (Cursor loads .mdc
//                     rules, not SKILL.md; content inlined with frontmatter)

import { readFile, writeFile, cp, mkdir, access } from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

// Passthrough for Project Mode tooling: `nodecoda-skill project ...` and
// `nodecoda-skill save-build ...` re-exec the repo-local scripts so they work
// from anywhere via `npx -y @nodecoda/skill project ...` (the scripts ship in
// the npm tarball; SKILL.md documents the npx form). Single source of truth:
// the underlying scripts keep their own CLI and tests.
function runScript(scriptName, args) {
  const script = join(__dirname, scriptName);
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  return r.status ?? 1;
}


const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
};

function die(msg, code = 2) {
  console.error(`${c.red}error${c.reset}: ${msg}`);
  process.exit(code);
}

const PLATFORM_DIRS = {
  'claude-code': '.claude',
  codex: '.codex',
  'gemini-cli': '.gemini',
  cursor: '.cursor',
};

function targetDir(platform, { project = process.cwd() } = {}) {
  const subdir = PLATFORM_DIRS[platform];
  if (!subdir) die(`unknown platform: ${platform}`);
  return join(project, subdir, 'skills');
}

async function pathExists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function loadManifest(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) die(`skill not found in this package: ${skillName}`);
  const raw = await readFile(join(skillDir, 'manifest.json'), 'utf8');
  return { skillDir, manifest: JSON.parse(raw) };
}

async function cmdList() {
  if (!existsSync(SKILLS_DIR)) die(`skills/ not found at ${SKILLS_DIR}`);
  const { readdir } = await import('node:fs/promises');
  const entries = (await readdir(SKILLS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  console.log(`${c.bold}bundled skills${c.reset}`);
  for (const n of entries) {
    const m = JSON.parse(await readFile(join(SKILLS_DIR, n, 'manifest.json'), 'utf8'));
    console.log(`  ${c.cyan}${n}${c.reset}  ${c.dim}v${m.version}${c.reset}  ${m.description.slice(0, 60)}…`);
  }
  return 0;
}

async function cmdInfo(skillName) {
  if (!skillName) die('usage: nodecoda-skill info <name>');
  const { manifest } = await loadManifest(skillName);
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}

async function installInto(skillName, dest) {
  const { skillDir, manifest } = await loadManifest(skillName);
  await mkdir(dest, { recursive: true });
  const target = join(dest, manifest.name);
  if (await pathExists(target)) {
    console.log(`${c.yellow}!${c.reset} overwriting existing ${target}`);
  }
  await cp(skillDir, target, { recursive: true });
  console.log(`${c.green}✓${c.reset} installed ${c.bold}${manifest.name}${c.reset} v${manifest.version} → ${target}`);
  console.log(`  platforms: ${manifest.platforms.join(', ')}`);
  console.log(`  entry:     ${manifest.entry}`);
  console.log(`  next:      restart your agent so it picks up the new skill`);
}

async function installCursor(skillName, { project = process.cwd() } = {}) {
  // Cursor does not load SKILL.md (it reads `.cursor/rules/*.mdc`), so a plain
  // copy into `.cursor/skills/` would be a no-op install. Generate a rules file
  // with YAML frontmatter and the full SKILL.md content inlined.
  const { skillDir, manifest } = await loadManifest(skillName);
  const rulesDir = join(project, '.cursor', 'rules');
  await mkdir(rulesDir, { recursive: true });
  const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
  const frontmatter = [
    '---',
    `description: ${manifest.description}`,
    'globs: **/*.ncoda',
    '---',
    '',
  ].join('\n');
  const target = join(rulesDir, `${manifest.name}.mdc`);
  await writeFile(target, `${frontmatter}${skill}`);
  console.log(`${c.green}✓${c.reset} installed ${c.bold}${manifest.name}${c.reset} v${manifest.version} → ${target} (Cursor .mdc rule)`);
  console.log(`  note: Cursor loads .mdc rules, not SKILL.md; the rule inlines the skill content.`);
  console.log(`  next: restart Cursor so the rule is picked up`);
}

// Fixed preference order when several signals are present.
const PLATFORM_PREFERENCE = ['codex', 'claude-code', 'gemini-cli', 'cursor'];

// Soft env markers for "this CLI was invoked from an agent session". These are
// best-effort (they exist on the agents we target but are not contractual).
function envPlatform() {
  const signals = {
    codex: () => Boolean(process.env.CODEX_HOME),
    'claude-code': () => Boolean(process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_HOME),
    'gemini-cli': () => Boolean(process.env.GEMINI_CACHE_DIR),
    cursor: () => false, // Cursor has no reliable session env marker
  };
  for (const p of PLATFORM_PREFERENCE) if (signals[p]()) return p;
  return null;
}

function detectPlatform(projectCwd, manifestPlatforms) {
  const inManifest = (p) => manifestPlatforms.includes(p);

  const fromEnv = envPlatform();
  if (fromEnv && inManifest(fromEnv)) return fromEnv;

  // Project-local agent dirs (the strongest non-env signal: this project is
  // already set up for a specific agent).
  for (const p of PLATFORM_PREFERENCE) {
    if (inManifest(p) && PLATFORM_DIRS[p] && existsSync(join(projectCwd, PLATFORM_DIRS[p]))) return p;
  }
  // Home-level agent config.
  for (const p of PLATFORM_PREFERENCE) {
    if (inManifest(p) && PLATFORM_DIRS[p] && existsSync(join(homedir(), PLATFORM_DIRS[p]))) return p;
  }
  return 'codex';
}

async function cmdInstall(skillName, explicitTarget) {
  if (!skillName) die('usage: nodecoda-skill install <name> [target-platform|target-dir]');
  const { manifest } = await loadManifest(skillName);
  // Decide target
  let dest;
  let cursor = false;
  if (explicitTarget) {
    if (explicitTarget === 'cursor') {
      cursor = true;
    } else if (PLATFORM_DIRS[explicitTarget]) {
      dest = targetDir(explicitTarget);
    } else if (explicitTarget.startsWith('/') || explicitTarget.startsWith('~') || explicitTarget.startsWith('.')) {
      dest = resolve(process.cwd(), explicitTarget.replace(/^~/, homedir()));
    } else {
      die(`unknown target '${explicitTarget}'. Use one of: ${Object.keys(PLATFORM_DIRS).join(', ')}, or an absolute/path/starting-with-dot-or-tilde`);
    }
  } else {
    // No explicit target: detect the platform instead of guessing.
    //  1. the agent session that invoked the CLI (env markers)
    //  2. an agent already present in the current project (existing dir)
    //  3. an agent configured in the user's home
    //  4. fallback: Codex (this repo's primary surface), project-local
    const picked = detectPlatform(process.cwd(), manifest.platforms);
    if (picked === 'cursor') {
      cursor = true;
    } else if (picked) {
      dest = targetDir(picked);
    } else {
      dest = join(homedir(), '.codex', 'skills');
    }
  }
  if (cursor) {
    await installCursor(skillName);
  } else {
    await installInto(skillName, dest);
  }
  return 0;
}

// `nodecoda-skill mcp` — serve the NodeCoda MCP server in-process, so agents
// can wire it with zero local install via `npx -y @nodecoda/skill mcp`.
// Default transport is stdio (Codex/Claude convention); `--http [--port N]`
// serves the Streamable HTTP transport instead. Neither variant ever returns:
// the stdio loop exits when stdin closes, the HTTP server on SIGINT/SIGTERM.
async function cmdMcp(rest) {
  const args = rest ?? [];
  if (args.includes('--http')) {
    const { runHttpMcp } = await import('./mcp-http-server.mjs');
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
    runHttpMcp({ ...(port !== undefined && !Number.isNaN(port) ? { port } : {}) });
    await new Promise(() => {});
  } else {
    const { runStdioMcp } = await import('./mcp-stdio-server.mjs');
    runStdioMcp();
    await new Promise(() => {});
  }
}

async function cmdValidate(target) {
  return new Promise((resolveP) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, 'validate-skill.mjs'), ...(target ? [target] : [])],
      { stdio: 'inherit' }
    );
    child.on('exit', (code) => resolveP(code ?? 1));
  });
}

function help() {
  const lines = [
    `${c.bold}nodecoda-skill${c.reset} — distribute NodeCoda agent skills`,
    ``,
    `Usage:`,
    `  nodecoda-skill list                        List all bundled skills`,
    `  nodecoda-skill info <name>                 Print a skill's manifest`,
    `  nodecoda-skill install <name> [target]     Copy skill into an agent's skills dir`,
    `  nodecoda-skill add <name>                  Alias for install (npm-style)`,
    `  nodecoda-skill validate [name]             Run contract validation`,
    `  nodecoda-skill mcp                         Serve MCP over stdio (npx zero-install)`,
    `  nodecoda-skill project <cmd> [args]      Project Mode: init/get-state/set-state/resolve/validate-transition`,
    `  nodecoda-skill save-build <build_id>     Save a build record + artifact locally`,
    `  nodecoda-skill mcp --http [--port N]       Serve MCP Streamable HTTP instead`,
    `  nodecoda-skill help                        Show this help`,
    ``,
    `Targets for install: ${Object.keys(PLATFORM_DIRS).join(', ')} or any path`,
    ``,
    `Examples:`,
    `  nodecoda-skill install nodecoda-workflow`,
    `  nodecoda-skill install nodecoda-workflow codex`,
    `  nodecoda-skill install nodecoda-workflow ~/.claude/skills`,
  ];
  console.log(lines.join('\n'));
  return 0;
}

const [, , sub, ...rest] = process.argv;
let code = 0;
try {
  switch (sub) {
    case 'list':
    case 'ls':
      code = await cmdList(); break;
    case 'info':
    case 'show':
      code = await cmdInfo(rest[0]); break;
    case 'install':
    case 'i':
      code = await cmdInstall(rest[0], rest[1]); break;
    case 'add':
      code = await cmdInstall(rest[0], rest[1]); break;
    case 'validate':
    case 'check':
      code = await cmdValidate(rest[0]); break;
    case 'mcp':
      await cmdMcp(rest); break; // never returns; the server owns the process
    case 'project':
      code = runScript('project.mjs', rest); break;
    case 'save-build':
    case 'save':
      code = runScript('save-build.mjs', rest); break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      code = help(); break;
    default:
      die(`unknown subcommand: ${sub}. Run 'nodecoda-skill help'.`);
  }
} catch (e) {
  die(e?.message ?? String(e));
}
process.exit(code);
