#!/usr/bin/env node
// scripts/mcp-core.mjs
// Shared MCP protocol core for the NodeCoda MCP servers (stdio + HTTP).
// Owns the three manifest-declared tool definitions, the upstream REST
// client (NODECODA_API_BASE + bearer token), and JSON-RPC dispatch. The
// gateway wraps responses as { code, message, data: {...} }; tool results are
// normalized to the inner `data` payload (errors without `data` pass through
// unchanged). The two transports only add framing and IO:
//   - mcp-stdio-server.mjs  (Content-Length frames over stdin/stdout)
//   - mcp-http-server.mjs   (Streamable HTTP over /mcp)
//
// Pure Node 18+ built-ins, no dependencies.

// Two upstream transports, selected by config (see upstreamMode below):
//   - REST  : {base}/workflow-builds over plain HTTP. Used for key-authenticated
//             traffic against https://www.nodecoda.com/v1 (opaque sk-... keys)
//             or a self-hosted deployment. NODECODA_MCP_BASE / NODECODA_API_BASE
//             overrides exist for self-hosting.
//   - JSONRPC: Streamable-HTTP JSON-RPC against the deployment's /mcp endpoint
//             (sessionful, Mcp-Session-Id + SSE frames). The try free-experience
//             instance admits guests ONLY on /mcp with the placeholder key —
//             its /v1 REST surface strictly rejects it with 401 INVALID_API_KEY
//             (verified 2026-08-15), so no-key installs must use /mcp.
// With no NODECODA_KEY and no explicit JSONRPC URL the skill defaults to the
// public try /mcp (K-E1: zero-config guest free-experience).
export function resolveUpstreamBase(env = process.env) {
  return (env.NODECODA_MCP_BASE || env.NODECODA_API_BASE || 'https://www.nodecoda.com/v1').replace(/\/$/, '');
}
export function resolveJsonRpcUrl(env = process.env) {
  return (env.NODECODA_MCP_JSONRPC_URL || 'https://try.nodecoda.com/mcp').replace(/\/$/, '');
}
// Transport decision:
//   NODECODA_MCP_TRANSPORT=rest|jsonrpc  -> explicit pin (self-host / tests)
//   NODECODA_MCP_JSONRPC_URL set         -> JSONRPC (explicit operator intent)
//   NODECODA_KEY set                     -> REST (key-authenticated www/self-hosted)
//   otherwise                            -> JSONRPC (guest default: try /mcp)
export function upstreamMode(env = process.env) {
  if (env.NODECODA_MCP_TRANSPORT === 'rest' || env.NODECODA_MCP_TRANSPORT === 'jsonrpc') return env.NODECODA_MCP_TRANSPORT;
  if (env.NODECODA_MCP_JSONRPC_URL) return 'jsonrpc';
  if (env.NODECODA_KEY) return 'rest';
  return 'jsonrpc';
}
import { loadDeviceId } from './device-id.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = resolveUpstreamBase();

// K-E2: guest campaign placeholder key. When NODECODA_KEY is absent the skill
// still sends a well-formed bearer token; try.nodecoda.com's /mcp loose
// admission serves it as a guest build (S-B1), while www's /v1 REST surface
// (and try's /v1) strictly reject it with 401 INVALID_API_KEY.
const GUEST_PLACEHOLDER_KEY = 'sk-try-placeholder';
// X-NodeCoda-Client attribution header (S-B3): derived from package.json at
// runtime so it tracks the installed skill version without manual upkeep.
let _clientVersion = null;
function clientVersion() {
  if (_clientVersion) return _clientVersion;
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    _clientVersion = pkg.version || '0.0.0';
  } catch {
    _clientVersion = '0.0.0';
  }
  return _clientVersion;
}

export const PROTOCOL_VERSION = '2025-03-26';
export const SERVER_INFO = { name: 'nodecoda-workflow-mcp', version: '0.2.0' };

