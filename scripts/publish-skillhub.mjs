#!/usr/bin/env node
// scripts/publish-skillhub.mjs
// One-command publish of a repo skill to SkillHub (skillhub.cn / skill.xfyun.cn).
//
// Pipeline:
//   1. BUILD — spawn scripts/build-skillhub.mjs --zip (whitelist-clean package
//      + store-only zip; the script self-verifies whitelist/references/hashes
//      and exits non-zero on any inconsistency).
//   2. AUTH — resolve the SkillHub CLI (@astron-team/skillhub) and check
//      `whoami` succeeds. Token priority is the CLI's own (--token >
//      SKILLHUB_TOKEN > ~/.skillhub/credentials.json); this script never
//      reads or writes credentials.
//   3. PUBLISH — `skillhub publish <zip> --namespace <ns> [--visibility]`.
//   4. REPORT — print the skill detail URL (or --json result).
//
// CLI resolution: SKILLHUB_CLI env override (tests), then `skillhub` on PATH,
// then `npx -y @astron-team/skillhub`.
//
// Usage:
//   node scripts/publish-skillhub.mjs --namespace <ns> [options]
//     --namespace <ns>    required — SkillHub namespace (publish target)
//     --visibility <v>    public (default) | namespace-only | private
//     --skill <name>      skill dir name under skills/ (default nodecoda-workflow)
//     --out <dir>         build output dir (default <repo>/build/skillhub)
//     --registry <url>    registry override (default: CLI config)
//     --token <token>     explicit token (forwarded to skillhub CLI)
//     --cli <cmd>         explicit skillhub CLI command
//     --dry-run           build + auth check only, do NOT publish
//     --json              machine-readable result on stdout
//     --help              show usage
//
// Exit codes (mirror skillhub CLI): 0 ok / 1 general / 2 auth / 5 usage.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUILD_SCRIPT = join(__dirname, 'build-skillhub.mjs');

function usage() {
  return [
    'usage: node scripts/publish-skillhub.mjs --namespace <ns> [options]',
    '',
    '  --namespace <ns>    required — SkillHub namespace',
    '  --visibility <v>    public (default) | namespace-only | private',
    '  --skill <name>      skill dir under skills/ (default nodecoda-workflow)',
    '  --out <dir>         build output dir (default <repo>/build/skillhub)',
    '  --registry <url>    registry override',
    '  --token <token>     explicit token (forwarded to skillhub CLI)',
    '  --cli <cmd>         explicit skillhub CLI command',
    '  --dry-run           build + auth check only, do NOT publish',
    '  --json              machine-readable result',
  ].join('\n');
}

const args = process.argv.slice(2);
const opts = {
  namespace: null, visibility: 'public', skill: 'nodecoda-workflow',
  out: join(REPO_ROOT, 'build', 'skillhub'), registry: null, token: null,
  cli: null, dryRun: false, json: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case '--namespace': opts.namespace = args[++i]; break;
    case '--visibility': opts.visibility = args[++i]; break;
    case '--skill': opts.skill = args[++i]; break;
    case '--out': opts.out = args[++i]; break;
    case '--registry': opts.registry = args[++i]; break;
    case '--token': opts.token = args[++i]; break;
    case '--cli': opts.cli = args[++i]; break;
    case '--dry-run': opts.dryRun = true; break;
    case '--json': opts.json = true; break;
    case '--help': case '-h': console.log(usage()); process.exit(0);
    default:
      console.error(`Unknown argument: ${a}\n\n${usage()}`);
      process.exit(5);
  }
}
if (!opts.namespace) {
  console.error('error: --namespace <ns> is required\n\n' + usage());
  process.exit(5);
}
if (!['public', 'namespace-only', 'private'].includes(opts.visibility)) {
  console.error(`error: --visibility must be public | namespace-only | private (got ${opts.visibility})`);
  process.exit(5);
}

// ------------------------------------------------------------- run helpers

