#!/usr/bin/env node
// scripts/build.mjs
// `nodecoda-skill build <file>` — submit a NodeCoda Source to the Workflow
// Build service from the CLI. No MCP client and no API key required.
//
// This is the zero-wiring path for the friction the skill historically had:
// a no-key user had to reconstruct the guest JSON-RPC protocol from source.
// Now the same product contract as the MCP servers (mcp-core.upstreamMode)
// picks the transport automatically:
//   - NODECODA_KEY set                    -> REST  https://www.nodecoda.com/v1
//   - NODECODA_MCP_TRANSPORT=rest|jsonrpc -> explicit pin (self-host / tests)
//   - NODECODA_MCP_JSONRPC_URL set        -> guest JSON-RPC override
//   - otherwise                           -> guest JSON-RPC https://try.nodecoda.com/mcp
// and the CLI submits -> polls to a terminal state -> saves the Dify Workflow
// artifact + build record + a source copy under --out (default ./builds/).
//
// Usage:
//   node scripts/build.mjs <file.ncoda> [options]
//     --target <profile>        target profile (default dify-1.16-graphon-0.6)
//     --idempotency-key <key>   override derived default (<base>-<sha256[:16]>)
//     --out <dir>               output dir for saved build (default builds)
//     --no-save                 don't write artifact/record to disk
//     --timeout-ms <n>          poll timeout (default 300000)
//     --dry-run                 validate transport + args, do not submit
//     --json                    machine-readable result on stdout
//
// Exit codes: 0 = SUCCEEDED (artifact saved unless --no-save)
//             2 = build failed / exhausted / usage error
//             1 = unexpected error
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callTool, createToolCaller, upstreamMode, resolveJsonRpcUrl, resolveUpstreamBase } from './mcp-core.mjs';

export const DEFAULT_TARGET = 'dify-1.16-graphon-0.6';
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_POLL_MS = 2_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export class UsageError extends Error {}

export function parseBuildArgs(argv = process.argv.slice(2)) {
  const opts = {
    file: null,
    target: DEFAULT_TARGET,
    idempotencyKey: null,
    out: 'builds',
    save: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: null,
    dryRun: false,
    json: false,
    trace: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--target':
        opts.target = argv[++i];
        if (opts.target === undefined || opts.target.startsWith('-')) throw new UsageError('--target requires a value');
        break;
      case '--idempotency-key':
        opts.idempotencyKey = argv[++i];
        if (opts.idempotencyKey === undefined || opts.idempotencyKey.startsWith('-')) throw new UsageError('--idempotency-key requires a value');
        break;
      case '--out':
        opts.out = argv[++i];
        if (opts.out === undefined || opts.out.startsWith('-')) throw new UsageError('--out requires a value');
        break;
      case '--timeout-ms': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) throw new UsageError('--timeout-ms requires a positive number');
        opts.timeoutMs = v;
        break;
      }
      case '--poll-interval-ms': {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) throw new UsageError('--poll-interval-ms requires a positive number');
        opts.pollIntervalMs = v;
        break;
      }
      case '--no-save': opts.save = false; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--trace': opts.trace = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length === 0) throw new UsageError('missing <file.ncoda> argument');
  if (positional.length > 1) throw new UsageError(`unexpected extra argument: ${positional[1]}`);
  opts.file = positional[0];
  return opts;
}

export function usage() {
  return [
    'usage: nodecoda-skill build <file.ncoda> [options]',
    '',
    'Submit a NodeCoda Source to the Workflow Build service and save the',
    'resulting Dify artifact. No MCP client and no API key required:',
    '  no key                 -> guest JSON-RPC https://try.nodecoda.com/mcp',
    '  NODECODA_KEY set       -> REST        https://www.nodecoda.com/v1',
    '',
    'options:',
    '  --target <profile>        target profile (default dify-1.16-graphon-0.6)',
    '  --idempotency-key <key>   override derived default (<base>-<sha256[:16]>)',
    '  --out <dir>               output dir for saved build (default builds)',
    '  --no-save                 don\'t write artifact/record to disk',
    '  --timeout-ms <n>          poll timeout in ms (default 300000)',
    '  --dry-run                 validate transport + args, do not submit',
    '  --trace                   print the full JSON-RPC wire exchange (stderr)',
    '                            — initialize/session/SSE frames/parsed result',
    '  --json                    machine-readable result on stdout',
  ].join('\n');
}

