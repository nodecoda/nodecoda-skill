#!/usr/bin/env node
// scripts/validate-project.mjs - validate a project directory structure (Node 18+, no deps)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REQUIRED_MANIFEST_KEYS = ['project', 'mode', 'target_profile', 'language_identity', 'source'];
const VALID_MODES = ['workflow', 'advanced-chat'];
const REQUIRED_STATE_KEYS = ['phase', 'rev', 'current_build_id', 'source_sha256', 'last_diagnostics', 'history'];

export function validateManifest(text) {
  const errors = [];
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!new RegExp(`^${key}:\\s*(.+)$`, 'm').test(text)) errors.push(`manifest missing key: ${key}`);
  }
  const m = text.match(/^mode:\s*(.+)$/m);
  if (m && !VALID_MODES.includes(m[1].trim())) errors.push(`invalid mode: ${m[1].trim()}`);
  return errors;
}

export function validateState(obj) {
  const errors = [];
  for (const key of REQUIRED_STATE_KEYS) if (!(key in obj)) errors.push(`state missing key: ${key}`);
  return errors;
}

export async function validateProjectDir(dir) {
  const errors = [];
  const manifestPath = join(dir, 'nodecoda.yaml');
  const statePath = join(dir, 'nodecoda.state.json');
  if (!existsSync(manifestPath)) return ['missing nodecoda.yaml'];
  if (!existsSync(statePath)) return ['missing nodecoda.state.json'];
  const manifest = await readFile(manifestPath, 'utf-8');
  errors.push(...validateManifest(manifest));
  try { errors.push(...validateState(JSON.parse(await readFile(statePath, 'utf-8')))); }
  catch (e) { errors.push(`state.json parse failed: ${e.message}`); }
  const srcMatch = manifest.match(/^source:\s*(.+)$/m);
  if (srcMatch && !existsSync(join(dir, srcMatch[1].trim()))) errors.push(`source file missing: ${srcMatch[1].trim()}`);
  if (!existsSync(join(dir, 'design.md'))) errors.push('missing design.md');
  return errors;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: validate-project.mjs <project-dir>'); process.exit(2); }
  const errors = await validateProjectDir(resolve(dir));
  if (errors.length) { for (const e of errors) console.error(`ERROR: ${e}`); process.exit(1); }
  console.log('OK');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