function run(cmd, argv, { cwd = REPO_ROOT } = {}) {
  return spawnSync(cmd, argv, { cwd, encoding: 'utf8' });
}

function resolveCli() {
  if (opts.cli) return { cmd: opts.cli.split(/\s+/)[0], base: opts.cli.split(/\s+/).slice(1) };
  const env = process.env.SKILLHUB_CLI;
  if (env) return { cmd: env.split(/\s+/)[0], base: env.split(/\s+/).slice(1) };
  if (run('skillhub', ['version']).status === 0) return { cmd: 'skillhub', base: [] };
  return { cmd: 'npx', base: ['-y', '@astron-team/skillhub'] };
}

function cliBaseArgs(...extra) {
  const out = [...opts.cliBase];
  if (opts.registry) out.push('--registry', opts.registry);
  if (opts.token) out.push('--token', opts.token);
  out.push(...extra);
  return out;
}

// `--json` only applies to the publish subcommand (machine-readable result);
// auth/version probes stay plain. It is appended last so it never sits
// between the subcommand and its operands (CLI parsers are strict about that).
function cliArgs(...extra) {
  const out = cliBaseArgs();
  out.push(...extra);
  if (opts.json) out.push('--json');
  return out;
}

function fail(code, message) {
  const r = { ok: false, exitCode: code, message };
  if (opts.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else console.error(`✖ ${message}`);
  process.exit(code);
}

function succeed(r) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    console.log(`\n✓ ${r.message ?? 'publish complete'}`);
    if (r.url) console.log(`url:      ${r.url}`);
    if (r.detail) console.log(`detail:   ${r.detail}`);
  }
  process.exit(0);
}

// ------------------------------------------------------------- pipeline

async function main() {
  // 1. build the whitelist-clean package + zip (self-verifying)
  const buildArgs = ['--skill', opts.skill, '--out', opts.out, '--zip'];
  const build = run(process.execPath, [BUILD_SCRIPT, ...buildArgs]);
  if (build.status !== 0) {
    fail(1, `build-skillhub failed (exit ${build.status}): ${(build.stderr || build.stdout).slice(0, 500)}`);
  }

  const zipPath = `${opts.out}.zip`;
  if (!existsSync(zipPath)) fail(1, `build succeeded but zip not found: ${zipPath}`);
  if (!opts.json) console.log(`package:  ${zipPath}`);

  // 2. resolve CLI + auth check
  const cli = resolveCli();
  opts.cliBase = cli.base;
  const whoami = run(cli.cmd, cliBaseArgs('whoami'));
  if (whoami.status !== 0) {
    const detail = (whoami.stderr || whoami.stdout || '').slice(0, 200);
    fail(2, `SkillHub auth failed — run \`skillhub login --token sk_...\` (or set SKILLHUB_TOKEN / --token). ${detail ? `(${detail})` : ''}`);
  }
  if (!opts.json) console.log(`auth:     ${whoami.stdout.trim().split('\n')[0] || 'ok'}`);

  if (opts.dryRun) {
    succeed({ ok: true, dryRun: true, exitCode: 0, message: `dry-run OK — package built, auth valid, publish skipped (would publish ${opts.namespace}/${opts.skill})` });
  }

  // 3. publish the zip
  const pub = run(cli.cmd, cliArgs('publish', zipPath, '--namespace', opts.namespace, '--visibility', opts.visibility));
  if (pub.status !== 0) {
    fail(1, `skillhub publish failed (exit ${pub.status}): ${(pub.stderr || pub.stdout).slice(0, 500)}`);
  }

  // 4. report
  const out = (pub.stdout || '').trim();
  const url = out.match(/https?:\/\/[^\s]+/)?.[0] ?? null;
  succeed({
    ok: true, exitCode: 0,
    namespace: opts.namespace, skill: opts.skill, visibility: opts.visibility,
    url, detail: out,
    message: `published ${opts.namespace}/${opts.skill} (${opts.visibility})`,
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => { fail(1, `[fatal] ${e?.stack ?? e}`); });
}