export function defaultIdempotencyKey(source, filename) {
  const base = basename(filename, '.ncoda');
  const h = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `${base}-${h}`;
}

export function describeTransport() {
  const mode = upstreamMode();
  return mode === 'rest'
    ? { mode: 'rest', label: `REST ${resolveUpstreamBase()} (key path)` }
    : { mode: 'jsonrpc', label: `guest JSON-RPC ${resolveJsonRpcUrl()} (no key)` };
}

/**
 * Full build flow with dependency injection for the network/sleep layers so
 * tests can run it against a fake tool caller with no network.
 * @param {object} opts parsed build args (see parseBuildArgs)
 * @param {object} deps { callTool?, now?, sleep?, out? }
 * @returns {Promise<object>} machine-readable result (also drives human output)
 */
export async function runBuild(opts, deps = {}) {
  const call = deps.callTool ?? (opts.trace
    ? createToolCaller({ trace: (line) => process.stderr.write(`[mcp-trace] ${line}\n`) })
    : callTool);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const emit = deps.emit ?? ((line) => process.stdout.write(`${line}\n`));
  const log = opts.json ? () => {} : emit;

  if (!existsSync(opts.file)) throw new UsageError(`source not found: ${opts.file}`);
  const source = await readFile(opts.file, 'utf8');
  const transport = describeTransport();
  const args = {
    source,
    source_filename: basename(opts.file),
    language_identity: 'nodecoda/1',
    target_profile: opts.target,
    idempotency_key: opts.idempotencyKey ?? defaultIdempotencyKey(source, basename(opts.file)),
  };
  const base = {
    ok: false,
    transport: transport.mode,
    transport_label: transport.label,
    target: args.target_profile,
    idempotency_key: args.idempotency_key,
    source_filename: args.source_filename,
  };

  log(`transport: ${transport.label}`);
  log(`target:    ${args.target_profile}`);
  log(`source:    ${opts.file} (${source.length} bytes)`);

  if (opts.dryRun) {
    log('dry-run:   transport + args OK, not submitting');
    return { ...base, ok: true, dry_run: true, args };
  }

  const admitted = await call('build_dify_workflow', args);
  const admissionStatus = admitted?.status;
  if (admissionStatus === 'exhausted') {
    // Device daily quota soft stop (product state, not a failure we retry).
    const message = admitted.message ?? '免费体验额度已用完，请改天再来。';
    log(`admission: ${admissionStatus} — ${message}`);
    return { ...base, reason: 'exhausted', status: admissionStatus, message, build: admitted, build_id: admitted.build_id ?? null };
  }
  if (admissionStatus === 'throttled' || admitted?.error || !admitted?.build_id) {
    const reason = admitted?.error ?? `admission response did not include a build_id (status=${admissionStatus ?? '?'})`;
    log(`admission: failed — ${typeof reason === 'object' ? JSON.stringify(reason) : reason}`);
    return { ...base, reason: 'admission_failed', status: admissionStatus ?? null, error: reason, build: admitted ?? null, build_id: admitted?.build_id ?? null };
  }
  const buildId = admitted.build_id;
  log(`admitted:  build_id=${buildId} status=${admitted.status} poll_after_ms=${admitted.poll_after_ms ?? '-'}`);

  const rec = await pollUntilTerminal(buildId, opts, { call, now, sleep, log });
  return finalize(rec, buildId, opts, source, { log, ...base });
}

