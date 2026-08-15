#!/usr/bin/env node
// scripts/test-http-server.mjs
// Transport tests for scripts/mcp-http-server.mjs (Streamable HTTP MCP).
// Runs against a local upstream REST stub — no network, no external deps.
//
// Asserts: initialize / tools.list / tools.call (GET + POST), bearer
// pass-through to upstream, 401 without auth, CORS preflight, SSE channel,
// 405 DELETE, 406 GET without SSE Accept, parse-error 400, unknown tool.

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpstreamBase } from './mcp-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ${'\x1b[32m✓\x1b[0m'} ${n}`); pass++; };
const bad = (n, why) => { console.log(`  ${'\x1b[31m✗\x1b[0m'} ${n}\n      ${why}`); fail++; };

// ---- mcp-core upstream base resolution (regression) -----------------------
// The gateway surface that accepts sk-... keys is /v1, NOT /api/v1 (the
// admin base returns 401 INVALID_TOKEN for opaque keys). Guard the default
// and the override order.

console.log('mcp-core upstream base regression');
{
  const cases = [
    ['defaults to MCP gateway /v1', {}, 'https://www.nodecoda.com/v1'],
    ['NODECODA_MCP_BASE wins', { NODECODA_MCP_BASE: 'http://mcp.local:8000', NODECODA_API_BASE: 'http://admin.local' }, 'http://mcp.local:8000'],
    ['NODECODA_API_BASE used as legacy alias', { NODECODA_API_BASE: 'http://legacy.local/v1/' }, 'http://legacy.local/v1'],
    ['single trailing slash stripped', { NODECODA_MCP_BASE: 'https://example.com/v1/' }, 'https://example.com/v1'],
  ];
  for (const [name, env, expected] of cases) {
    const got = resolveUpstreamBase(env);
    if (got === expected) ok(name);
    else bad(name, `expected ${expected}, got ${got}`);
  }
}
console.log('http MCP server tests');

// ---- local upstream REST stub ------------------------------------------

const seenAuth = [];
// seenBuildPosts: every idempotency_key the stub has admitted (throttle retry
// replays the same key, so the count proves bounded-retry behaviour).
const seenBuildPosts = [];
// Mimic the live gateway: responses are wrapped in { code, message, data },
// and SUCCEEDED polls carry artifact *metadata* only — the raw content lives
// behind GET /workflow-builds/{id}/artifact.
const wrap = (obj) => ({ code: 0, message: 'success', data: obj });
const GUEST_QUOTA = { mode: 'on', success: 50, success_used: 3, diagnostic: 29.7, resets_in_seconds: 86399, register_hint: false };
const stub = createServer((req, res) => {
  seenAuth.push(req.headers.authorization ?? null);
  if (req.method === 'POST' && req.url?.startsWith('/workflow-builds')) {
    // Guest structured admission states, keyed by idempotency_key prefix:
    //   throttle-then-ok-*  -> throttled x2, then queued (auto-retry proves replay)
    //   throttle-always-*   -> throttled forever (bounded retries exhausted)
    //   exhausted-*         -> device daily soft stop (never retried)
    //   anything else       -> queued with quota block (pacing + low-key used count)
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let idem = null;
      try { idem = JSON.parse(body)?.idempotency_key ?? null; } catch { idem = null; }
      seenBuildPosts.push(idem ?? '<no-key>');
      const send = (obj, status = 202) => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(status);
        res.end(JSON.stringify(wrap(obj)));
      };
      if (typeof idem === 'string' && idem.startsWith('throttle-then-ok-')) {
        const n = seenBuildPosts.filter((k) => k === idem).length;
        if (n <= 2) {
          send({ status: 'throttled', reason: 'device_rate', retry_after_ms: 30, quota: GUEST_QUOTA });
        } else {
          send({ build_id: `build_${idem}`, status: 'QUEUED', poll_after_ms: 10, quota: GUEST_QUOTA });
        }
        return;
      }
      if (typeof idem === 'string' && idem.startsWith('throttle-always-')) {
        send({ status: 'throttled', reason: 'ip_quota', retry_after_ms: 20, quota: GUEST_QUOTA });
        return;
      }
      if (typeof idem === 'string' && idem.startsWith('exhausted-')) {
        send({
          status: 'exhausted',
          code: 'GUEST_QUOTA_EXHAUSTED',
          message: '今天的免费构建额度已用完，明天自动重置。免费服务器资源有限，注册可享专属服务器。',
          quota: { ...GUEST_QUOTA, success_used: 50, register_hint: true },
        });
        return;
      }
      send({ build_id: 'build_stub', status: 'QUEUED', poll_after_ms: 10, quota: GUEST_QUOTA });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/workflow-builds/build_stub') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(wrap({
      build_id: 'build_stub',
      status: 'SUCCEEDED',
      artifact_sha256: 'abc123',
      artifact_size: 12,
      artifact_media_type: 'application/yaml',
      artifact_available: true,
    })));
    return;
  }
  if (req.method === 'GET' && req.url === '/workflow-builds/build_stub/artifact') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.writeHead(200);
    res.end('name: hello\n');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;

