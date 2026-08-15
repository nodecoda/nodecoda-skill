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

// The public MCP gateway base is https://www.nodecoda.com/v1 — the one
// surface that accepts opaque sk-... keys for Workflow Build. The /api/v1
// admin base only accepts JWT management credentials and rejects sk- keys
// with 401 INVALID_TOKEN. NODECODA_MCP_BASE / NODECODA_API_BASE overrides
// exist for self-hosted deployments.
export function resolveUpstreamBase(env = process.env) {
  return (env.NODECODA_MCP_BASE || env.NODECODA_API_BASE || 'https://www.nodecoda.com/v1').replace(/\/$/, '');
}
import { loadDeviceId } from './device-id.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_BASE = resolveUpstreamBase();

// K-E2: guest campaign placeholder key. When NODECODA_KEY is absent the skill
// still sends a well-formed bearer token; try.nodecoda.com's loose admission
// serves it as a guest build (S-B1), while www strictly rejects it with 401.
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

const TOOL_HANDLERS = {
  // Per references/mcp-contract.md: same idempotency_key in the body AND the
  // Idempotency-Key header. We forward both for safety.
  build_dify_workflow: async (args, token) => {
    const data = await apiFetch('/workflow-builds', {
      method: 'POST',
      body: args,
      headers: { 'Idempotency-Key': args.idempotency_key },
      token,
    });
    return unwrap(data);
  },
  get_workflow_build: async (args, token) => {
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
