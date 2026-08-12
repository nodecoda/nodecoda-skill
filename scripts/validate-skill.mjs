#!/usr/bin/env node
// scripts/validate-skill.mjs
// Validate every skill under skills/* against the NodeCoda skill contract.
// Pure Node 18+ built-ins, no dependencies.
//
// Exit codes:
//   0  all skills valid
//   1  one or more validation errors
//   2  environment error (missing skill dir, unreadable manifest, ...)
//
// Usage:
//   node scripts/validate-skill.mjs                 # validate all
//   node scripts/validate-skill.mjs <skill-name>   # validate one
//   node scripts/validate-skill.mjs --list         # list discovered skills
//   node scripts/validate-skill.mjs --info <name>  # print manifest

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

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

const REQUIRED_MANIFEST = [
  'name', 'version', 'description', 'platforms', 'min_nodecoda',
  'target_profile', 'language_identity', 'mcp_tools', 'entry', 'license',
];
const RECOMMENDED_MANIFEST = [
  'homepage', 'repository', 'references', 'examples',
];

const KNOWN_PLATFORMS = new Set([
  'claude-code', 'codex', 'gemini-cli', 'cursor',
  'aider', 'cline', 'windsurf',
]);

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$/;

const errors = [];
const warnings = [];
function err(skill, msg) { errors.push({ skill, msg }); }
function warn(skill, msg) { warnings.push({ skill, msg }); }

async function loadManifest(skillDir) {
  const p = join(skillDir, 'manifest.json');
  if (!existsSync(p)) { err(basename(skillDir), 'manifest.json missing'); return null; }
  let raw;
  try { raw = await readFile(p, 'utf8'); }
  catch (e) { err(basename(skillDir), `manifest.json unreadable: ${e.message}`); return null; }
  try { return JSON.parse(raw); }
  catch (e) { err(basename(skillDir), `manifest.json is not valid JSON: ${e.message}`); return null; }
}

function validateManifest(skillName, m) {
  for (const k of REQUIRED_MANIFEST) {
    if (m[k] === undefined || m[k] === null || m[k] === '') {
      err(skillName, `manifest.${k} is required`);
    }
  }
  for (const k of RECOMMENDED_MANIFEST) {
    if (m[k] === undefined) warn(skillName, `manifest.${k} is recommended`);
  }
  if (typeof m.name === 'string' && m.name !== skillName) {
    err(skillName, `manifest.name (${m.name}) must match directory name (${skillName})`);
  }
  if (typeof m.version === 'string' && !SEMVER_RE.test(m.version)) {
    err(skillName, `manifest.version (${m.version}) is not a valid semver string`);
  }
  if (typeof m.language_identity === 'string' && m.language_identity !== 'nodecoda/1') {
    warn(skillName, `manifest.language_identity (${m.language_identity}) is not 'nodecoda/1' — confirm intent`);
  }
  if (Array.isArray(m.platforms)) {
    for (const p of m.platforms) {
      if (!KNOWN_PLATFORMS.has(p)) {
        warn(skillName, `platform '${p}' is not in the known set (${[...KNOWN_PLATFORMS].join(', ')})`);
      }
    }
    if (m.platforms.length === 0) err(skillName, 'manifest.platforms must list at least one platform');
  }
  if (Array.isArray(m.mcp_tools)) {
    for (const t of m.mcp_tools) {
      if (typeof t !== 'string' || !/^[a-z][a-z0-9_]*$/.test(t)) {
        err(skillName, `manifest.mcp_tools contains invalid tool name: ${JSON.stringify(t)}`);
      }
    }
  } else if (m.mcp_tools !== undefined) {
    err(skillName, 'manifest.mcp_tools must be an array of strings');
  }
}

async function validateSkillMd(skillName, skillDir, manifest) {
  const entry = manifest?.entry ?? 'SKILL.md';
  const p = join(skillDir, entry);
  if (!existsSync(p)) { err(skillName, `entry file missing: ${entry}`); return; }
  const content = await readFile(p, 'utf8');
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fm) { err(skillName, `${entry} must start with YAML frontmatter (--- ... ---)`); return; }
  const fmBody = fm[1];
  if (!/^name:\s*\S+/m.test(fmBody)) err(skillName, `${entry} frontmatter missing 'name'`);
  if (!/^description:\s*\S+/m.test(fmBody)) {
    err(skillName, `${entry} frontmatter missing 'description'`);
  } else if (/description:[^\n]*runtime\s+(verified|tested|success)/i.test(fmBody)) {
    err(skillName, `${entry} description claims runtime success — forbidden by contract`);
  }
  if (!/(需求|workflow|流程|步骤)/i.test(content)) {
    warn(skillName, `${entry} body lacks any obvious workflow / process section`);
  }
}