// ---- spawn the MCP HTTP server on an ephemeral port ---------------------

const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts/mcp-http-server.mjs'), '--port', '0'], {
  env: { ...process.env, NODECODA_MCP_TRANSPORT: 'rest', NODECODA_API_BASE: `http://127.0.0.1:${stubPort}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
child.stdout.on('data', (b) => { out += b.toString('utf8'); });

let mcpPort = null;
const deadline = Date.now() + 5000;
while (!mcpPort && Date.now() < deadline) {
  const m = /ready:\s+http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(out);
  if (m) mcpPort = Number(m[1]);
  if (!mcpPort) await sleep(50);
}
if (!mcpPort) {
  console.error('MCP server did not report a listening port:\n' + out);
  process.exit(2);
}

// ---- tiny HTTP client ---------------------------------------------------

function httpReq(method, path, { headers = {}, body, onFirstData, port = mcpPort } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data, 'utf8') } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => {
        out += c.toString('utf8');
        if (onFirstData) {
          resolve(onFirstData({ status: res.statusCode, headers: res.headers, body: out }));
          req.destroy();
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const AUTH = { Authorization: 'Bearer sk-test-key' };
const BASE = `http://127.0.0.1:${mcpPort}/mcp`;

// ---- tests --------------------------------------------------------------

console.log('http MCP server tests');

// 1. initialize
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '0' } } },
  });
  const p = JSON.parse(r.body);
  if (r.status === 200 && p?.result?.serverInfo?.name?.includes('nodecoda')) ok('POST initialize reports NodeCoda server');
  else bad('POST initialize', `status=${r.status} body=${r.body.slice(0, 200)}`);
}

// 2. tools/list
{
  const r = await httpReq('POST', '/mcp', { headers: AUTH, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
  const p = JSON.parse(r.body);
  const names = (p?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ['build_dify_workflow', 'cancel_workflow_build', 'get_workflow_build'];
  if (r.status === 200 && JSON.stringify(names) === JSON.stringify(expected)) ok('tools/list exposes the 3 manifest tools');
  else bad('tools/list', `got ${JSON.stringify(names)} status=${r.status}`);
}

// 3. tools/call get_workflow_build (bearer pass-through to upstream)
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workflow_build', arguments: { build_id: 'build_stub' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const upstreamSawBearer = seenAuth.some((a) => a === 'Bearer sk-test-key');
  // Envelope must be unwrapped (no "code" wrapper) and the raw artifact must
  // be attached as artifact.content (best-effort download from the stub).
  const hasArtifactContent = text.includes('"content": "name: hello\\n"') || text.includes('name: hello');
  const unwrapped = !text.includes('"code"');
  if (r.status === 200 && text.includes('SUCCEEDED') && upstreamSawBearer && unwrapped && hasArtifactContent && text.includes('abc123')) {
    ok('tools/call unwraps gateway envelope and attaches artifact.content');
  } else {
    bad('tools/call get', `status=${r.status} upstreamAuth=${JSON.stringify(seenAuth)} unwrapped=${unwrapped} body=${r.body.slice(0, 300)}`);
  }
}

// 4. tools/call build_dify_workflow (POST to upstream)
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: '@language nodecoda/1', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'k' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  if (r.status === 200 && text.includes('QUEUED') && !text.includes('"code"')) ok('tools/call build submits to upstream (envelope unwrapped)');
  else bad('tools/call build', `status=${r.status} body=${r.body.slice(0, 200)}`);
}

// 5. unknown tool -> -32601
{
  const r = await httpReq('POST', '/mcp', { headers: AUTH, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } } });
  const p = JSON.parse(r.body);
  if (r.status === 200 && p?.error?.code === -32601) ok('unknown tool returns -32601');
  else bad('unknown tool', `status=${r.status} body=${r.body.slice(0, 200)}`);
}

