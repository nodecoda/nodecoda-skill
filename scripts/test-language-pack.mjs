#!/usr/bin/env node
// scripts/test-language-pack.mjs
// Regression: language-pack validates (JSON schema keys + version.json hashes
// match actual files). Spawns validate-language-pack.mjs and asserts exit 0.
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILL = 'nodecoda-workflow';
const PACK = join(REPO_ROOT, 'skills', SKILL, 'language-pack');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; };
const bad = (n, why) => { console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${why}`); fail++; };

const has = async (rel) => {
  try { await readFile(join(PACK, rel), 'utf8'); return true; } catch { return false; }
};

// 1. pack exists with all expected files
const expected = ['version.json', 'grammar.ebnf', 'builtins.json', 'diagnostics.json',
  'antipatterns.json', 'targets/dify-1.16-graphon-0.6.json'];
const missing = [];
for (const f of expected) if (!(await has(f))) missing.push(f);
missing.length ? bad('language pack files present', `missing: ${missing.join(', ')}`) : ok('language pack files present');

// 2. validator passes
const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/validate-language-pack.mjs'), SKILL], { encoding: 'utf8' });
r.status === 0 ? ok('validate-language-pack exits 0') : bad('validate-language-pack exits 0', `status=${r.status} ${r.stdout}${r.stderr}`);

// 3. version.json declares source docs that exist in references/
const v = JSON.parse(await readFile(join(PACK, 'version.json'), 'utf8'));
const badDocs = (v.source_docs ?? []).filter(async () => false); // placeholder
const docs = v.source_docs ?? [];
const badList = [];
for (const d of docs) {
  const base = d.split('/').pop();
  if (!(await has(`../references/${base}`))) badList.push(d);
}
badList.length ? bad('version.json source_docs resolve to references/', `missing: ${badList.join(', ')}`) : ok('version.json source_docs resolve to references/');

// 4. drift detection: touching a source doc without regenerating version.json
//    must fail validation (research Phase 0: version-consistency check).
{
  const ref = join(REPO_ROOT, 'skills', SKILL, 'references', 'grammar-reference.md');
  const orig = await readFile(ref, 'utf8');
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(ref, orig + '\n');
  const drift = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/validate-language-pack.mjs'), SKILL], { encoding: 'utf8' });
  await writeFile(ref, orig); // restore before asserting
  const driftDetected = drift.status !== 0 && /source doc changed/.test(drift.stderr || drift.stdout);
  driftDetected
    ? ok('source-doc drift detected (references changed without pack regen)')
    : bad('source-doc drift detected', `status=${drift.status} ${drift.stdout}${drift.stderr}`);
}

// 5. grammar reference-completeness guard (review WATCH-1): the checker that
//    would have caught the else_clause_opt drift (referenced but undefined).
{
  const { findUndefinedNonterminals } = await import(join(REPO_ROOT, 'scripts/grammar-coverage.mjs'));
  const d1 = findUndefinedNonterminals('rule_a = "if" undef_x ;\n');
  ok('dangling nonterminal flagged', d1.undefinedRefs.includes('undef_x'));
  const d2 = findUndefinedNonterminals('rule_a = field_list ;\n', ['field_list']);
  ok('allowlisted omission not flagged', d2.undefinedRefs.length === 0);
  const d3 = findUndefinedNonterminals('field_list = IDENTIFIER ;\n', ['field_list']);
  ok('stale allowlist entry flagged', d3.staleAllowlist.includes('field_list'));
  const real = await readFile(join(PACK, 'grammar.ebnf'), 'utf8');
  const d4 = findUndefinedNonterminals(real);
  ok('real grammar.ebnf has no undefined refs beyond allowlist', d4.undefinedRefs.length === 0);
}

console.log(`\nOK   ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
