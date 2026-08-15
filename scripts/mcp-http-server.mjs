#!/usr/bin/env node
// scripts/mcp-http-server.mjs
// NodeCoda MCP server — Streamable HTTP transport.
//
// This is the deployable artifact for the public https://www.nodecoda.com/mcp
// endpoint (see docs/public-service.md "公网 MCP 直连"). Deploy it behind a
// reverse proxy that routes /mcp* to this process instead of the SPA
// catch-all.
//
// Implements the same three manifest tools as mcp-stdio-server.mjs via the
// shared dispatch in ./mcp-core.mjs (gateway envelopes unwrapped; SUCCEEDED
// artifacts fetched best-effort). Exports runHttpMcp() so cli.mjs
// (`nodecoda-skill mcp --http`) can serve in-process. Transport behavior (MCP Streamable HTTP):
//   - POST /mcp   : JSON-RPC 2.0 request  -> application/json response
//   - GET  /mcp   : text/event-stream channel (this server is session-less, so
//                   the stream only emits heartbeats; no server push)
//   - OPTIONS /mcp: CORS preflight
//   - DELETE /mcp : 405 (stateless — no server-side sessions to terminate)
//
// Auth: the client's `Authorization: Bearer <key>` header is passed through to
// the upstream Workspace REST API. If the header is absent and NODECODA_KEY is
// set in the environment (local dev), that key is used. If neither exists, the
// request is rejected with a 401 JSON-RPC error.
//
// Env:
//   PORT               listen port                 (default 4001; 0 = ephemeral)
//   HOST               listen host                 (default 127.0.0.1)
//   NODECODA_MCP_BASE  upstream MCP gateway base   (default https://www.nodecoda.com/v1)
//   NODECODA_API_BASE  legacy alias for NODECODA_MCP_BASE
//   NODECODA_KEY       fallback upstream key       (local dev; not required)
//
// Usage:
//   node scripts/mcp-http-server.mjs                  # 127.0.0.1:4001/mcp
//   node scripts/mcp-http-server.mjs --port 8080

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { handleMcpMessage, HttpError, PROTOCOL_VERSION, resolveUpstreamBase, upstreamMode } from './mcp-core.mjs';

const invokedAsMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  dim: useColor ? '\x1b[2m' : '',
};

// ---- argv ----
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const DEFAULT_PORT = 4001;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB source payloads
const SSE_KEEPALIVE_MS = 15_000;
const API_BASE = resolveUpstreamBase(); // single source of truth: mcp-core

// ---- helpers ------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, { code: 'PAYLOAD_TOO_LARGE', message: `request body exceeds ${MAX_BODY_BYTES} bytes` }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

function mcpErrorEnvelope(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8'), ...corsHeaders(), ...extraHeaders });
  res.end(body);
}

function sendSseChannel(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: disable buffering for SSE
    ...corsHeaders(),
  });
  res.write(': connected\r\n\r\n');
  const timer = setInterval(() => res.write(': keep-alive\r\n\r\n'), SSE_KEEPALIVE_MS);
  const cleanup = () => clearInterval(timer);
  res.on('close', cleanup);
  req.on('close', cleanup);
}

// ---- request handling ---------------------------------------------------

async function handlePost(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    sendJson(res, status, mcpErrorEnvelope(null, -32000, e?.message ?? String(e)));
    return;
  }

  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    sendJson(res, 400, mcpErrorEnvelope(null, -32700, 'Parse error: request body is not valid JSON'));
    return;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    sendJson(res, 400, mcpErrorEnvelope(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
    return;
  }

  const token = bearerToken(req) ?? process.env.NODECODA_KEY;
  // Guest (jsonrpc) mode mirrors the stdio server: anonymous requests are
  // allowed — the transport synthesizes the placeholder key and the try /mcp
  // gateway admits them as guest builds. REST mode keeps strict 401.
  if (!token && upstreamMode() !== 'jsonrpc') {
    sendJson(res, 401, mcpErrorEnvelope(msg.id, -32001, 'UNAUTHORIZED: send Authorization: Bearer <key>, or set NODECODA_KEY'));
    return;
  }

  try {
    const response = await handleMcpMessage(msg, { token });
    if (response === null) {
      // notification — acknowledge without a body
      res.writeHead(202, { ...corsHeaders(), 'MCP-Protocol-Version': PROTOCOL_VERSION });
      res.end();
      return;
    }
    sendJson(res, 200, response);
  } catch (e) {
    sendJson(res, 500, mcpErrorEnvelope(msg.id, -32000, e?.message ?? String(e)));
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const isMcpPath = url.pathname === '/mcp' || url.pathname === '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (!isMcpPath) {
    sendJson(res, 404, mcpErrorEnvelope(null, -32601, `Not found: ${url.pathname}`));
    return;
  }
  if (req.method === 'DELETE') {
    // stateless server — no session to terminate (MCP Streamable HTTP)
    sendJson(res, 405, mcpErrorEnvelope(null, -32601, 'Method DELETE not supported (server is stateless)'), { Allow: 'GET, POST, OPTIONS' });
    return;
  }
  if (req.method === 'GET') {
    const accept = req.headers.accept ?? '';
    if (accept.includes('text/event-stream')) {
      sendSseChannel(req, res);
      return;
    }
    sendJson(res, 406, mcpErrorEnvelope(null, -32601, 'GET requires Accept: text/event-stream'));
    return;
  }
  if (req.method === 'POST') {
    await handlePost(req, res);
    return;
  }
  sendJson(res, 405, mcpErrorEnvelope(null, -32601, `Method ${req.method} not supported`), { Allow: 'GET, POST, OPTIONS' });
});

// Starts the Streamable HTTP MCP server. Callable in-process from cli.mjs
// (`nodecoda-skill mcp --http`) or as the standalone script
// (`node scripts/mcp-http-server.mjs`). Returns the http.Server.
export function runHttpMcp({ port = Number(arg('--port', process.env.PORT ?? DEFAULT_PORT)), host = process.env.HOST ?? DEFAULT_HOST } = {}) {
  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`${c.green}[nodecoda-mcp]${c.reset} streamable-http server ready:  http://${host}:${actualPort}/mcp`);
    console.log(`  ${c.dim}upstream: ${API_BASE}${c.reset}`);
    console.log(`  ${c.dim}auth:     client Bearer token passed through; NODECODA_KEY env as fallback${c.reset}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  return server;
}

if (invokedAsMain) runHttpMcp();
