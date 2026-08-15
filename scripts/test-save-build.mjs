#!/usr/bin/env node
// scripts/test-save-build.mjs — stub-backed tests for scripts/save-build.mjs
// (the only shipped script that previously had zero coverage). Runs
// save-build.mjs against local stubs and asserts the envelope unwrap,
// artifact+record writes, sha256 integrity, source copy, the non-SUCCEEDED
// record-only path, AND the no-key guest JSON-RPC path (upstreamMode
// contract: no NODECODA_KEY -> guest try /mcp, artifact inline). No network.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SAVE = join(REPO_ROOT, 'scripts/save-build.mjs');

let pass = 0, fail = 0;
function ok(n) { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; }
function bad(n, d) { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; }

const ARTIFACT = 'app:\n  mode: workflow\nversion: 0.6.0\nname: test-flow\n';
const SHA = createHash('sha256').update(ARTIFACT).digest('hex');

function record(status) {
  return { code: 0, message: 'ok', data: {
    build_id: 'build_test123', status, source_filename: 'demo.ncoda',
    artifact_media_type: 'application/yaml', artifact_sha256: SHA,
    artifact_size: Buffer.byteLength(ARTIFACT),
  } };
}

function startStub(rec) {
  let artifactHits = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (url.pathname === '/v1/workflow-builds/build_test123') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(rec));
    } else if (url.pathname === '/v1/workflow-builds/build_test123/artifact') {
      artifactHits++;
      res.setHeader('content-type', 'application/yaml');
      res.end(ARTIFACT);
    } else {
      res.statusCode = 404;
      res.end('{"code":404,"message":"not found"}');
    }
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => resolveReady({ server, port: server.address().port, artifactHits: () => artifactHits }));
  });
}