async function validatePaths(skillName, skillDir, manifest, key, mustHaveContent = true) {
  const list = manifest?.[key];
  if (!Array.isArray(list)) return;
  for (const rel of list) {
    const p = join(skillDir, rel);
    if (!existsSync(p)) { err(skillName, `${key} entry does not exist: ${rel}`); continue; }
    if (mustHaveContent) {
      const st = await stat(p);
      if (st.size === 0) err(skillName, `${key} entry is empty: ${rel}`);
    }
  }
}

const NCODA_HEADER = /^@language\s+nodecoda\/1\s*$/m;
const NCODA_MODE = /^@mode\s+(workflow|advanced-chat)\s*$/m;

async function validateNcodaExamples(skillDir, manifest) {
  const examplesDir = join(skillDir, 'examples');
  if (!existsSync(examplesDir)) return;
  const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.ncoda'));
  const listed = new Set(
    Array.isArray(manifest?.examples) ? manifest.examples.map((e) => basename(e)) : []
  );
  for (const f of files) {
    if (listed.size > 0 && !listed.has(f)) {
      warn('nodecoda-workflow', `examples/${f} not listed in manifest.examples`);
    }
    const src = await readFile(join(examplesDir, f), 'utf8');
    if (!NCODA_HEADER.test(src)) err('nodecoda-workflow', `examples/${f} missing @language nodecoda/1 header`);
    if (!NCODA_MODE.test(src)) err('nodecoda-workflow', `examples/${f} missing @mode (workflow | advanced-chat) header`);
  }
  for (const listed_name of listed) {
    if (!files.includes(listed_name)) err('nodecoda-workflow', `manifest.examples lists ${listed_name} but file is missing`);
  }
}

async function discoverSkills() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`${c.red}error${c.reset}: skills/ directory not found at ${SKILLS_DIR}`);
    process.exit(2);
  }
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function validateOne(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) { err(skillName, 'skill directory not found'); return; }
  const m = await loadManifest(skillDir);
  if (!m) return;
  validateManifest(skillName, m);
  await validateSkillMd(skillName, skillDir, m);
  await validatePaths(skillName, skillDir, m, 'references');
  await validatePaths(skillName, skillDir, m, 'examples', false);
  await validateNcodaExamples(skillDir, m);
}

function printReport() {
  const bySkill = new Map();
  for (const e of errors) {
    if (!bySkill.has(e.skill)) bySkill.set(e.skill, { errs: [], warns: [] });
    bySkill.get(e.skill).errs.push(e.msg);
  }
  for (const w of warnings) {
    if (!bySkill.has(w.skill)) bySkill.set(w.skill, { errs: [], warns: [] });
    bySkill.get(w.skill).warns.push(w.msg);
  }
  for (const [skill, { errs, warns }] of bySkill) {
    if (errs.length === 0 && warns.length === 0) {
      console.log(`  ${c.green}✓${c.reset} ${c.bold}${skill}${c.reset} ${c.dim}ok${c.reset}`);
    } else {
      const mark = errs.length > 0 ? `${c.red}✗${c.reset}` : `${c.yellow}!${c.reset}`;
      console.log(`  ${mark} ${c.bold}${skill}${c.reset}`);
      for (const e of errs) console.log(`      ${c.red}error${c.reset}  ${e}`);
      for (const w of warns) console.log(`      ${c.yellow}warn${c.reset}   ${w}`);
    }
  }
}

async function listMode() {
  const names = await discoverSkills();
  console.log('Skills under skills/:');
  for (const n of names) console.log(`  - ${n}`);
}

async function infoMode(skillName) {
  const skillDir = join(SKILLS_DIR, skillName);
  if (!existsSync(skillDir)) {
    console.error(`${c.red}error${c.reset}: skill not found: ${skillName}`);
    process.exit(2);
  }
  const m = await loadManifest(skillDir);
  if (!m) process.exit(2);
  console.log(JSON.stringify(m, null, 2));
}

const args = process.argv.slice(2);
if (args[0] === '--list') { await listMode(); process.exit(0); }
if (args[0] === '--info') {
  if (!args[1]) { console.error('usage: validate-skill.mjs --info <skill-name>'); process.exit(2); }
  await infoMode(args[1]);
  process.exit(0);
}

const targetSkills = args.length > 0 ? args : await discoverSkills();
console.log(`${c.cyan}validating ${targetSkills.length} skill(s)${c.reset}`);
for (const s of targetSkills) await validateOne(s);
console.log();
printReport();
console.log();
if (errors.length > 0) {
  console.log(`${c.red}${c.bold}FAIL${c.reset}  ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`${c.green}${c.bold}OK${c.reset}    ${warnings.length} warning(s)`);
process.exit(0);
