#!/usr/bin/env node
// scripts/mcp-stdio-server.mjs
// NodeCoda MCP stdio server — wraps the public NodeCoda deployment's REST
// Workflow Build surface as the three MCP tools declared in the skill
// manifest. Speaks MCP/JSON-RPC 2.0 over stdio (LSP-style Content-Length
// framing, with newline-delimited JSON accepted as a fallback for tooling
// that does not emit Content-Length).
//
// Tool definitions, upstream REST client, and JSON-RPC dispatch live in
// ./mcp-core.mjs (shared with mcp-http-server.mjs). This file only adds the
// stdio transport. Exports runStdioMcp() so cli.mjs (`nodecoda-skill mcp`)
// can serve in-process for the npx zero-install wiring.
//
// Env:
//   NODECODA_KEY          required at request time (not at startup, so the
//                         process can boot before the agent passes the key)
//   NODECODA_MCP_BASE     upstream MCP gateway base
//                         (default: https://www.nodecoda.com/v1)
//   NODECODA_API_BASE     legacy alias for NODECODA_MCP_BASE
//
// This is a thin adapter: it does NOT do any extra validation, transformation,
// or caching. Gateway { code, message, data } envelopes are unwrapped to the
// inner payload so tool results match references/mcp-contract.md shapes; for
// SUCCEEDED builds the raw artifact is fetched best-effort and attached as
// artifact.content. Source identity fields are passed through unchanged.

import { handleMcpMessage } from './mcp-core.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const invokedAsMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

// ---- JSON-RPC / MCP plumbing --------------------------------------------

async function handleMessage(msg) {
  return handleMcpMessage(msg);
}

// ---- stdio framing ------------------------------------------------------
// Read LSP-style Content-Length framed messages, with a fallback to
// newline-delimited JSON (some clients skip the header).

export function parseFrame(buffer) {
  // Returns { message, rest } or null if more data is needed.
  //
  // Fast path: a line that starts with '{' or '[' cannot be an LSP header
  // (headers are "Name: value"), so accept it as newline-delimited JSON even
  // when a \r\n\r\n block appears later in the same buffer (mixed-framing
  // streams: newline message + framed message written in one chunk).
  const nl = buffer.indexOf('\n');
  if (nl !== -1) {
    const first = buffer.slice(0, nl).toString('utf8').trim();
    if (first.startsWith('{') || first.startsWith('[')) {
      try { return { message: JSON.parse(first), rest: buffer.slice(nl + 1) }; }
      catch { return { message: null, rest: buffer.slice(nl + 1) }; }
    }
  }
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    // No complete Content-Length header block yet. Accept newline-delimited
    // JSON (one object per line) for tooling that skips LSP framing — but only
    // when the first line is JSON, not a partial header still being buffered
    // (e.g. "Content-Length: 123" arriving before its \r\n\r\n).
    const nl = buffer.indexOf('\n');
    if (nl === -1) return null;
    const line = buffer.slice(0, nl).toString('utf8').trim();
    if (/^[A-Za-z][A-Za-z0-9-]*\s*:/.test(line)) return null;
    if (!line) return { message: null, rest: buffer.slice(nl + 1) };
    try { return { message: JSON.parse(line), rest: buffer.slice(nl + 1) }; }
    catch { return { message: null, rest: buffer.slice(nl + 1) }; }
  }
  const header = buffer.slice(0, headerEnd).toString('ascii');
  let contentLength = null;
  for (const line of header.split('\r\n')) {
    const m = /^Content-Length:\s*(\d+)/i.exec(line);
    if (m) contentLength = parseInt(m[1], 10);
  }
  if (contentLength === null) {
    // try newline-delimited: take one line
    const nl = buffer.indexOf('\n', headerEnd + 4);
    if (nl === -1) return null;
    const line = buffer.slice(headerEnd + 4, nl).toString('utf8').trim();
    if (!line) return { message: null, rest: buffer.slice(nl + 1) };
    try { return { message: JSON.parse(line), rest: buffer.slice(nl + 1) }; }
    catch { return { message: null, rest: buffer.slice(nl + 1) }; }
  }
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + contentLength) return null;
  const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
  const rest = buffer.slice(bodyStart + contentLength);
  try { return { message: JSON.parse(body), rest }; }
  catch { return { message: null, rest }; }
}

export function frameMessage(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

// ---- main loop ----------------------------------------------------------

// Serves MCP over stdin/stdout until stdin closes. Callable in-process from
// cli.mjs (`nodecoda-skill mcp`, used by the npx zero-install wiring) or as
// the standalone script (`node scripts/mcp-stdio-server.mjs`).
export function runStdioMcp() {
  let buffer = Buffer.alloc(0);
  const input = process.stdin;
  const output = process.stdout;

  input.on('data', async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = parseFrame(buffer);
      if (!frame) return;
      buffer = frame.rest;
      if (!frame.message) continue;
      const response = await handleMessage(frame.message);
      if (response) output.write(frameMessage(response));
    }
  });

  input.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (invokedAsMain) runStdioMcp();
