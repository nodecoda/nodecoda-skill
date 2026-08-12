#!/usr/bin/env node
// scripts/live-mcp.mjs
// End-to-end NodeCoda Workflow Build against the public deployment.
// Walks the full chain documented in references/mcp-contract.md and
// references/public-service.md:
//   1. POST /api/v1/auth/login            email + password  -> JWT
//   2. POST /api/v1/keys                  Bearer JWT         -> sk-...
//   3. POST /api/v1/workflow-builds       Bearer sk-...      -> { build_id, status, poll_after_ms }
//   4. GET  /api/v1/workflow-builds/:id   poll until terminal -> artifact (Dify YAML)
//   5. writes artifacts/<build_id>.(yaml|json)
//
// If NODECODA_KEY is already set, step 1+2 are skipped.
// Note: the gateway wraps every response as { code, message, data: {...} } —
// live-mcp unwraps `data` before reading build fields.
// If creds are missing, exits 0 with a hint (so it stays runnable in CI).
//
// Usage:
//   NODECODA_EMAIL=... NODECODA_PASSWORD=... node scripts/live-mcp.mjs
//   NODECODA_KEY=sk-... node scripts/live-mcp.mjs                 # reuse key
//   node scripts/live-mcp.mjs --source <path>.ncoda               # use specific source
//   node scripts/live-mcp.mjs --target dify-1.16-graphon-0.6      # override target
//   node scripts/live-mcp.mjs --dry-run                           # stop after auth/key

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILL_EXAMPLES = join(REPO_ROOT, 'skills/nodecoda-workflow/examples');

// Two bases on www.nodecoda.com:
//   NODECODA_API_BASE  -> Workspace admin (login, keys)        default: https://www.nodecoda.com/api/v1
//   NODECODA_MCP_BASE  -> MCP gateway (build, poll, cancel)    default: https://www.nodecoda.com/v1
const API_BASE = (process.env.NODECODA_API_BASE || 'https://www.nodecoda.com/api/v1').replace(/\/$/, '');
const MCP_BASE = (process.env.NODECODA_MCP_BASE || process.env.NODECODA_API_BASE || 'https://www.nodecoda.com/v1').replace(/\/$/, '');
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = Number(process.env.NODECODA_POLL_TIMEOUT_MS ?? 180_000);

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
};

function log(stage, msg) {
  console.log(`${c.cyan}[${stage}]${c.reset} ${msg}`);
}
function ok(stage, msg) { console.log(`${c.green}[${stage}]${c.reset} ${msg}`); }
function warn(stage, msg) { console.warn(`${c.yellow}[${stage}]${c.reset} ${msg}`); }
function die(stage, msg, extra) {
  console.error(`${c.red}[${stage}]${c.reset} ${msg}`);
  if (extra) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

// ---- argv ----
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const SOURCE_PATH = arg('--source', join(SKILL_EXAMPLES, '01-hello-workflow.ncoda'));
const TARGET = arg('--target', 'dify-1.16-graphon-0.6');
const DRY_RUN = args.includes('--dry-run');

// ---- HTTP ----
async function req(path, { method = 'GET', body, headers = {} } = {}, base = API_BASE) {
  const h = { 'Accept': 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

const mcpReq = (path, opts = {}) => req(path, opts, MCP_BASE);

// The public gateway wraps all responses as { code, message, data: {...} }.
// Normalize to the inner payload so downstream code reads build_id/status
// directly (matches references/mcp-contract.md shapes).
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.data && body.code !== undefined) {
    return body.data;
  }
  return body;
}

// ---- chain ----
async function loginOrSkip() {
  if (process.env.NODECODA_KEY) {
    ok('auth', `using NODECODA_KEY from env (length=${process.env.NODECODA_KEY.length})`);
    return process.env.NODECODA_KEY;
  }
  const email = process.env.NODECODA_EMAIL;
  const password = process.env.NODECODA_PASSWORD;
  if (!email || !password) {
    warn('auth', 'NODECODA_EMAIL / NODECODA_PASSWORD not set');
    console.log(`       set them, or set NODECODA_KEY=sk-... to skip login`);
    console.log(`       ${c.dim}example: NODECODA_EMAIL=a@b.com NODECODA_PASSWORD=... node scripts/live-mcp.mjs${c.reset}`);
    process.exit(0);
  }
  log('auth', `POST /auth/login as ${email}`);
  const r = await req('/auth/login', { method: 'POST', body: { email, password } });
  if (!r.ok) die('auth', `login failed (HTTP ${r.status})`, r.body);
  const jwt = r.body?.access_token ?? r.body?.token ?? r.body?.data?.access_token;
  if (!jwt) die('auth', 'login response missing access_token', r.body);
  ok('auth', `got JWT (${jwt.length} chars)`);
  return jwt;
}

async function ensureKey(jwtOrKey) {
  if (process.env.NODECODA_KEY) return process.env.NODECODA_KEY;
  log('keys', 'POST /keys (create sk-...)');
  const r = await req('/keys', { method: 'POST', body: { name: 'live-mcp.mjs auto', scopes: ['workflow:build'] }, headers: { 'Authorization': `Bearer ${jwtOrKey}` } });
  if (!r.ok) die('keys', `create key failed (HTTP ${r.status})`, r.body);
  const sk = r.body?.key ?? r.body?.data?.key;
  if (!sk) die('keys', 'keys response missing key', r.body);
  ok('keys', `got API key (${sk.length} chars, prefix=${sk.slice(0, 5)}…)`);
  return sk;
}

async function submitBuild(key, source, filename) {
  const idempotency_key = `live-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  log('build', `POST /workflow-builds  file=${filename}  target=${TARGET}  idem=${idempotency_key.slice(0, 24)}…`);
  const r = await mcpReq('/workflow-builds', {
    method: 'POST',
    body: { source, source_filename: filename, language_identity: 'nodecoda/1', target_profile: TARGET, idempotency_key },
    headers: { 'Authorization': `Bearer ${key}`, 'Idempotency-Key': idempotency_key },
  });
  const body = unwrap(r.body);
  if (!r.ok) {
    // Special-case the L4 launch blocker so the user knows what to do next
    if (body?.reason === 'WORKFLOW_BUILD_SERVICE_UNAVAILABLE') {
      die('build', 'MCP gateway rejected the request', {
        ...body,
        hint: [
          "The public deployment's MCP gateway is rejecting opaque sk-... keys (401 token missing expiration).",
          'Known MCP gateway launch blocker: auth.RequireBearerToken middleware requires a JWT exp claim',
          'before reaching the introspect verifier, so opaque sk-... keys get 401 token missing expiration.',
          'Fix: call verifier.VerifyToken directly (bypass RequireBearerToken), rebuild the MCP image, redeploy, retry.',
          '/health 200 is NOT evidence the Build path is up — the MCP gateway can be live and still reject opaque keys.',
          'Do not edit .ncoda Source to chase this error.',
        ].join(' '),
      });
    }
    die('build', `submit failed (HTTP ${r.status})`, r.body);
  }
  ok('build', `admitted  build_id=${body?.build_id}  status=${body?.status}  poll_after_ms=${body?.poll_after_ms}`);
  return body;
}

async function pollBuild(key, buildId) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const r = await mcpReq(`/workflow-builds/${encodeURIComponent(buildId)}`, { headers: { 'Authorization': `Bearer ${key}` } });
    if (!r.ok) die('poll', `poll failed (HTTP ${r.status})`, r.body);
    last = unwrap(r.body);
    const status = last?.status ?? '?';
    log('poll', `t=${Math.round((Date.now() - start) / 1000)}s  status=${status}  build_id=${buildId}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) return last;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  warn('poll', `timeout after ${POLL_TIMEOUT_MS}ms — last status=${last?.status}`);
  return last;
}

