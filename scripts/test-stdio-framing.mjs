#!/usr/bin/env node
// scripts/test-stdio-framing.mjs
// Pure-Node unit tests for the stdio framing layer (parseFrame / frameMessage
// in scripts/mcp-stdio-server.mjs). No deps, no network, no child processes.
//
// Guards the Layer-2 zero-install path and the newline-delimited JSON fallback
// regression: parseFrame used to return null before reaching the fallback
// whenever no CRLFCRLF header block was present (dead code), and the partial-
// header guard must never consume a buffered "Content-Length:" line as JSON.

import { parseFrame, frameMessage } from './mcp-stdio-server.mjs';

let pass = 0, fail = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
function bad(name, why) { console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${why}`); fail++; }

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const restStr = (r) => (Buffer.isBuffer(r) ? r.toString('utf8') : String(r ?? ''));

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'framing-test', version: '0' } } };
const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

// ---- 1. Content-Length framed message parses ----
{
  const buf = Buffer.from(frameMessage(init));
  const f = parseFrame(buf);
  if (f && eq(f.message, init) && f.rest.length === 0) ok('framed message parses (frameMessage round-trip)');
  else bad('framed message parses', `got ${JSON.stringify(f?.message)} rest=${restStr(f?.rest).length}`);
}

// ---- 2. framed message + trailing bare JSON line in one buffer ----
{
  const buf = Buffer.from(frameMessage(init) + JSON.stringify(tools) + '\n');
  const f1 = parseFrame(buf);
  const f2 = f1 ? parseFrame(f1.rest) : null;
  if (f1 && eq(f1.message, init) && f2 && eq(f2.message, tools) && f2.rest.length === 0) {
    ok('framed + bare newline message in one buffer parse sequentially');
  } else bad('framed + bare newline message in one buffer parse sequentially',
    `f1=${JSON.stringify(f1?.message)} f2=${JSON.stringify(f2?.message)} rest=${restStr(f2?.rest)}`);
}

// ---- 3. bare newline-delimited JSON parses (regression: dead-code fallback) ----
{
  const buf = Buffer.from(JSON.stringify(init) + '\n');
  const f = parseFrame(buf);
  if (f && eq(f.message, init) && f.rest.length === 0) ok('bare newline JSON (no Content-Length) parses');
  else bad('bare newline JSON (no Content-Length) parses', `got ${JSON.stringify(f?.message)}`);
}

// ---- 4. bare newline JSON with CRLF line ending parses ----
{
  const buf = Buffer.from(JSON.stringify(init) + '\r\n');
  const f = parseFrame(buf);
  if (f && eq(f.message, init)) ok('bare newline JSON with CRLF ending parses');
  else bad('bare newline JSON with CRLF ending parses', `got ${JSON.stringify(f?.message)}`);
}

// ---- 5. multiple bare JSON lines in one buffer parse sequentially ----
{
  const buf = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' }) + '\n');
  const f1 = parseFrame(buf);
  const f2 = f1 ? parseFrame(f1.rest) : null;
  if (f1 && f1.message?.id === 1 && f2 && f2.message?.id === 2 && f2.rest.length === 0) {
    ok('two bare JSON lines in one buffer parse sequentially');
  } else bad('two bare JSON lines in one buffer parse sequentially',
    `f1=${JSON.stringify(f1?.message?.id)} f2=${JSON.stringify(f2?.message?.id)}`);
}

// ---- 6. partial Content-Length header line waits (guard: not eaten as JSON) ----
{
  const part = Buffer.from('Content-Length: 100\n');
  const f = parseFrame(part);
  if (f === null) ok('partial header line (no CRLFCRLF) waits for more data');
  else bad('partial header line (no CRLFCRLF) waits for more data', `parsed ${JSON.stringify(f?.message)}`);
}
{
  const head = 'Content-Length: ' + Buffer.byteLength(JSON.stringify(init), 'utf8') + '\r\n\r\n' + JSON.stringify(init);
  const buf1 = Buffer.from(head.slice(0, 20));            // header arrives in chunks
  const f1 = parseFrame(buf1);
  const buf2 = Buffer.concat([buf1, Buffer.from(head.slice(20))]);
  const f2 = parseFrame(buf2);
  if (f1 === null && f2 && eq(f2.message, init)) ok('chunked header + body completes via Content-Length path');
  else bad('chunked header + body completes via Content-Length path',
    `f1=${JSON.stringify(f1)} f2=${JSON.stringify(f2?.message)}`);
}

// ---- 7. incomplete framed body waits, completes when rest arrives ----
{
  const full = frameMessage(init);
  const buf1 = Buffer.from(full.slice(0, full.length - 6));
  const f1 = parseFrame(buf1);
  const buf2 = Buffer.concat([buf1, Buffer.from(full.slice(full.length - 6))]);
  const f2 = parseFrame(buf2);
  if (f1 === null && f2 && eq(f2.message, init)) ok('incomplete framed body waits then parses');
  else bad('incomplete framed body waits then parses', `f1=${JSON.stringify(f1)} f2=${JSON.stringify(f2?.message)}`);
}

// ---- 8. malformed JSON line is skipped, next line still parses ----
{
  const buf = Buffer.from('this is not json\n' + JSON.stringify(tools) + '\n');
  const f1 = parseFrame(buf);
  const f2 = f1 ? parseFrame(f1.rest) : null;
  if (f1 && f1.message === null && f2 && eq(f2.message, tools)) ok('malformed JSON line skipped, next line parses');
  else bad('malformed JSON line skipped, next line parses',
    `f1=${JSON.stringify(f1?.message)} f2=${JSON.stringify(f2?.message)}`);
}

// ---- 9. empty lines are skipped ----
{
  const buf = Buffer.from('\n\n' + JSON.stringify(tools) + '\n');
  const f1 = parseFrame(buf);
  const f2 = f1 ? parseFrame(f1.rest) : null;
  const f3 = f2 ? parseFrame(f2.rest) : null;
  if (f1 && f1.message === null && f2 && f2.message === null && f3 && eq(f3.message, tools)) {
    ok('blank lines skipped before a valid JSON line');
  } else bad('blank lines skipped before a valid JSON line',
    `f1=${JSON.stringify(f1?.message)} f2=${JSON.stringify(f2?.message)} f3=${JSON.stringify(f3?.message)}`);
}

// ---- 10. header block without Content-Length falls back to newline JSON ----
{
  const buf = Buffer.from('X-Ignored: 1\r\n\r\n' + JSON.stringify(tools) + '\n');
  const f = parseFrame(buf);
  if (f && eq(f.message, tools)) ok('header block without Content-Length falls back to newline JSON');
  else bad('header block without Content-Length falls back to newline JSON', `got ${JSON.stringify(f?.message)}`);
}

// ---- 11. partial JSON without terminator waits ----
{
  const f = parseFrame(Buffer.from('{"jsonrpc":"2.0","id":9'));
  if (f === null) ok('incomplete JSON line (no newline yet) waits');
  else bad('incomplete JSON line (no newline yet) waits', `parsed ${JSON.stringify(f?.message)}`);
}

console.log(`\nOK   ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
