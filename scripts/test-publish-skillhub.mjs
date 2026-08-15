#!/usr/bin/env node
// scripts/test-publish-skillhub.mjs — publish-skillhub.mjs 的核心测试。
// 用假 CLI(SKILLHUB_CLI 注入)覆盖 dry-run 与正式发布路径,无网络无凭据。
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseFrontmatter, checkSkillFrontmatter } from './publish-skillhub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PUBLISH = join(__dirname, 'publish-skillhub.mjs');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; };
const bad = (n, d) => { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; };
const section = (t) => console.log(`\n${t}`);
const assert = (c, m) => { if (!c) throw new Error(m); };

const tmpDir = () => mkdtemp(join(tmpdir(), 'nc-pub-'));
const runPublish = (args, { cli, log, out } = {}) => {
  const env = { ...process.env };
  if (cli) env.SKILLHUB_CLI = cli; else delete env.SKILLHUB_CLI;
  if (log) env.FAKE_SKILLHUB_LOG = log;
  const all = out ? [...args, '--out', out] : args;
  return spawnSync(process.execPath, [PUBLISH, ...all], { cwd: REPO_ROOT, encoding: 'utf8', env });
};

// 假 skillhub CLI:记录调用到 FAKE_SKILLHUB_LOG;auth whoami / publish --dry-run / publish 均成功。
async function fakeCli(dir) {
  const script = join(dir, 'fake-skillhub.mjs');
  const log = join(dir, 'calls.log');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const log = process.env.FAKE_SKILLHUB_LOG;
if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n'); }
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('skillhub 2026.8.5'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'whoami') { console.log('userId : 1\\nhandle : fake'); process.exit(0); }
if (args[0] === 'publish') {
  if (args.includes('--dry-run')) { console.log('✓ Dry-run passed: nodecoda-workflow@0.2.30'); process.exit(0); }
  console.log('✓ Published: skillId=abc123 status=pending_review\\n  url: https://skillhub.cn/skills/nodecoda-workflow'); process.exit(0);
}
process.exit(9);
`);
  return { cli: `node ${script}`, log };
}
const calls = async (log) => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);

section('frontmatter 校验');
{
  const fm = parseFrontmatter('---\nslug: nodecoda-workflow\ndisplayName: NodeCoda Workflow\nversion: 0.2.30\n---');
  assert(checkSkillFrontmatter(fm).length === 0, '合法 frontmatter 通过');
  ok('合法 frontmatter 通过');
}
{
  const errs = checkSkillFrontmatter({ slug: 'Bad Slug!', version: 'x' });
  assert(errs.some((e) => /kebab-case/.test(e)) && errs.some((e) => /SemVer/.test(e)), '非法 slug/version 被拦截');
  assert(checkSkillFrontmatter({}).length === 3, '缺必填三项报 3 个错');
  ok('非法/缺字段被拦截');
}

section('用法');
{
  assert(runPublish(['--help']).status === 0, '--help -> 0');
  assert(runPublish(['--bogus']).status === 5, '未知参数 -> 5');
  const noCli = runPublish([], { out: join(await tmpDir(), 'out'), ...(() => ({ extraEnv: {} }))() });
  ok('--help -> 0 / 未知参数 -> 5');
}
{
  // 缺 CLI:清空 PATH 且不设 SKILLHUB_CLI
  const env = { ...process.env, PATH: '/nonexistent' };
  delete env.SKILLHUB_CLI;
  const r = spawnSync(process.execPath, [PUBLISH], { cwd: REPO_ROOT, encoding: 'utf8', env });
  assert(r.status === 5 && /install\.sh/.test(r.stderr), `缺 CLI -> 5 + 安装指引, got ${r.status}`);
  ok('缺 CLI -> 5 + 安装指引');
}

section('dry-run 与正式发布(假 CLI)');
{
  const dir = await tmpDir();
  const fake = await fakeCli(dir);
  const r = runPublish(['--dry-run'], { cli: fake.cli, log: fake.log, out: join(dir, 'out') });
  assert(r.status === 0, `dry-run -> 0, got ${r.status}`);
  const cs = await calls(fake.log);
  assert(cs.length === 2 && JSON.parse(cs[1]).includes('--dry-run') && !JSON.parse(cs[1]).includes('--changelog'), '只跑 publish --dry-run');
  ok('dry-run: 只跑 publish --dry-run,不传 changelog');
}
{
  const dir = await tmpDir();
  const fake = await fakeCli(dir);
  const r = runPublish(['--changelog', '首次发布'], { cli: fake.cli, log: fake.log, out: join(dir, 'out') });
  assert(r.status === 0, `publish -> 0, got ${r.status}`);
  const cs = await calls(fake.log);
  const pub = JSON.parse(cs[1]);
  assert(pub[0] === 'publish' && pub.includes('--changelog') && pub[pub.indexOf('--changelog') + 1] === '首次发布', 'publish <dir> --changelog 透传');
  assert(/Published/.test(r.stdout), '透传 CLI 输出');
  ok('publish: 目录 + changelog 透传,输出透传');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
