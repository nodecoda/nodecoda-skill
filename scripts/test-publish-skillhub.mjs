#!/usr/bin/env node
// scripts/test-publish-skillhub.mjs — integration tests for
// scripts/publish-skillhub.mjs (SkillHub auto-publish pipeline).
//
// A fake skillhub CLI (node script) is injected via SKILLHUB_CLI so no
// network, no credentials, no real publish ever happens. The build step runs
// the real scripts/build-skillhub.mjs against a temp --out dir (whitelist
// clean + store-only zip). Asserts: usage errors -> exit 5, --help -> 0,
// auth failure mapping -> 2, dry-run (build + whoami, publish NEVER called),
// and the real publish path (publish called with zip / --namespace /
// --visibility; detail URL surfaced) in both human and --json output.
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PUBLISH = join(__dirname, 'publish-skillhub.mjs');

let pass = 0, fail = 0;
function ok(n) { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; }
function bad(n, d) { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; }
function section(t) { console.log(`\n${t}`); }
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function tmpDir(prefix) { return mkdtemp(join(tmpdir(), prefix)); }

function runPublish(args, { cli, log, out, failAuth } = {}) {
  const env = { ...process.env, SKILLHUB_CLI: cli };
  if (log) env.FAKE_SKILLHUB_LOG = log;
  if (failAuth) env.FAIL_AUTH = '1';
  const all = out ? [...args, '--out', out] : args;
  return spawnSync(process.execPath, [PUBLISH, ...all], { cwd: REPO_ROOT, encoding: 'utf8', env });
}

// Fake @astron-team/skillhub CLI: appends one JSON argv line per invocation
// to FAKE_SKILLHUB_LOG; `whoami` -> exit 0 (exit 2 when FAIL_AUTH=1);
// `publish` -> echoes a skill detail URL.
async function fakeCli(dir) {
  const script = join(dir, 'fake-skillhub.mjs');
  const log = join(dir, 'calls.log');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const log = process.env.FAKE_SKILLHUB_LOG;
if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n'); }
const [cmd] = process.argv.slice(2).filter((a) => a !== '--json');
if (cmd === 'whoami') { if (process.env.FAIL_AUTH === '1') process.exit(2); console.log('fake-user'); process.exit(0); }
if (cmd === 'publish') { console.log('published: https://skill.xfyun.cn/detail/fake-skill'); process.exit(0); }
console.error('unknown fake cmd: ' + process.argv.slice(2).join(' ')); process.exit(9);
`);
  return { cli: `node ${script}`, script, log };
}

const fakeLog = async (log) => {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean); }
  catch { return []; }
};

section('usage errors');
{
  const r = runPublish([]);
  assert(r.status === 5, `missing --namespace -> exit 5, got ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  assert(/--namespace/.test(r.stderr), 'stderr mentions --namespace');
  ok('missing --namespace -> exit 5');
}
{
  const r = runPublish(['--namespace', 'ns', '--bogus']);
  assert(r.status === 5, `unknown arg -> exit 5, got ${r.status}`);
  assert(/Unknown argument/.test(r.stderr), 'stderr mentions unknown argument');
  ok('unknown argument -> exit 5');
}
{
  const r = runPublish(['--namespace', 'ns', '--visibility', 'super-secret']);
  assert(r.status === 5, `invalid --visibility -> exit 5, got ${r.status}`);
  assert(/visibility/.test(r.stderr), 'stderr mentions visibility');
  ok('invalid --visibility -> exit 5');
}
{
  const r = runPublish(['--help']);
  assert(r.status === 0, `--help -> exit 0, got ${r.status}`);
  assert(/usage/i.test(r.stdout), 'usage text on stdout');
  ok('--help -> exit 0');
}

section('auth failure mapping');
{
  const dir = await tmpDir('nc-pub-auth-');
  try {
    const fake = await fakeCli(dir);
    const r = runPublish(['--namespace', 'ns'], { cli: fake.cli, log: fake.log, out: join(dir, 'out'), failAuth: true });
    assert(r.status === 2, `whoami failure -> exit 2, got ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    assert(/auth/i.test(r.stderr), 'stderr mentions auth');
    ok('whoami failure -> exit 2 (auth)');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('dry-run — build + auth only, publish never called');
{
  const dir = await tmpDir('nc-pub-dry-');
  try {
    const fake = await fakeCli(dir);
    const out = join(dir, 'out');
    const r = runPublish(['--namespace', 'ns', '--dry-run'], { cli: fake.cli, log: fake.log, out });
    assert(r.status === 0, `dry-run -> exit 0, got ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    const lines = await fakeLog(fake.log);
    assert(lines.length === 1, `only whoami called, got ${lines.length} call(s): ${lines.join(' | ')}`);
    assert(JSON.parse(lines[0])[0] === 'whoami', 'first call is whoami');
    assert(existsSync(`${out}.zip`), `zip produced at ${out}.zip`);
    assert(/dry-run OK/.test(r.stdout), 'stdout mentions dry-run OK');
    ok('dry-run: build + whoami ok, publish never called, zip produced');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('publish path — fake CLI records the real call (human output)');
{
  const dir = await tmpDir('nc-pub-run-');
  try {
    const fake = await fakeCli(dir);
    const out = join(dir, 'out');
    const r = runPublish(['--namespace', 'acme', '--visibility', 'namespace-only'], { cli: fake.cli, log: fake.log, out });
    assert(r.status === 0, `publish -> exit 0, got ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    const lines = await fakeLog(fake.log);
    assert(lines.length === 2, `two CLI calls (whoami + publish), got ${lines.length}: ${lines.join(' | ')}`);
    const pub = JSON.parse(lines[1]);
    assert(pub[0] === 'publish', `first arg is publish, got ${pub[0]}`);
    assert(pub[1] === `${out}.zip`, `zip path passed, got ${pub[1]}`);
    assert(pub.includes('--namespace') && pub[pub.indexOf('--namespace') + 1] === 'acme', 'namespace forwarded');
    assert(pub.includes('--visibility') && pub[pub.indexOf('--visibility') + 1] === 'namespace-only', 'visibility forwarded');
    assert(/https:\/\/skill\.xfyun\.cn\/detail\/fake-skill/.test(r.stdout), `detail URL surfaced, got: ${r.stdout.slice(-300)}`);
    ok('publish: whoami + publish called with zip/namespace/visibility, URL surfaced');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

section('publish path — --json machine-readable result');
{
  const dir = await tmpDir('nc-pub-json-');
  try {
    const fake = await fakeCli(dir);
    const out = join(dir, 'out');
    const r = runPublish(['--namespace', 'acme', '--json'], { cli: fake.cli, log: fake.log, out });
    assert(r.status === 0, `publish --json -> exit 0, got ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    const parsed = JSON.parse(r.stdout);
    assert(parsed.ok === true && parsed.exitCode === 0, 'json result ok:true, exitCode:0');
    assert(parsed.namespace === 'acme' && parsed.skill === 'nodecoda-workflow', 'json carries namespace + skill');
    assert(parsed.url === 'https://skill.xfyun.cn/detail/fake-skill', `json carries url, got ${parsed.url}`);
    ok('--json: parseable {ok, namespace, skill, visibility, url}');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