// Guest JSON-RPC stub: speaks the JsonRpcUpstream protocol (initialize ->
// notifications/initialized -> tools/call) over HTTP with SSE frames, the
// same shape test-contract's JsonRpcUpstream tests assert. The tools/call
// response double-encodes the record as content[0].text (protocol contract).
function startJsonRpcStub(recordData) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch { /* ignore */ }
      res.setHeader('content-type', 'text/event-stream');
      if (msg.method === 'initialize') {
        res.setHeader('mcp-session-id', 'sess-guest-test');
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'stub', version: '1' } } })}\n\n`);
      } else if (msg.method === 'notifications/initialized') {
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', result: {} })}\n\n`);
      } else if (msg.method === 'tools/call') {
        const inner = JSON.stringify({ code: 0, message: 'ok', data: recordData });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: inner }] } })}\n\n`);
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => resolveReady({ server, port: server.address().port }));
  });
}

function guestRecord(status) {
  const base = {
    build_id: 'build_guest1', status, source_filename: 'demo.ncoda',
    artifact_media_type: 'application/yaml', artifact_sha256: SHA,
  };
  if (status === 'SUCCEEDED') {
    base.artifact = { content: ARTIFACT, media_type: 'application/yaml', sha256: SHA };
  } else {
    base.diagnostics = [{ code: 'E1', location: { line: 1, column: 1 }, message: 'bad type' }];
  }
  return base;
}

// async spawn: spawnSync would block this process's event loop, deadlocking
// the stub server (the child waits on it while the parent can't serve it).
function run(buildId, extra, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SAVE, buildId, ...extra], { cwd: REPO_ROOT, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'nc-savebuild-'));
  try {
    const src = join(tmp, 'demo.ncoda');
    await writeFile(src, '@language nodecoda/1\nfunction main(string q) -> string { return q; }\n');

    // --- 1. SUCCEEDED: envelope unwrap + artifact + record + sha256 + source copy ---
    const stub = await startStub(record('SUCCEEDED'));
    const base = `http://127.0.0.1:${stub.port}`;
    const out = join(tmp, 'out');
    const r = await run('build_test123', ['--source', src, '--out', out, '--base', base], { ...process.env, NODECODA_KEY: 'sk-test', NODECODA_API_BASE: base });
    const artPath = join(out, 'build_test123', 'demo.dify.yaml');
    const recPath = join(out, 'build_test123', 'demo.build.json');
    const srcPath = join(out, 'build_test123', 'demo.ncoda');
    const ok1 = r.status === 0 && existsSync(artPath) && existsSync(recPath) && existsSync(srcPath)
      && (await readFile(artPath, 'utf8')) === ARTIFACT
      && JSON.parse(await readFile(recPath, 'utf8')).status === 'SUCCEEDED'
      && JSON.parse(await readFile(recPath, 'utf8')).artifact_sha256 === SHA;
    if (ok1) ok('SUCCEEDED: artifact+record+source saved, envelope unwrapped, sha256 matches');
    else bad('SUCCEEDED path', `status=${r.status} out=${r.stdout.slice(0, 300)} err=${r.stderr.slice(0, 200)}`);

    // --- 2. FAILED: record saved, no artifact fetch ---
    const stub2 = await startStub(record('FAILED'));
    const base2 = `http://127.0.0.1:${stub2.port}`;
    const out2 = join(tmp, 'out2');
    const r2 = await run('build_test123', ['--out', out2, '--base', base2], { ...process.env, NODECODA_KEY: 'sk-test', NODECODA_API_BASE: base2 });
    const recPath2 = join(out2, 'build_test123', 'build_test123.build.json');
    const ok2 = r2.status === 0 && existsSync(recPath2) && !existsSync(join(out2, 'build_test123', 'demo.dify.yaml')) && stub2.artifactHits() === 0
      && JSON.parse(await readFile(recPath2, 'utf8')).status === 'FAILED';
    if (ok2) ok('FAILED: record-only save, no artifact request');
    else bad('FAILED path', `status=${r2.status} hits=${stub2.artifactHits()} out=${r2.stdout.slice(0, 200)}`);

    // --- 3. no key -> guest JSON-RPC path (try /mcp, artifact inline) ---
    const gstub = await startJsonRpcStub(guestRecord('SUCCEEDED'));
    const gout = join(tmp, 'gout');
    const envGuest = { ...process.env, NODECODA_KEY: undefined, NODECODA_MCP_JSONRPC_URL: `http://127.0.0.1:${gstub.port}/mcp` };
    const r3 = await run('build_guest1', ['--out', gout], envGuest);
    const gArt = join(gout, 'build_guest1', 'demo.dify.yaml');
    const gRec = join(gout, 'build_guest1', 'demo.build.json');
    const ok3 = r3.status === 0 && existsSync(gArt) && existsSync(gRec)
      && (await readFile(gArt, 'utf8')) === ARTIFACT
      && JSON.parse(await readFile(gRec, 'utf8')).status === 'SUCCEEDED'
      && /guest try \/mcp/.test(r3.stdout);
    if (ok3) ok('no-key guest JSON-RPC: artifact+record saved, inline artifact used, transport labeled');
    else bad('guest path', `status=${r3.status} out=${r3.stdout.slice(0, 250)} err=${r3.stderr.slice(0, 200)}`);

    // --- 3b. no key + FAILED -> record-only via guest, diagnostics kept ---
    const gstub2 = await startJsonRpcStub(guestRecord('FAILED'));
    const gout2 = join(tmp, 'gout2');
    const r3b = await run('build_guest1', ['--out', gout2], { ...envGuest, NODECODA_MCP_JSONRPC_URL: `http://127.0.0.1:${gstub2.port}/mcp` });
    const gRec2 = join(gout2, 'build_guest1', 'build_guest1.build.json');
    const ok3b = r3b.status === 0 && existsSync(gRec2) && !existsSync(join(gout2, 'build_guest1', 'demo.dify.yaml'))
      && JSON.parse(await readFile(gRec2, 'utf8')).status === 'FAILED'
      && JSON.parse(await readFile(gRec2, 'utf8')).diagnostics?.length === 1;
    if (ok3b) ok('no-key guest FAILED: record-only saved with diagnostics');
    else bad('guest failed path', `status=${r3b.status} out=${r3b.stdout.slice(0, 200)} err=${r3b.stderr.slice(0, 150)}`);

    // --- 4. missing build id -> exit 2 usage ---
    const r4 = await run('', [], process.env);
    if (r4.status === 2 && /usage/.test(r4.stderr)) ok('missing build id exits 2 with usage');
    else bad('missing build id', `status=${r4.status} err=${r4.stderr.slice(0, 150)}`);

    stub.server.close();
    stub2.server.close();
    gstub.server.close();
    gstub2.server.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(fail === 0 ? `\nOK   ${pass} passed, 0 failed` : `\nFAIL ${fail} failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
