#!/usr/bin/env node
// scripts/test-live-mcp.mjs
// Regression tests for scripts/live-mcp.mjs against a local stub gateway
// that mimics the live deployment (verified 2026-08-12):
//   - every response is wrapped as { code, message, data: {...} }
//   - SUCCEEDED polls carry artifact *metadata* only
//   - raw artifact content lives at GET /workflow-builds/{id}/artifact
//
// Guards the two live-gateway fixes:
//   1. envelope unwrapping (previously build_id was always undefined)
//   2. artifact download + save (previously "saved" with no file)
// Plus the FAILED terminal path (exit 2 + diagnostics surfaced).
// No network, no external deps.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ${'\x1b[32m✓\x1b[0m'} ${n}`); pass++; };
const bad = (n, why) => { console.log(`  ${'\x1b[31m✗\x1b[0m'} ${n}\n      ${why}`); fail++; };

const ARTIFACT_YAML = 'name: regression\n';
const ARTIFACT_SHA = createHash('sha256').update(ARTIFACT_YAML).digest('hex');

// ---- stub gateway -------------------------------------------------------

const wrap = (obj) => ({ code: 0, message: 'success', data: obj });
const pollCount = new Map();      // build_id -> number of GET polls seen
const postSeen = [];              // { headerKey, bodyKey } per POST

const stub = createServer((req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'POST' && url.startsWith('/workflow-builds')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      postSeen.push({ headerKey: req.headers['idempotency-key'] ?? null, bodyKey: body.idempotency_key ?? null });
      const buildId = postSeen.length === 1 ? 'job_regress_happy' : 'job_regress_failed';
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(202);
      res.end(JSON.stringify(wrap({
        build_id: buildId,
        source_filename: body.source_filename,
        language_identity: body.language_identity,
        target_profile: body.target_profile,
        status: 'QUEUED',
        failure_kind: null,
        diagnostics: [],
        artifact_sha256: null,
        artifact_media_type: null,
        artifact_available: false,
      })));
    });
    return;
  }
  const m = /^\/workflow-builds\/([^/]+)$/.exec(url);
  if (req.method === 'GET' && m) {
    const id = m[1];
    const n = (pollCount.get(id) ?? 0) + 1;
    pollCount.set(id, n);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    if (id === 'job_regress_happy') {
      if (n === 1) {
        res.end(JSON.stringify(wrap({ build_id: id, status: 'QUEUED', diagnostics: [], artifact_available: false })));
      } else {
        res.end(JSON.stringify(wrap({
          build_id: id,
          status: 'SUCCEEDED',
          failure_kind: null,
          diagnostics: [],
          artifact_sha256: ARTIFACT_SHA,
          artifact_size: ARTIFACT_YAML.length,
          artifact_media_type: 'application/yaml',
          artifact_available: true,
        })));
      }
    } else {
      res.end(JSON.stringify(wrap({
        build_id: id,
        status: 'FAILED',
        failure_kind: 'SOURCE',
        diagnostics: [{ code: 'E_TEST', message: 'regression failure diagnostic', location: { line: 1, column: 1 } }],
        artifact_available: false,
      })));
    }
    return;
  }
  const dl = /^\/workflow-builds\/([^/]+)\/artifact$/.exec(url);
  if (req.method === 'GET' && dl && dl[1] === 'job_regress_happy') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.writeHead(200);
    res.end(ARTIFACT_YAML);
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

// ---- run live-mcp.mjs ---------------------------------------------------

function runLiveMcp() {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/live-mcp.mjs'), '--source', join(REPO_ROOT, 'skills/nodecoda-workflow/examples/01-hello-workflow.ncoda')], {
      env: {
        ...process.env,
        NODECODA_KEY: 'sk-regression',
        NODECODA_API_BASE: `http://127.0.0.1:${stubPort}`,
        NODECODA_POLL_TIMEOUT_MS: '8000',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('exit', (code) => resolveP({ code, out }));
  });
}

// ---- tests --------------------------------------------------------------

console.log('live-mcp.mjs gateway regression tests');

// happy path: envelope unwrap + artifact download + save
{
  const { code, out } = await runLiveMcp();
  const savedFile = join(ARTIFACTS_DIR, 'job_regress_happy.yaml');
  if (code !== 0) { bad('happy path exits 0', `exit=${code}\n${out.slice(0, 500)}`); }
  else ok('happy path exits 0');

  if (!out.includes('build_id=job_regress_happy')) bad('admission reads unwrapped build_id', out.slice(0, 500));
  else ok('admission reads unwrapped build_id (envelope fix)');

  if (!out.includes('status=SUCCEEDED')) bad('poll reads unwrapped status', out.slice(0, 500));
  else ok('poll reads unwrapped status');

  if (!out.includes('artifact') || !out.includes('saved')) bad('artifact save logged', out.slice(0, 500));
  else ok('artifact save logged');

  if (!existsSync(savedFile)) { bad('artifact file written', `missing ${savedFile}`); }
  else {
    const content = await readFile(savedFile, 'utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    if (content === ARTIFACT_YAML && sha === ARTIFACT_SHA) ok('artifact file content + sha256 match stub metadata');
    else bad('artifact file content', `sha=${sha} expected=${ARTIFACT_SHA} content=${JSON.stringify(content)}`);
  }
  const fwd = postSeen[0];
  if (fwd && fwd.headerKey && fwd.headerKey === fwd.bodyKey) ok('Idempotency-Key header forwarded and matches body');
  else bad('Idempotency-Key forwarding', JSON.stringify(fwd));
}

// failed path: terminal FAILED -> exit 2 + diagnostics surfaced
{
  const { code, out } = await runLiveMcp();
  if (code !== 2) bad('failed path exits 2', `exit=${code}\n${out.slice(0, 500)}`);
  else ok('failed path exits 2');

  if (!out.includes('FAILED')) bad('failed path reports FAILED', out.slice(0, 500));
  else ok('failed path reports FAILED');

  if (!out.includes('E_TEST') || !out.includes('regression failure diagnostic')) bad('diagnostics surfaced', out.slice(0, 500));
  else ok('diagnostics surfaced');
}

// ---- cleanup ------------------------------------------------------------

stub.close();
rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail === 0 ? 'OK' : 'FAIL'}\x1b[0m   ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
