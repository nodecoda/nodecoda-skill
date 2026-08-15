#!/usr/bin/env node
// scripts/test-build.mjs — unit + injected-flow tests for scripts/build.mjs
// (the `nodecoda-skill build` CLI). No network: runBuild's tool layer is
// injected with a fake caller. Asserts arg parsing, idempotency-key
// derivation, transport description, and the submit->poll->save flow across
// SUCCEEDED / FAILED / exhausted / timeout / dry-run / no-artifact paths,
// plus CLI dispatch wiring in scripts/cli.mjs.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseBuildArgs, defaultIdempotencyKey, describeTransport, runBuild,
  usage, UsageError, DEFAULT_TARGET, DEFAULT_TIMEOUT_MS,
} from './build.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
function ok(n) { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; }
function bad(n, d) { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; }
function section(t) { console.log(`\n${t}`); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const ARTIFACT = 'app:\n  mode: workflow\nversion: 0.6.0\nname: test-flow\n';
const SOURCE = '@language nodecoda/1\n@mode workflow\nfunction main() -> string { return "hi"; }\n';

async function tmpDir() { return mkdtemp(join(tmpdir(), 'nc-build-test-')); }

async function withSourceFile(dir) {
  const f = join(dir, 'demo.ncoda');
  await writeFile(f, SOURCE);
  return f;
}

function fakeCaller(sequence) {
  const calls = [];
  return {
    calls,
    fn: async (name, args) => {
      calls.push({ name, args });
      const entry = sequence.shift();
      if (typeof entry === 'function') return entry(name, args);
      if (entry === undefined) throw new Error(`unexpected tool call: ${name}`);
      return entry;
    },
  };
}

const fastDeps = (fn, emit = () => {}) => ({ callTool: fn, now: Date.now, sleep: () => Promise.resolve(), emit });

section('parseBuildArgs — defaults');
{
  const o = parseBuildArgs(['x.ncoda']);
  assert(o.file === 'x.ncoda' && o.target === DEFAULT_TARGET && o.out === 'builds', 'defaults');
  assert(o.save === true && o.dryRun === false && o.json === false && o.timeoutMs === DEFAULT_TIMEOUT_MS, 'default flags');
  assert(o.pollIntervalMs === null, 'no poll override');
  ok('defaults');
}
{
  const o = parseBuildArgs(['x.ncoda', '--target', 't2', '--out', 'd', '--no-save', '--json', '--timeout-ms', '1000', '--poll-interval-ms', '5', '--idempotency-key', 'k1', '--dry-run', '--trace']);
  assert(o.target === 't2' && o.out === 'd' && o.save === false && o.json === true, 'overrides');
  assert(o.timeoutMs === 1000 && o.pollIntervalMs === 5 && o.idempotencyKey === 'k1' && o.dryRun === true && o.trace === true, 'overrides 2');
  ok('overrides');
}
{
  const cases = [
    [['--target'], /--target requires a value/],
    [['--target', '--out'], /--target requires a value/],
    [[], /missing <file\.ncoda>/],
    [['a.ncoda', 'b.ncoda'], /unexpected extra argument/],
    [['a.ncoda', '--bogus'], /unknown option: --bogus/],
    [['a.ncoda', '--timeout-ms', 'abc'], /--timeout-ms requires a positive number/],
  ];
  for (const [argv, re] of cases) {
    try { parseBuildArgs(argv); assert(false, `should throw for ${JSON.stringify(argv)}`); }
    catch (e) { assert(e instanceof UsageError && re.test(e.message), `message ${JSON.stringify(e.message)} matches ${re}`); }
  }
  ok('usage errors');
}

section('defaultIdempotencyKey');
{
  const k1 = defaultIdempotencyKey(SOURCE, 'demo.ncoda');
  const k2 = defaultIdempotencyKey(SOURCE, 'demo.ncoda');
  const k3 = defaultIdempotencyKey(SOURCE + '\n// change', 'demo.ncoda');
  const k4 = defaultIdempotencyKey(SOURCE, 'other.ncoda');
  assert(k1 === k2 && k1.startsWith('demo-'), 'stable + base name');
  assert(k1 !== k3, 'changes with source');
  assert(k1 !== k4, 'changes with filename');
  assert(/^[a-z0-9-]+$/.test(k1), 'safe charset');
  ok('stable / distinct / prefixed');
}

section('describeTransport');
{
  const saved = { ...process.env };
  try {
    delete process.env.NODECODA_KEY; delete process.env.NODECODA_MCP_TRANSPORT; delete process.env.NODECODA_MCP_JSONRPC_URL;
    assert(describeTransport().mode === 'jsonrpc', 'no key -> guest jsonrpc');
    process.env.NODECODA_KEY = 'sk-test';
    delete process.env.NODECODA_MCP_TRANSPORT; delete process.env.NODECODA_MCP_JSONRPC_URL;
    assert(describeTransport().mode === 'rest', 'key -> rest');
    delete process.env.NODECODA_KEY; process.env.NODECODA_MCP_TRANSPORT = 'rest';
    assert(describeTransport().mode === 'rest', 'pin rest');
    process.env.NODECODA_MCP_TRANSPORT = 'jsonrpc';
    assert(describeTransport().mode === 'jsonrpc', 'pin jsonrpc');
  } finally {
    process.env = saved;
  }
  ok('transport selection matches upstreamMode contract');
}

section('runBuild — happy path (submit -> poll -> SUCCEEDED -> save)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const out = join(dir, 'out');
    const seq = [
      { build_id: 'b1', status: 'queued', poll_after_ms: 1 },
      { build_id: 'b1', status: 'BUILDING' },
      { build_id: 'b1', status: 'SUCCEEDED', source_filename: 'demo.ncoda', artifact: { media_type: 'application/yaml', sha256: 'abc', content: ARTIFACT } },
    ];
    const fake = fakeCaller(seq);
    const opts = parseBuildArgs([file, '--out', out, '--poll-interval-ms', '1']);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok && result.status === 'SUCCEEDED', `ok/status: ${JSON.stringify(result)}`);
    assert(result.build_id === 'b1' && result.transport_label.includes('guest JSON-RPC'), 'transport label present');
    assert(fake.calls[0].name === 'build_dify_workflow' && fake.calls[0].args.source === SOURCE, 'submit args');
    assert(fake.calls[0].args.language_identity === 'nodecoda/1' && fake.calls[0].args.target_profile === DEFAULT_TARGET, 'contract fields');
    assert(/^demo-[0-9a-f]{16}$/.test(fake.calls[0].args.idempotency_key), 'derived idempotency key');
    const art = join(out, 'b1', 'demo.dify.yaml');
    const rec = join(out, 'b1', 'demo.build.json');
    const src = join(out, 'b1', 'demo.ncoda');
    for (const p of [art, rec, src]) assert(existsSync(p), `saved ${p}`);
    assert((await readFile(art, 'utf8')) === ARTIFACT, 'artifact content');
    assert((await readFile(src, 'utf8')) === SOURCE, 'source copy');
    assert(result.saved.length === 3, 'three files reported');
    ok('submit/poll/save with derived key');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — FAILED with diagnostics (no artifact)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const seq = [
      { build_id: 'b2', status: 'queued', poll_after_ms: 1 },
      { build_id: 'b2', status: 'FAILED', diagnostics: [{ code: 'E1', location: { line: 3, column: 5 }, message: 'bad type' }] },
    ];
    const fake = fakeCaller(seq);
    const logs = [];
    const opts = parseBuildArgs([file, '--out', join(dir, 'out')]);
    const result = await runBuild(opts, fastDeps(fake.fn, (l) => logs.push(l)));
    assert(result.ok === false && result.reason === 'build_failed' && result.status === 'FAILED', 'reason/status');
    assert(result.diagnostics.length === 1 && result.diagnostics[0].code === 'E1', 'diagnostics surfaced');
    assert(logs.some((l) => l.includes('E1')), 'diagnostics printed');
    ok('failed path reports diagnostics');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — exhausted (no poll, soft stop)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const fake = fakeCaller([{ status: 'exhausted', message: '额度用完' }]);
    const opts = parseBuildArgs([file]);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok === false && result.reason === 'exhausted' && result.message === '额度用完', 'exhausted result');
    assert(fake.calls.length === 1, 'no poll after exhausted');
    ok('exhausted soft stop');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — admission throttled passthrough (retries exhausted)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const fake = fakeCaller([{ status: 'throttled', retry_after_ms: 1, _client_retries: 3 }]);
    const opts = parseBuildArgs([file]);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok === false && result.reason === 'admission_failed', 'throttled -> admission_failed');
    assert(fake.calls.length === 1, 'no submit retry inside runBuild (throttle handled upstream)');
    ok('throttled passthrough');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — timeout');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    // Deterministic fake clock: sleep advances `now` so the poll loop bounds.
    let t = 0;
    const seq = [
      { build_id: 'b3', status: 'queued', poll_after_ms: 1 },
      ...Array.from({ length: 10 }, () => ({ build_id: 'b3', status: 'BUILDING' })),
    ];
    const fake = fakeCaller(seq);
    const opts = { ...parseBuildArgs([file]), timeoutMs: 50, pollIntervalMs: 10 };
    const result = await runBuild(opts, {
      callTool: fake.fn, now: () => t, sleep: async (ms) => { t += ms; }, emit: () => {},
    });
    assert(result.ok === false && result.reason === 'timeout', 'timeout result');
    // polls at t=0,10,20,30,40 -> loop exits at t=50 -> 1 submit + 5 polls = 6 calls
    assert(fake.calls.length === 6, `1 submit + 5 polls expected (got ${fake.calls.length})`);
    assert(fake.calls.slice(1).every((c) => c.name === 'get_workflow_build'), 'all post-submit calls are polls');
    ok('timeout bounded by fake clock');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — dry-run (no submit)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const fake = fakeCaller([]);
    const opts = parseBuildArgs([file, '--dry-run']);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok === true && result.dry_run === true, 'dry-run ok');
    assert(fake.calls.length === 0, 'nothing submitted');
    assert(result.args.language_identity === 'nodecoda/1' && result.args.target_profile === DEFAULT_TARGET, 'args built');
    ok('dry-run');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — missing source file');
{
  const dir = await tmpDir();
  try {
    const opts = parseBuildArgs([join(dir, 'nope.ncoda')]);
    try {
      await runBuild(opts, fastDeps(() => { throw new Error('should not call'); }));
      assert(false, 'should throw');
    } catch (e) { assert(e instanceof UsageError && /source not found/.test(e.message), 'UsageError with message'); }
    ok('missing source -> UsageError');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — SUCCEEDED without inline artifact (record only)');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const seq = [
      { build_id: 'b4', status: 'queued', poll_after_ms: 1 },
      { build_id: 'b4', status: 'SUCCEEDED', source_filename: 'demo.ncoda', artifact_available: true },
    ];
    const fake = fakeCaller(seq);
    const out = join(dir, 'out');
    const opts = parseBuildArgs([file, '--out', out]);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok === true && result.saved.length === 2, 'record + source saved');
    assert(existsSync(join(out, 'b4', 'demo.build.json')), 'record exists');
    ok('no-artifact SUCCEEDED saves record only');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('runBuild — --no-save');
{
  const dir = await tmpDir();
  try {
    const file = await withSourceFile(dir);
    const seq = [
      { build_id: 'b5', status: 'queued', poll_after_ms: 1 },
      { build_id: 'b5', status: 'SUCCEEDED', source_filename: 'demo.ncoda', artifact: { media_type: 'application/yaml', content: ARTIFACT } },
    ];
    const fake = fakeCaller(seq);
    const opts = parseBuildArgs([file, '--no-save', '--json']);
    const result = await runBuild(opts, fastDeps(fake.fn));
    assert(result.ok === true && result.saved.length === 0, 'nothing saved');
    ok('--no-save');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('CLI wiring (scripts/cli.mjs)');
{
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'build'], { encoding: 'utf8' });
  assert(r.status === 2, `no-arg build exits 2 (got ${r.status})`);
  assert(r.stderr.includes('usage: nodecoda-skill build'), 'usage shown');
  const h = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/cli.mjs'), 'help'], { encoding: 'utf8' });
  assert(h.status === 0 && h.stdout.includes('build <file.ncoda>'), 'help lists build');
  const u = usage();
  assert(u.includes('--trace') && u.includes('--json') && u.includes('--dry-run'), 'usage documents --trace/--json/--dry-run');
  ok('cli dispatch + help');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
