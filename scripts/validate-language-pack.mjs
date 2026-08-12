#!/usr/bin/env node
// scripts/validate-language-pack.mjs
// Validate skills/*/language-pack/ (machine-consumable language pack):
//   1. every JSON parses and has required top-level keys
//   2. version.json hashes match the actual files (sha256, sorted-key JSON;
//      grammar.ebnf hashed as raw text)
//   3. builtins/diagnostics/targets/antipatterns reference documents that exist
//   4. version.json source_hashes match the source references (raw-text sha256)
//      -> detects version drift: references changed without pack regeneration
// Pure Node 18+ built-ins, no dependencies.
//
// Usage:
//   node scripts/validate-language-pack.mjs            # validate all skills
//   node scripts/validate-language-pack.mjs <skill>    # validate one skill
// Exit: 0 ok / 1 errors / 2 env error

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const errors = [];
const err = (m) => errors.push(m);

const sortKeys = (o) => {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return o;
};
const hashJson = (data) => createHash('sha256').update(JSON.stringify(sortKeys(data))).digest('hex');
const hashText = (buf) => createHash('sha256').update(buf).digest('hex');

async function validatePack(skillName) {
  const packDir = join(SKILLS_DIR, skillName, 'language-pack');
  if (!existsSync(packDir)) return; // no language pack: not an error
  const versionPath = join(packDir, 'version.json');
  if (!existsSync(versionPath)) { err(`${skillName}: language-pack/version.json missing`); return; }
  let v;
  try { v = JSON.parse(await readFile(versionPath, 'utf8')); }
  catch (e) { err(`${skillName}: version.json unreadable: ${e.message}`); return; }

  const required = ['language', 'pack_version', 'hashes', 'source_hashes'];
  for (const k of required) if (v[k] === undefined) err(`${skillName}: version.json missing key '${k}'`);

  // hash consistency
  for (const [rel, expect] of Object.entries(v.hashes ?? {})) {
    const p = join(packDir, rel);
    if (!existsSync(p)) { err(`${skillName}: version.json hashes ${rel} but file missing`); continue; }
    let actual;
    if (rel.endsWith('.ebnf')) actual = hashText(await readFile(p));
    else {
      try { actual = hashJson(JSON.parse(await readFile(p, 'utf8'))); }
      catch (e) { err(`${skillName}: ${rel} not valid JSON: ${e.message}`); continue; }
    }
    if (actual !== expect) err(`${skillName}: hash mismatch for ${rel}`);
  }

  // schema sanity: required top-level keys per file
  const checks = [
    ['builtins.json', ['builtins']],
    ['diagnostics.json', ['categories']],
    ['targets/dify-1.16-graphon-0.6.json', ['target_profile', 'supported', 'partial', 'unsupported']],
    ['antipatterns.json', ['items']],
  ];
  for (const [rel, keys] of checks) {
    const p = join(packDir, rel);
    if (!existsSync(p)) continue;
    const data = JSON.parse(await readFile(p, 'utf8'));
    for (const k of keys) if (data[k] === undefined) err(`${skillName}: ${rel} missing key '${k}'`);
  }

  // source-doc consistency: if a source reference changed but the pack
  // version.json was not regenerated, the AI would receive stale rules
  // (research: version drift). Hash every source_doc as raw text.
  const refsDir = join(SKILLS_DIR, skillName, 'references');
  for (const rel of [...(v.source_docs ?? [])]) {
    const p = join(refsDir, basename(rel));
    if (!existsSync(p)) {
      err(`${skillName}: version.json source_docs references missing doc: ${rel}`);
      continue;
    }
    const expectSrc = v.source_hashes?.[rel];
    if (expectSrc === undefined) {
      err(`${skillName}: version.json source_hashes missing entry for ${rel}`);
      continue;
    }
    const actualSrc = hashText(await readFile(p));
    if (actualSrc !== expectSrc) {
      err(`${skillName}: source doc changed since pack generation: ${rel} (re-extract language pack + recompute version.json)`);
    }
  }
}

const skills = process.argv[2] ? [process.argv[2]] : (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
for (const s of skills) await validatePack(s);

if (errors.length) {
  console.error(`language pack: ${errors.length} error(s)`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`language pack: ${skills.length} skill(s) OK`);