// 6. no auth -> 401 JSON-RPC error
{
  const r = await httpReq('POST', '/mcp', { body: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} } });
  const p = JSON.parse(r.body);
  if (r.status === 401 && p?.error?.code === -32001) ok('missing auth rejected with 401 JSON-RPC error');
  else bad('no auth', `status=${r.status} body=${r.body.slice(0, 200)}`);
}

// 7. bad JSON -> 400 parse error
{
  const r = await httpReq('POST', '/mcp', { headers: AUTH, body: '{not json' });
  const p = JSON.parse(r.body);
  if (r.status === 400 && p?.error?.code === -32700) ok('malformed JSON -> 400 parse error');
  else bad('bad JSON', `status=${r.status} body=${r.body.slice(0, 200)}`);
}

// 8. CORS preflight
{
  const r = await httpReq('OPTIONS', '/mcp', { headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } });
  if (r.status === 204 && r.headers['access-control-allow-origin'] === '*') ok('OPTIONS preflight returns CORS headers');
  else bad('OPTIONS', `status=${r.status} allow-origin=${r.headers['access-control-allow-origin']}`);
}

// 9. DELETE -> 405
{
  const r = await httpReq('DELETE', '/mcp', { headers: AUTH });
  if (r.status === 405) ok('DELETE returns 405 (stateless)');
  else bad('DELETE', `status=${r.status}`);
}

// 10. GET SSE channel
{
  const r = await httpReq('GET', '/mcp', {
    headers: { Accept: 'text/event-stream', ...AUTH },
    onFirstData: (first) => first, // resolve as soon as the stream starts
  });
  if (r.status === 200 && (r.headers['content-type'] ?? '').includes('text/event-stream')) ok('GET returns SSE channel');
  else bad('GET SSE', `status=${r.status} content-type=${r.headers['content-type']}`);
}

// 11. GET without SSE Accept -> 406
{
  const r = await httpReq('GET', '/mcp', { headers: AUTH });
  if (r.status === 406) ok('GET without SSE Accept -> 406');
  else bad('GET plain', `status=${r.status}`);
}

// 12. notification -> 202 no body
{
  const r = await httpReq('POST', '/mcp', { headers: AUTH, body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} } });
  if (r.status === 202 && r.body === '') ok('notification acknowledged with 202 empty body');
  else bad('notification', `status=${r.status} body=${r.body.slice(0, 100)}`);
}

