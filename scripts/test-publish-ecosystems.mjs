#!/usr/bin/env node
// scripts/test-publish-ecosystems.mjs — publish-ecosystems.mjs 的测试。
// 真实仓库只读检查 + 临时 fixture 失败分支,不联网。
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './publish-ecosystems.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(__dirname, 'publish-ecosystems.mjs');

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; };
const bad = (n, d) => { console.log(`  \x1b[31m✗\x1b[0m ${n}\n    ${d}`); fail++; };
const section = (t) => console.log(`\n${t}`);
const assert = (c, m) => { if (!c) throw new Error(m); };

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args],
  { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

section('frontmatter 解析');
{
  const fm = parseFrontmatter('---\nname: nodecoda-workflow\ndescription: x\nversion: 0.2.35\n---');
  assert(fm.name === 'nodecoda-workflow' && fm.description === 'x' && fm.version === '0.2.35', '字段解析正确');
  const empty = parseFrontmatter('no frontmatter here');
  assert(Object.keys(empty).length === 0, '无 frontmatter 返回空对象');
  ok('frontmatter 解析: 常规 + 空输入');
}

section('真实仓库 --json 全部 PASS');
{
  const r = run(['--json']);
  assert(r.status === 0, `exit=${r.status}`);
  const j = JSON.parse(r.stdout);
  assert(j.skills.includes('nodecoda-workflow'), '包含 nodecoda-workflow');
  assert(j.checks.length >= 4, '检查项完整');
  assert(j.checks.filter((c) => !c.pass).length === 0, '当前仓库应全部 PASS');
  ok('JSON 输出合法,当前仓库全部 PASS');
}

section('真实仓库 --check 退出码 0');
{
  const r = run(['--check']);
  assert(r.status === 0, `exit=${r.status}`);
  ok('--check 退出码 0');
}

section('fixture 失败分支: 缺 skills.sh.json + 版本不齐 → --check 退出码 1');
(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nc-eco-'));
  try {
    await mkdir(join(dir, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(join(dir, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: demo\n---\n# Demo\n');
    await writeFile(join(dir, 'skills', 'demo-skill', 'manifest.json'),
      JSON.stringify({ name: 'demo-skill', version: '1.0.0' }));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '9.9.9' }));

    const r = run(['--check'], { PUBLISH_ECOSYSTEMS_REPO_ROOT: dir });
    assert(r.status === 1, `期望退出码 1,实际 ${r.status}\nstdout: ${r.stdout}`);
    const j = JSON.parse(run(['--json'], { PUBLISH_ECOSYSTEMS_REPO_ROOT: dir }).stdout);
    const failed = j.checks.filter((c) => !c.pass);
    assert(failed.some((c) => c.id === 'skills.sh.json'), 'skills.sh.json 缺失应 FAIL');
    assert(failed.some((c) => c.id === 'parity:demo-skill'), '版本不齐应 FAIL');
    assert(j.ok === false, 'ok 应为 false');
    ok('失败分支正确: skills.sh.json 缺失 + 版本不齐 → FAIL + 退出码 1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})().then(() => {
  section('汇总');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
