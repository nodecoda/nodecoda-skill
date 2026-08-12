#!/usr/bin/env node
// scripts/save-build.mjs
// Fetch a Workflow Build (record + artifact) from the NodeCoda backend and
// save both to a local directory, ready to use.
//
// REST surface (local dev backend):
//   GET {base}/v1/workflow-builds/:id          -> build record (JSON)
//   GET {base}/v1/workflow-builds/:id/artifact -> compiled artifact (raw)
//
// Env:
//   NODECODA_KEY       required - API key that exists in the target backend DB
//   NODECODA_API_BASE  default http://127.0.0.1:8080
//
// Usage:
//   node scripts/save-build.mjs <build_id> [--source <file.ncoda>] [--out <dir>] [--base <url>] [--flat]
//
// Output (in <out>/<build_id>/ by default, or <out>/ when --flat):
//   <source-base>.dify.yaml   compiled artifact (Dify Workflow YAML)
//   <source-base>.build.json  full build record (status, sha256, diagnostics...)
//   <source-base>.ncoda       client-side source copy (only with --source)
//
// The backend stores only source_sha256, NOT the source text; the client must
// keep its own copy. Pass --source to save it alongside the artifact/record.

import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const BASE = (process.env.NODECODA_API_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const KEY = process.env.NODECODA_KEY;

const args = process.argv.slice(2);
let buildId = null;
let outDir = 'builds';
let sourcePath = null;
let flat = false;
let base = BASE;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--out') outDir = args[++i];
  else if (arg === '--source') sourcePath = args[++i];
  else if (arg === '--base') base = args[++i].replace(/\/$/, '');
  else if (arg === '--flat') flat = true;
  else if (!buildId) buildId = arg;
  else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
}

if (!buildId) {
  console.error('usage: node scripts/save-build.mjs <build_id> [--source <file.ncoda>] [--out <dir>] [--base <url>] [--flat]');
  process.exit(2);
}
if (!KEY) {
  console.error('NODECODA_KEY is not set');
  process.exit(2);
}

// Per-build directory by default (builds/<build_id>/), flat with --flat.
const targetDir = flat ? outDir : path.join(outDir, buildId);

async function get(pathname, raw = false) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: raw ? undefined : 'application/json' },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status} ${pathname}: ${body}`);
  }
  return raw ? res.text() : res.json();
}

async function main() {
  const rec = await get(`/v1/workflow-builds/${encodeURIComponent(buildId)}`);
  const data = rec.data ?? rec;
  const status = data.status;
  console.log(`build ${buildId}: ${status}`);

  await mkdir(targetDir, { recursive: true });

  // Save client-side source copy if provided (backend does not store source text).
  if (sourcePath) {
    if (existsSync(sourcePath)) {
      const sourceName = path.basename(sourcePath);
      await copyFile(sourcePath, path.join(targetDir, sourceName));
      console.log(`source:   ${path.join(targetDir, sourceName)}`);
    } else {
      console.warn(`warning: --source file not found, skipped: ${sourcePath}`);
    }
  }

  if (status !== 'SUCCEEDED' && status !== 'succeeded') {
    // still save the record so diagnostics are inspectable
    const recPath = path.join(targetDir, `${buildId}.build.json`);
    await writeFile(recPath, JSON.stringify(data, null, 2));
    console.log(`record saved: ${recPath} (no artifact: status=${status})`);
    return;
  }

  const sourceBase = (data.source_filename || buildId).replace(/\.ncoda$/, '');
  const artifact = await get(`/v1/workflow-builds/${encodeURIComponent(buildId)}/artifact`, true);

  const artPath = path.join(targetDir, `${sourceBase}.dify.yaml`);
  const recPath = path.join(targetDir, `${sourceBase}.build.json`);
  await writeFile(artPath, artifact);
  await writeFile(recPath, JSON.stringify(data, null, 2));

  console.log(`artifact: ${artPath}`);
  console.log(`record:   ${recPath}`);
  console.log(`media_type=${data.artifact_media_type} sha256=${data.artifact_sha256} size=${data.artifact_size}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
