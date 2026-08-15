#!/usr/bin/env node
// scripts/publish-skillhub.mjs — 一键把仓库技能发布到 SkillHub (skillhub.cn)。
//
// 前置(一次性): curl -fsSL https://skillhub.cn/install/install.sh | bash -s -- --cli-only
//               skillhub login --key skh_xxx --host https://api.skillhub.cn
//
// 流程: build(白名单清理) → 校验 SKILL.md 必填字段(slug/version/displayName)
//       → skillhub auth whoami → skillhub publish <dir> --changelog <text>
// CLI 输出原样透传,不做二次解析。
// 退出码: 0 成功 / 1 一般失败 / 2 未登录 / 5 用法错误或 CLI 缺失

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUILD_SCRIPT = join(__dirname, 'build-skillhub.mjs');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const usage = () => [
  '用法: node scripts/publish-skillhub.mjs [--changelog <text>] [--dry-run] [--json]',
  '',
  '  --skill <name>     技能目录 (默认 nodecoda-workflow)',
  '  --out <dir>        build 输出目录 (默认 build/skillhub/<skill>)',
  '  --changelog <text> 变更说明 (默认 v<version>)',
  '  --dry-run          仅本地预检,不发布',
  '  --json             JSON 输出',
  '  --help             帮助',
].join('\n');

const args = process.argv.slice(2);
const opts = { skill: 'nodecoda-workflow', out: null, changelog: null, dryRun: false, json: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case '--skill': opts.skill = args[++i]; break;
    case '--out': opts.out = args[++i]; break;
    case '--changelog': opts.changelog = args[++i]; break;
    case '--dry-run': opts.dryRun = true; break;
    case '--json': opts.json = true; break;
    case '--help': case '-h': console.log(usage()); process.exit(0);
    default: console.error(`未知参数: ${a}\n\n${usage()}`); process.exit(5);
  }
}

// ---------------------------------------------------------------- helpers

export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

// 平台必填项(release.md): slug / version / displayName
export function checkSkillFrontmatter(fm) {
  const errs = [];
  if (!fm.slug) errs.push('slug 必填');
  else if (!KEBAB.test(fm.slug) || fm.slug.length < 2 || fm.slug.length > 128) errs.push(`slug 需为 kebab-case 2-128 字符 (当前 "${fm.slug}")`);
  if (!fm.version) errs.push('version 必填');
  else if (!SEMVER.test(fm.version)) errs.push(`version 需为 SemVer 如 1.0.0 (当前 "${fm.version}")`);
  if (!fm.displayName) errs.push('displayName 必填');
  return errs;
}

const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: REPO_ROOT, encoding: 'utf8' });

function resolveCli() {
  const env = process.env.SKILLHUB_CLI;
  if (env) return { cmd: env.split(/\s+/)[0], base: env.split(/\s+/).slice(1) };
  if (run('skillhub', ['--version']).status === 0) return { cmd: 'skillhub', base: [] };
  return null;
}

const fail = (code, msg) => { console.error(`✖ ${msg}`); process.exit(code); };

// ---------------------------------------------------------------- main

async function main() {
  const cli = resolveCli();
  if (!cli) fail(5, '未找到 skillhub CLI,先安装: curl -fsSL https://skillhub.cn/install/install.sh | bash -s -- --cli-only');

  const outDir = opts.out ?? join(REPO_ROOT, 'build', 'skillhub', opts.skill);
  const build = run(process.execPath, [BUILD_SCRIPT, '--skill', opts.skill, '--out', outDir]);
  if (build.status !== 0) fail(1, `build 失败 (exit ${build.status}): ${(build.stderr || build.stdout).slice(0, 300)}`);

  const skillMd = join(outDir, 'SKILL.md');
  if (!existsSync(skillMd)) fail(1, `build 产物缺少 SKILL.md: ${skillMd}`);
  const fm = parseFrontmatter(readFileSync(skillMd, 'utf8'));
  const errs = checkSkillFrontmatter(fm);
  if (errs.length) fail(1, `SKILL.md frontmatter 不合法:\n  - ${errs.join('\n  - ')}`);
  opts.changelog = opts.changelog ?? `v${fm.version}`;

  const whoami = run(cli.cmd, [...cli.base, 'auth', 'whoami']);
  if (whoami.status !== 0) fail(2, '未登录,先执行: skillhub login --key skh_xxx --host https://api.skillhub.cn');

  const pubArgs = [...cli.base, 'publish', outDir];
  if (!opts.dryRun) pubArgs.push('--changelog', opts.changelog);
  if (opts.json) pubArgs.push('--json');
  if (opts.dryRun) pubArgs.push('--dry-run');
  const pub = run(cli.cmd, pubArgs);
  if (pub.status !== 0) fail(1, `发布失败 (exit ${pub.status}): ${(pub.stderr || pub.stdout).slice(0, 300)}`);

  process.stdout.write(`${(pub.stdout || '').trim()}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((e) => fail(1, `[fatal] ${e?.stack ?? e}`));