async function pollUntilTerminal(buildId, opts, { call, now, sleep, log }) {
  const start = now();
  const pollAfter = Number(opts.pollAfterMs ?? 0);
  const interval = Number.isFinite(pollAfter) && pollAfter > 0 ? pollAfter : (opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  let last = null;
  while (now() - start < opts.timeoutMs) {
    const rec = await call('get_workflow_build', { build_id: buildId });
    last = rec;
    log(`poll:      status=${rec?.status ?? '?'} (t=${Math.round((now() - start) / 1000)}s)`);
    if (TERMINAL.has(rec?.status)) return rec;
    await sleep(interval);
  }
  log(`poll:      TIMEOUT after ${opts.timeoutMs}ms (last status=${last?.status ?? '?'})`);
  return { ...(last ?? {}), _timeout: true };
}

async function finalize(rec, buildId, opts, source, { log, ...base }) {
  const status = rec?.status;
  if (rec?._timeout) {
    return { ...base, reason: 'timeout', status: status ?? null, build: rec, build_id: rec?.build_id ?? buildId };
  }
  if (status !== 'SUCCEEDED') {
    for (const d of (rec?.diagnostics ?? []).slice(0, 10)) {
      const loc = d.location ? ` @ ${d.location.line ?? '?'}:${d.location.column ?? '?'}` : '';
      log(`diag:      ${d.code ?? '?'}${loc}  ${d.message ?? ''}`.replace(/\s+/g, ' '));
    }
    return { ...base, reason: 'build_failed', status, build: rec, diagnostics: rec?.diagnostics ?? [], build_id: rec?.build_id ?? buildId };
  }
  if (!opts.save) {
    return { ...base, ok: true, status: 'SUCCEEDED', build: rec, saved: [], build_id: rec?.build_id ?? buildId };
  }
  const saved = await saveArtifact(rec, opts, source, { log });
  return { ...base, ok: true, status: 'SUCCEEDED', build: rec, saved, artifact: rec.artifact ?? null, build_id: rec?.build_id ?? buildId };
}

// Layout mirrors scripts/save-build.mjs: <out>/<build_id>/ with
// <source-base>.dify.yaml + <source-base>.build.json + a client-side source
// copy (the backend stores only source_sha256, not the source text).
async function saveArtifact(rec, opts, source, { log }) {
  const buildId = rec.build_id ?? 'unknown';
  const dir = join(opts.out, buildId);
  await mkdir(dir, { recursive: true });
  const sourceBase = (rec.source_filename || buildId).replace(/\.ncoda$/, '');
  const saved = [];

  const recPath = join(dir, `${sourceBase}.build.json`);
  await writeFile(recPath, JSON.stringify(rec, null, 2));
  saved.push(recPath);

  const a = rec.artifact;
  if (a && typeof a.content === 'string') {
    const media = a.media_type ?? 'application/octet-stream';
    const ext = media.includes('yaml') ? 'yaml' : media.includes('json') ? 'json' : 'bin';
    const artPath = join(dir, `${sourceBase}.dify.${ext}`);
    await writeFile(artPath, a.content);
    saved.push(artPath);
    log(`artifact:  ${artPath} (sha256=${a.sha256 ?? '-'})`);
  } else if (a && typeof a.content_b64 === 'string') {
    const artPath = join(dir, `${sourceBase}.dify.yaml`);
    await writeFile(artPath, Buffer.from(a.content_b64, 'base64'));
    saved.push(artPath);
    log(`artifact:  ${artPath} (sha256=${a.sha256 ?? '-'})`);
  } else {
    log('artifact:  none inline (build record saved; if you have a key, run save-build to fetch it)');
  }

  const srcCopy = join(dir, basename(opts.file));
  await copyFile(opts.file, srcCopy);
  saved.push(srcCopy);
  return saved;
}

async function main() {
  let opts;
  try {
    opts = parseBuildArgs();
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error(usage());
    process.exit(2);
  }
  const result = await runBuild(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    const where = result.saved?.length ? ` — ${result.saved.length} file(s) saved under ${opts.out}/` : '';
    console.log(`\n✓ SUCCEEDED  build_id=${result.build_id ?? result.build?.build_id ?? '-'}${where}`);
  } else {
    console.error(`\n✖ ${result.reason === 'exhausted' ? result.message : `Build ${result.status ?? 'failed'} (${result.reason})`}`);
  }
  process.exit(result.ok ? 0 : 2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(`[fatal] ${e?.stack ?? e}`);
    process.exit(1);
  });
}