// 13. cli.mjs `mcp --http` wiring (npx zero-install path, HTTP transport)
{
  const cli = spawn(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'mcp', '--http', '--port', '0'], {
    env: { ...process.env, NODECODA_MCP_TRANSPORT: 'rest', NODECODA_API_BASE: `http://127.0.0.1:${stubPort}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let cliOut = '';
  cli.stdout.on('data', (b) => { cliOut += b.toString('utf8'); });
  let cliPort = null;
  const cliDeadline = Date.now() + 5000;
  while (!cliPort && Date.now() < cliDeadline) {
    const m = /ready:\s+http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(cliOut);
    if (m) cliPort = Number(m[1]);
    if (!cliPort) await sleep(50);
  }
  if (!cliPort) {
    bad('cli mcp --http serves MCP', `no port reported:\n${cliOut.slice(0, 300)}`);
  } else {
    const r = await httpReq('POST', '/mcp', {
      port: cliPort,
      headers: AUTH,
      body: { jsonrpc: '2.0', id: 13, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cli-http-test', version: '0' } } },
    });
    const p = JSON.parse(r.body);
    if (r.status === 200 && p?.result?.serverInfo?.name?.includes('nodecoda')) ok('cli mcp --http serves MCP over Streamable HTTP');
    else bad('cli mcp --http serves MCP', `status=${r.status} body=${r.body.slice(0, 200)}`);
  }
  cli.kill();
}

// 14. guest throttled admission -> auto backoff retry (same key) -> queued
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'throttle-then-ok-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const posts = seenBuildPosts.filter((k) => k === 'throttle-then-ok-1').length;
  if (r.status === 200 && text.includes('QUEUED') && posts === 3) ok('throttled admission auto-retries (3 submits, same key) then succeeds');
  else bad('throttle retry then ok', `status=${r.status} posts=${posts} text=${text.slice(0, 200)}`);
}

// 15. persistent throttled -> bounded retries exhausted -> _client_retries annotation
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'throttle-always-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const posts = seenBuildPosts.filter((k) => k === 'throttle-always-1').length;
  if (r.status === 200 && text.includes('throttled') && text.includes('"reason": "ip_quota"') && text.includes('_client_retries') && posts === 4) {
    ok('persistent throttled bounded at 3 retries (4 submits) with _client_retries');
  } else {
    bad('throttle bounded retries', `status=${r.status} posts=${posts} text=${text.slice(0, 220)}`);
  }
}

// 16. exhausted soft stop -> pass through untouched, never retried
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'exhausted-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const posts = seenBuildPosts.filter((k) => k === 'exhausted-1').length;
  if (r.status === 200 && text.includes('GUEST_QUOTA_EXHAUSTED') && text.includes('明天自动重置') && text.includes('register_hint') && posts === 1) {
    ok('exhausted soft stop passes through with message + quota, no retry');
  } else {
    bad('exhausted pass-through', `status=${r.status} posts=${posts} text=${text.slice(0, 220)}`);
  }
}

// 17. queued admission carries quota block (used-count) + poll_after_ms pacing
{
  const r = await httpReq('POST', '/mcp', {
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'quota-ok-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  if (r.status === 200 && text.includes('"status": "QUEUED"') && text.includes('success_used') && text.includes('poll_after_ms') && text.includes('register_hint')) {
    ok('queued admission passes quota block + poll_after_ms through');
  } else {
    bad('queued quota passthrough', `status=${r.status} text=${text.slice(0, 220)}`);
  }
}

// ===========================================================================
// Guest JSON-RPC transport tests (try /mcp behaviour, local stub)
// ===========================================================================
console.log('jsonrpc guest transport tests (try /mcp)');

// Sessionful Streamable-HTTP MCP stub: initialize issues Mcp-Session-Id,
// notifications/initialized is a 202, tools/call answers with SSE frames and
// double-encoded tool results (text = inner JSON). Lowercase statuses like the
// real try gateway; poll normalization is asserted on the client side.
const jrAuth = [];
const jrDevice = [];
const jrBuildPosts = [];
const jrStub = createServer((req, res) => {
  jrAuth.push(req.headers.authorization ?? null);
  jrDevice.push(req.headers['x-nodecoda-device-id'] ?? null);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg = null;
    try { msg = JSON.parse(body); } catch { msg = null; }
    const sse = (obj, status = 200) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.writeHead(status);
      res.end(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
    };
    if (!msg) { res.writeHead(400); res.end('{}'); return; }
    if (msg.method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'sess-1');
      sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'NodeCoda MCP', version: 'stub' } } });
      return;
    }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(''); return; }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const idem = args.idempotency_key ?? '';
      if (name === 'build_dify_workflow') {
        jrBuildPosts.push(idem);
        const quota = { mode: 'on', success: 50, success_used: 0, diagnostic: 30, resets_in_seconds: 86400, register_hint: false };
        if (idem.startsWith('throttle-then-ok-')) {
          const n = jrBuildPosts.filter((k) => k === idem).length;
          if (n <= 1) sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'throttled', reason: 'device_rate', retry_after_ms: 30, quota }) }] } });
          else sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ build_id: `job_${idem}`, status: 'queued', poll_after_ms: 500, quota }) }] } });
          return;
        }
        if (idem.startsWith('exhausted-')) {
          sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'exhausted', code: 'GUEST_QUOTA_EXHAUSTED', message: '今天的免费构建额度已用完，明天自动重置。', quota: { ...quota, success_used: 50, register_hint: true } }) }] } });
          return;
        }
        sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ build_id: `job_${idem}`, status: 'queued', poll_after_ms: 500, quota }) }] } });
        return;
      }
      if (name === 'get_workflow_build') {
        sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ build_id: args.build_id, status: 'succeeded', artifact: { media_type: 'application/yaml', sha256: 'abc123', content: 'app:\n  mode: workflow\nkind: app\n' } }) }] } });
        return;
      }
      sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool \"${name}\"` } });
      return;
    }
    sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } });
  });
});
await new Promise((r) => jrStub.listen(0, '127.0.0.1', r));
const jrPort = jrStub.address().port;