async function saveArtifact(build, key) {
  const a = build?.artifact;
  // Live gateway shape: SUCCEEDED poll returns artifact *metadata* at the top
  // of `data` (artifact_sha256 / artifact_size / artifact_media_type /
  // artifact_available), and the raw content lives behind
  // GET /workflow-builds/{id}/artifact. Accept both shapes.
  const meta = a ?? build;
  const mediaType = meta?.media_type ?? meta?.artifact_media_type ?? 'application/octet-stream';
  const sha256 = a?.sha256 ?? meta?.artifact_sha256 ?? null;
  const available = a?.content !== undefined || a?.content_b64 !== undefined || meta?.artifact_available === true;
  if (!available) {
    warn('artifact', 'build did not return an artifact (no inline content and artifact_available != true)');
    return null;
  }
  const dir = join(REPO_ROOT, 'artifacts');
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const ext = mediaType.includes('yaml') ? 'yaml' : mediaType.includes('json') ? 'json' : 'bin';
  const file = join(dir, `${build.build_id}.${ext}`);
  let content;
  if (a?.content !== undefined) {
    content = a.content;
  } else if (a?.content_b64 !== undefined) {
    content = Buffer.from(a.content_b64, 'base64');
  } else {
    const dl = await mcpReq(`/workflow-builds/${encodeURIComponent(build.build_id)}/artifact`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!dl.ok) die('artifact', `download failed (HTTP ${dl.status})`, dl.body);
    content = dl.body;
  }
  await writeFile(file, content);
  ok('artifact', `saved  media_type=${mediaType}  sha256=${sha256}  → ${file}`);
  return file;
}

async function main() {
  console.log(`${c.bold}nodecoda live workflow build${c.reset}`);
  console.log(`  api:    ${API_BASE}`);
  console.log(`  source: ${SOURCE_PATH}`);
  console.log(`  target: ${TARGET}`);
  console.log('');

  if (!existsSync(SOURCE_PATH)) die('init', `source not found: ${SOURCE_PATH}`);
  const source = await readFile(SOURCE_PATH, 'utf8');
  const filename = basename(SOURCE_PATH);
  ok('init', `loaded source (${source.length} bytes) from ${SOURCE_PATH}`);

  const jwt = await loginOrSkip();
  const key = await ensureKey(jwt);
  if (DRY_RUN) {
    ok('done', `--dry-run: stopping after auth/key`);
    return;
  }

  const admitted = await submitBuild(key, source, filename);
  const final = await pollBuild(key, admitted.build_id);
  await saveArtifact(final, key);

  if (final?.status === 'SUCCEEDED') {
    console.log('');
    ok('done', `Build SUCCEEDED — artifact saved.`);
    process.exit(0);
  } else {
    console.log('');
    warn('done', `Build final status: ${final?.status}`);
    if (final?.diagnostics) {
      for (const d of final.diagnostics.slice(0, 5)) {
        console.log(`       ${c.red}${d.code}${c.reset} @ ${d.location?.line}:${d.location?.column}  ${d.message}`);
      }
    }
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(`${c.red}[fatal]${c.reset} ${e?.stack ?? e}`);
  process.exit(1);
});