export const TOOLS = [
  {
    name: 'build_dify_workflow',
    description:
      'Submit a NodeCoda Source revision for a Workflow Build against the ' +
      'configured target profile. Returns a build_id, status, and poll_after_ms. ' +
      'Pass an idempotency_key that is unique per (source, target_profile) pair.',
    inputSchema: {
      type: 'object',
      required: ['source', 'source_filename', 'language_identity', 'target_profile', 'idempotency_key'],
      properties: {
        source:           { type: 'string', description: 'Full NodeCoda Source body' },
        source_filename:  { type: 'string', description: 'Filename, e.g. demo.ncoda' },
        language_identity:{ type: 'string', const: 'nodecoda/1' },
        target_profile:   { type: 'string', description: 'e.g. dify-1.16-graphon-0.6' },
        idempotency_key:  { type: 'string', description: 'Stable per (source, target) pair' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_workflow_build',
    description: 'Poll a previously-submitted Workflow Build by build_id. ' +
                 'Terminal states are SUCCEEDED, FAILED, CANCELLED. ' +
                 'On SUCCEEDED the response contains the artifact (media_type, sha256, content).',
    inputSchema: {
      type: 'object',
      required: ['build_id'],
      properties: { build_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_workflow_build',
    description: 'Cancel an in-flight Workflow Build. Cancellation is asynchronous; ' +
                 'poll until status is CANCELLED (terminal) or the cancellation deadline passes.',
    inputSchema: {
      type: 'object',
      required: ['build_id'],
      properties: { build_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

export class HttpError extends Error {
  constructor(status, body, headers) {
    super(`HTTP ${status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

// ---- HTTP layer ---------------------------------------------------------

async function apiFetch(path, { method = 'GET', body, headers = {}, token } = {}) {
  // K-E2: zero-branch key resolution — explicit token, else NODECODA_KEY,
  // else the guest placeholder. Never 401s client-side for a missing key:
  // try serves it as guest, www rejects with the server's own 401.
  const key = token ?? process.env.NODECODA_KEY ?? GUEST_PLACEHOLDER_KEY;
  const url = `${API_BASE}${path}`;
  const h = {
    'Authorization': `Bearer ${key}`,
    'Accept': 'application/json',
    // K-E2/K-E3: guest identity + attribution on every request. www ignores
    // these headers for key-authenticated traffic; try anchors guests on the
    // device id (server stores only sha256).
    'X-NodeCoda-Device-Id': loadDeviceId(),
    'X-NodeCoda-Client': `nodecoda-skill/${clientVersion()}`,
    ...headers,
  };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new HttpError(res.status, parsed, Object.fromEntries(res.headers));
  return parsed;
}

// ---- JSON-RPC upstream (try /mcp guest transport) -------------------------
// The deployment's Streamable-HTTP MCP endpoint is sessionful: initialize
// returns a Mcp-Session-Id response header that must be echoed on subsequent
// requests, and POST responses come back as SSE frames (`event: message` /
// `data: <jsonrpc>`). Tool results are double-encoded JSON: the inner payload
// lives in result.content[0].text. The try gateway uses lowercase statuses
// (queued / succeeded / ...) — poll responses are normalized to the documented
// uppercase contract (QUEUED / SUCCEEDED / FAILED / CANCELLED / ...) so agents
// following mcp-contract.md keep working; admission statuses (queued /
// throttled / exhausted) are left as-is per the guest contract.
const POLL_STATUS_ALIASES = {
  queued: 'QUEUED', building: 'BUILDING', cancelling: 'CANCELLING',
  succeeded: 'SUCCEEDED', failed: 'FAILED', cancelled: 'CANCELLED',
};

function normalizePollStatus(payload) {
  if (payload && typeof payload === 'object' && typeof payload.status === 'string') {
    const upper = POLL_STATUS_ALIASES[payload.status.toLowerCase()];
    if (upper) payload.status = upper;
  }
  return payload;
}

class JsonRpcUpstream {
  constructor(url) {
    this.url = url;
    this.session = null;
    this._sessionReady = null;
  }
  async ensureSession() {
    if (this._sessionReady) return this._sessionReady;
    this._sessionReady = (async () => {
      const body = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'nodecoda-skill', version: clientVersion() } },
      };
      const res = await fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
      if (!res.ok) throw new HttpError(res.status, await res.text(), Object.fromEntries(res.headers));
      this.session = res.headers.get('mcp-session-id');
      await this._post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      return this.session;
    })();
    return this._sessionReady;
  }
  _headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GUEST_PLACEHOLDER_KEY}`,
      'X-NodeCoda-Device-Id': loadDeviceId(),
      'X-NodeCoda-Client': `nodecoda-skill/${clientVersion()}`,
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
    };
  }
  async _post(body) {
    const res = await fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    const raw = await res.text();
    if (!res.ok) throw new HttpError(res.status, raw, Object.fromEntries(res.headers));
    const msgs = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try { msgs.push(JSON.parse(line.slice(6))); } catch { /* keep-alive / non-JSON frame */ }
      }
    }
    if (msgs.length === 0) {
      // Some gateways answer application/json directly instead of SSE.
      try { msgs.push(JSON.parse(raw)); } catch { /* not JSON either */ }
    }
    return msgs;
  }
  async call(name, args) {
    await this.ensureSession();
    const msgs = await this._post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const last = [...msgs].reverse().find((m) => m && (m.id === 2 || m.result || m.error));
    if (!last) throw new Error(`MCP gateway returned no response for ${name}`);
    if (last.error) return { error: last.error, message: last.error?.message ?? String(last.error.code ?? '') };
    const text = last.result?.content?.[0]?.text;
    if (typeof text === 'string') {
      try { return JSON.parse(text); } catch { return { content: text }; }
    }
    return last.result ?? {};
  }
}

// ---- guest throttle retry -------------------------------------------------
// try.nodecoda.com's guest admission is progressive: when the device/IP has
// crossed its rate tier the gateway answers HTTP 200 with a structured
// { status: "throttled", reason, retry_after_ms, quota } payload instead of a
// hard error (nodecoda-guest-rate-limit-model.md §6). A throttled admission
// never created a build, so the client sleeps retry_after_ms and replays the
// SAME submission (same idempotency key). Bounded retries; if the throttle
// persists the final payload is passed through with a client-side
// `_client_retries` annotation so the agent can tell first-throttle from
// retries-exhausted. `exhausted` (device daily soft stop) is a product state,
// NOT a failure — it is never retried and passes through untouched.
export const MAX_THROTTLE_RETRIES = 3;
export const DEFAULT_RETRY_AFTER_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function submitWithThrottleRetry(submit, { maxRetries = MAX_THROTTLE_RETRIES } = {}) {
  let retries = 0;
  for (;;) {
    const data = await submit();
    if (data?.status !== 'throttled') return data;
    if (retries >= maxRetries) {
      return { ...data, _client_retries: retries };
    }
    const waitMs = Number.isFinite(Number(data.retry_after_ms)) && Number(data.retry_after_ms) > 0
      ? Number(data.retry_after_ms)
      : DEFAULT_RETRY_AFTER_MS;
    await sleep(waitMs);
    retries += 1;
  }
}

// ---- tool dispatch ------------------------------------------------------

// Gateway envelope normalization: { code, message, data: {...} } -> data.
// Error bodies like { code: "INVALID_TOKEN", message: "..." } have no `data`
// key and pass through unchanged.
function unwrap(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && body.data !== undefined) {
    return body.data;
  }
  return body;
}

// Transport instance selection (module load, mirrors existing API_BASE style).
const MODE = upstreamMode();
const upstream = MODE === 'jsonrpc' ? new JsonRpcUpstream(resolveJsonRpcUrl()) : null;

const TOOL_HANDLERS = {
  // Per references/mcp-contract.md: same idempotency_key in the body AND the
  // Idempotency-Key header. We forward both for safety (REST mode).
  build_dify_workflow: async (args, token) => {
    return submitWithThrottleRetry(async () => {
      if (upstream) return upstream.call('build_dify_workflow', args);
      const data = await apiFetch('/workflow-builds', {
        method: 'POST',
        body: args,
        headers: { 'Idempotency-Key': args.idempotency_key },
        token,
      });
      return unwrap(data);
    });
  },
  get_workflow_build: async (args, token) => {
    if (upstream) {
      // try /mcp returns the artifact content inline and lowercase statuses;
      // normalize poll statuses to the documented uppercase contract.
      return normalizePollStatus(await upstream.call('get_workflow_build', args));
    }
    const data = await apiFetch(`/workflow-builds/${encodeURIComponent(args.build_id)}`, { method: 'GET', token });
    const b = unwrap(data);
    // mcp-contract.md promises a SUCCEEDED response carries
    // artifact { media_type, sha256, content }, but the live gateway returns
    // artifact metadata and serves the raw content at
    // GET /workflow-builds/{id}/artifact. Best-effort: fetch it so the tool
    // result satisfies the contract; on download failure keep the metadata.
    if (b && b.status === 'SUCCEEDED' && b.artifact_available === true && !(b.artifact && b.artifact.content !== undefined)) {
      try {
        const dl = await apiFetch(`/workflow-builds/${encodeURIComponent(args.build_id)}/artifact`, { method: 'GET', token });
        b.artifact = {
          media_type: b.artifact_media_type ?? 'application/octet-stream',
          sha256: b.artifact_sha256 ?? null,
          content: typeof dl === 'string' ? dl : JSON.stringify(dl),
        };
      } catch {
        // best-effort only — metadata stays the source of truth
      }
    }
    return b ?? data;
  },
  cancel_workflow_build: async (args, token) => {
    if (upstream) return upstream.call('cancel_workflow_build', args);
    const data = await apiFetch(`/workflow-builds/${encodeURIComponent(args.build_id)}`, { method: 'DELETE', token });
    return unwrap(data);
  },
};

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function makeError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/**
 * Dispatch a single JSON-RPC message.
 * @param {object} msg  parsed JSON-RPC message
 * @param {{ token?: string }} opts  upstream bearer token (defaults to NODECODA_KEY env)
 * @returns {Promise<object|null>} response object, or null for notifications
 */
export async function handleMcpMessage(msg, { token } = {}) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      return makeResult(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
      // client → server notification; no response
      return null;
    case 'ping':
      return makeResult(id, {});
    case 'tools/list': {
      return makeResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        return makeError(id, -32601, `Unknown tool: ${name}`);
      }
      try {
        const data = await handler(args, token);
        return makeResult(id, {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        const payload = e instanceof HttpError ? e.body : { message: e?.message ?? String(e) };
        return makeResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ status, ...payload }, null, 2) }],
          isError: true,
        });
      }
    }
    default:
      return makeError(id, -32601, `Method not implemented: ${method}`);
  }
}
