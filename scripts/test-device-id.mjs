#!/usr/bin/env node
// scripts/test-device-id.mjs
// Tests for scripts/device-id.mjs (K-E3: UUID v4 persistence, 0600 perms,
// cross-session stability) and mcp-core.mjs guest headers (K-E2: placeholder
// key + X-NodeCoda-Device-Id / X-NodeCoda-Client on every request).

import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; };
const bad = (n, why) => { console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${why}`); fail++; };

const { loadDeviceId } = await import('./device-id.mjs');

console.log('device-id persistence (K-E3)');
{
  const dir = mkdtempSync(join(tmpdir(), 'nc-device-'));
  const env = { NODECODA_DEVICE_DIR: join(dir, '.nodecoda') };
  const id1 = loadDeviceId(env);
  const id2 = loadDeviceId(env);
  if (id1 === id2 && /^nodecoda-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id1)) {
    ok(`generates stable UUIDv4 device id (${id1.slice(0, 18)}…)`);
  } else {
    bad('stable UUIDv4', `id1=${id1} id2=${id2}`);
  }
  const file = join(dir, '.nodecoda', 'device.json');
  const mode = statSync(file).mode & 0o777;
  if (mode === 0o600) ok('device.json mode 0600');
  else bad('device.json mode 0600', `got ${mode.toString(8)}`);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed.device_id === id1 && parsed.created_at) ok('persisted {device_id, created_at}');
  else bad('persisted payload', JSON.stringify(parsed));
  // env override wins (tests/CI)
  if (loadDeviceId({ NODECODA_DEVICE_ID: 'ci-device-1' }) === 'ci-device-1') ok('NODECODA_DEVICE_ID override');
  else bad('NODECODA_DEVICE_ID override', 'override ignored');
  rmSync(dir, { recursive: true, force: true });
}

console.log('guest identity headers (K-E2)');
{
  const captured = [];
  const srv = createServer((req, res) => {
    captured.push({
      auth: req.headers.authorization ?? null,
      dev: req.headers['x-nodecoda-device-id'] ?? null,
      client: req.headers['x-nodecoda-client'] ?? null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, message: 'ok', data: { ok: true } }));
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  process.env.NODECODA_MCP_BASE = `http://127.0.0.1:${port}`;
  delete process.env.NODECODA_KEY;

  const { handleMcpMessage } = await import(`./mcp-core.mjs?${Date.now()}`);
  const msg = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'build_dify_workflow', arguments: {
      source: 'node {}', source_filename: 'a.ncoda', language_identity: 'nodecoda/1',
      target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'k1' } },
  };
  await handleMcpMessage(msg); // upstream stub returns 200; result may be a poll shape
  await sleep(150);
  srv.close();

  const c = captured[0];
  if (!c) { bad('captured request', 'no upstream request seen'); }
  else {
    if (c.auth === 'Bearer sk-try-placeholder') ok('missing key -> guest placeholder bearer');
    else bad('missing key -> placeholder', `got ${c.auth}`);
    if (c.dev?.startsWith('nodecoda-')) ok('X-NodeCoda-Device-Id attached');
    else bad('X-NodeCoda-Device-Id', `got ${c.dev}`);
    if (/^nodecoda-skill\/\d+\.\d+\.\d+$/.test(c.client ?? '')) ok(`X-NodeCoda-Client attached (${c.client})`);
    else bad('X-NodeCoda-Client', `got ${c.client}`);
  }
}

console.log(`\n${fail === 0 ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