const jrChild = spawn(process.execPath, [join(REPO_ROOT, 'scripts/mcp-http-server.mjs'), '--port', '0'], {
  // Guest mode: no NODECODA_KEY, explicit JSONRPC URL against the local stub.
  env: { ...process.env, NODECODA_MCP_JSONRPC_URL: `http://127.0.0.1:${jrPort}/mcp` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let jrOut = '';
jrChild.stdout.on('data', (b) => { jrOut += b.toString('utf8'); });
let jrMcpPort = null;
const jrDeadline = Date.now() + 5000;
while (!jrMcpPort && Date.now() < jrDeadline) {
  const m = /ready:\s+http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(jrOut);
  if (m) jrMcpPort = Number(m[1]);
  if (!jrMcpPort) await sleep(50);
}
if (!jrMcpPort) {
  console.error('JSON-RPC MCP server did not report a port:\n' + jrOut);
  process.exit(2);
}

// 18. guest admission: JSON-RPC session + queued + quota (lowercase kept)
{
  const r = await httpReq('POST', '/mcp', {
    port: jrMcpPort,
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'guest-ok-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const deviceOk = jrDevice.some((d) => typeof d === 'string' && d.startsWith('nodecoda-'));
  if (r.status === 200 && text.includes('"status": "queued"') && text.includes('success_used') && text.includes('poll_after_ms') && deviceOk) {
    ok('guest build via JSON-RPC /mcp returns queued + quota + device header');
  } else {
    bad('guest JSON-RPC build', `status=${r.status} deviceOk=${deviceOk} text=${text.slice(0, 220)}`);
  }
}

// 18b. anonymous guest (no bearer, zero-config) admitted via JSON-RPC /mcp
{
  const r = await httpReq('POST', '/mcp', {
    port: jrMcpPort,
    body: { jsonrpc: '2.0', id: 180, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'anon-guest-1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  if (r.status === 200 && text.includes('"status": "queued"')) ok('anonymous guest (no key, no bearer) admitted via JSON-RPC /mcp');
  else bad('anonymous guest admission', `status=${r.status} text=${text.slice(0, 200)}`);
}

// 19. guest throttled -> auto backoff retry -> queued
{
  const r = await httpReq('POST', '/mcp', {
    port: jrMcpPort,
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'throttle-then-ok-g1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const posts = jrBuildPosts.filter((k) => k === 'throttle-then-ok-g1').length;
  if (r.status === 200 && text.includes('"status": "queued"') && posts === 2) ok('jsonrpc throttled admission auto-retries (2 submits) then succeeds');
  else bad('jsonrpc throttle retry', `status=${r.status} posts=${posts} text=${text.slice(0, 220)}`);
}

// 20. guest exhausted soft stop -> pass through, never retried
{
  const r = await httpReq('POST', '/mcp', {
    port: jrMcpPort,
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'build_dify_workflow', arguments: { source: 'x', source_filename: 'x.ncoda', language_identity: 'nodecoda/1', target_profile: 'dify-1.16-graphon-0.6', idempotency_key: 'exhausted-g1' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  const posts = jrBuildPosts.filter((k) => k === 'exhausted-g1').length;
  if (r.status === 200 && text.includes('GUEST_QUOTA_EXHAUSTED') && text.includes('register_hint') && posts === 1) ok('jsonrpc exhausted soft stop passes through, no retry');
  else bad('jsonrpc exhausted', `status=${r.status} posts=${posts} text=${text.slice(0, 220)}`);
}

// 21. poll status normalization: lowercase succeeded -> SUCCEEDED + inline artifact
{
  const r = await httpReq('POST', '/mcp', {
    port: jrMcpPort,
    headers: AUTH,
    body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_workflow_build', arguments: { build_id: 'job_x' } } },
  });
  const p = JSON.parse(r.body);
  const text = p?.result?.content?.[0]?.text ?? '';
  if (r.status === 200 && text.includes('"status": "SUCCEEDED"') && text.includes('"content": "app:\\n  mode: workflow')) {
    ok('jsonrpc poll normalizes succeeded -> SUCCEEDED, artifact inline');
  } else {
    bad('jsonrpc poll normalize', `status=${r.status} text=${text.slice(0, 240)}`);
  }
}

jrChild.kill();
jrStub.close();

// ---- cleanup ------------------------------------------------------------

child.kill();
stub.close();
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${fail === 0 ? 'OK' : 'FAIL'}\x1b[0m   ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
