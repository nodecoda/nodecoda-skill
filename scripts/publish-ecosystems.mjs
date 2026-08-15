#!/usr/bin/env node
// scripts/publish-ecosystems.mjs — 生态发布就绪检查 + 同步清单。
//
// 目标: 确保本仓库能被主流 Agent Skill 聚合平台自动抓取,并给出各平台
//       的同步命令/链接。纯 Node 18+ 内置模块,零依赖。
//
// 覆盖平台(2026-08 核实):
//   skills.sh (Vercel)   — 半自动: 首次安装遥测触发 + 索引请求 issue + skills.sh.json
//   SkillsMP  (skillsmp.com) — 纯爬虫: 公开 GitHub 上的 SKILL.md,无提交入口
//   SkillsCat (skills.cat)   — 自动爬取 + 手动 submit/publish 加速
//   agentskill.sh             — 仅 Web 表单提交 (https://agentskill.sh/submit)
//   ClawHub / OpenClaw        — 提交制: clawhub skill publish
//   SkillsPAI (skillspai)     — 未上线(2026-08): npm 包 + 本地 registry,仅预留
//   SkillHub.cn (iflytek)     — 已有独立发布链路 publish-skillhub.mjs
//
// 用法:
//   node scripts/publish-ecosystems.mjs            # 检查 + 打印清单
//   node scripts/publish-ecosystems.mjs --check    # 仅检查,失败退出码 1 (CI 用)
//   node scripts/publish-ecosystems.mjs --json     # JSON 输出
//   node scripts/publish-ecosystems.mjs --help
//
// 退出码: 0 通过 / 1 检查失败 / 5 用法错误

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.PUBLISH_ECOSYSTEMS_REPO_ROOT
  ? resolve(process.env.PUBLISH_ECOSYSTEMS_REPO_ROOT)
  : resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');
const SHJSON_PATH = join(REPO_ROOT, 'skills.sh.json');

const args = process.argv.slice(2);
const opts = { check: false, json: false };
for (const a of args) {
  if (a === '--check') opts.check = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/publish-ecosystems.mjs [--check] [--json] [--help]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(5); }
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

function discoverSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------- checks

function checks(skills) {
  const results = [];
  const add = (id, label, pass, detail = '') => results.push({ id, label, pass, detail });

  // 1) SKILL.md frontmatter — skills.sh / SkillsMP / SkillsCat 的最低要求
  for (const name of skills) {
    const md = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const fm = parseFrontmatter(md);
    const missing = ['name', 'description'].filter((k) => !fm[k]);
    add(`frontmatter:${name}`, `SKILL.md frontmatter (${name})`, missing.length === 0,
      missing.length ? `缺少: ${missing.join(', ')}` : `name=${fm.name}`);
  }

  // 2) manifest.json 存在且 version 与 package.json 对齐
  for (const name of skills) {
    const mp = join(SKILLS_DIR, name, 'manifest.json');
    if (!existsSync(mp)) { add(`manifest:${name}`, `manifest.json (${name})`, false, '文件缺失'); continue; }
    let m;
    try { m = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { add(`manifest:${name}`, `manifest.json (${name})`, false, `JSON 解析失败: ${e.message}`); continue; }
    add(`manifest:${name}`, `manifest.json (${name})`, !!m.version, m.version ? `version=${m.version}` : '缺少 version');
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const name of skills) {
    const mp = join(SKILLS_DIR, name, 'manifest.json');
    if (!existsSync(mp)) continue;
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    add(`parity:${name}`, `version 对齐 manifest↔package (${name})`, m.version === pkg.version,
      m.version === pkg.version ? `manifest=${m.version} == package=${pkg.version}` : `manifest=${m.version} != package=${pkg.version}`);
  }

  // 3) skills.sh.json — skills.sh 目录元数据
  if (existsSync(SHJSON_PATH)) {
    let sh;
    try { sh = JSON.parse(readFileSync(SHJSON_PATH, 'utf8')); } catch (e) { add('skills.sh.json', 'skills.sh.json (根目录)', false, `JSON 解析失败: ${e.message}`); sh = null; }
    if (sh) {
      const okSchema = sh.$schema === 'https://skills.sh/schemas/skills.sh.schema.json';
      const listed = (sh.groupings || []).flatMap((g) => g.skills || []);
      const unknown = [...new Set(listed)].filter((s) => !skills.includes(s));
      add('skills.sh.json', 'skills.sh.json (根目录)', okSchema && unknown.length === 0,
        okSchema ? (unknown.length ? `引用不存在的 skill: ${unknown.join(', ')}` : `groupings 引用 ${listed.length} 个 skill`) : `$schema 不匹配: ${sh.$schema}`);
    }
  } else {
    add('skills.sh.json', 'skills.sh.json (根目录)', false, '缺失 — 创建后 skills.sh 才能正确分组展示');
  }

  return results;
}

// ---------------------------------------------------------------- report

function buildReport(results, skills) {
  const date = new Date().toISOString().slice(0, 10);
  const failCount = results.filter((r) => !r.pass).length;
  const lines = [];
  lines.push(`生态同步就绪检查 (${date}) — ${skills.length} 个 skill: ${skills.join(', ')}`);
  for (const r of results) lines.push(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
  lines.push(`  结果: ${failCount === 0 ? '全部通过,可发布' : `${failCount} 项未通过`}`);
  lines.push('');
  lines.push('--- 各平台同步方式 (2026-08 实测) ---');
  lines.push('skills.sh (Vercel)   半自动: 首次 `npx skills add nodecoda/nodecoda-skill` 触发遥测;');
  lines.push('                      已提索引请求: https://github.com/vercel-labs/skills/issues/1970');
  lines.push('                      徽章: https://skills.sh/b/nodecoda/nodecoda-skill');
  lines.push('SkillsMP             纯爬虫自动收录,无提交入口;公开 repo + SKILL.md 即足够');
  lines.push('SkillsCat            自动爬取;加速提交: npx skillscat login && npx skillscat submit https://github.com/nodecoda/nodecoda-skill');
  lines.push('agentskill.sh        Web 表单(需浏览器): https://agentskill.sh/submit 粘贴 repo URL');
  lines.push('ClawHub/OpenClaw     可选: npx clawhub skill publish ./build/skillhub/nodecoda-workflow --slug nodecoda-workflow');
  lines.push('SkillsPAI            未上线 (skillspai.com 不可达, GitHub 仓库 404) — 仅预留,上线后再同步');
  lines.push('SkillHub.cn          已有独立链路: node scripts/publish-skillhub.mjs');
  lines.push('');
  lines.push('手动一次性步骤(需浏览器/GitHub OAuth):');
  lines.push('  1) SkillsCat:   npx skillscat login   → 浏览器授权 → npx skillscat submit https://github.com/nodecoda/nodecoda-skill');
  lines.push('  2) agentskill.sh: 打开 https://agentskill.sh/submit → 粘贴 https://github.com/nodecoda/nodecoda-skill → Analyze & Import');
  lines.push('  3) skills.sh:     issue #1970 已提交,等待索引 (通常数小时~数天)');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) { try { main(); } catch (e) { console.error(`[fatal] ${e?.stack ?? e}`); process.exit(1); } }

export function main() {
  const skills = discoverSkills();
  const results = checks(skills);
  const report = buildReport(results, skills);
  const failCount = results.filter((r) => !r.pass).length;

  if (opts.json) {
    console.log(JSON.stringify({
      date: new Date().toISOString(),
      skills,
      checks: results,
      ok: failCount === 0,
    }, null, 2));
  } else {
    console.log(report);
  }
  if (opts.check && failCount > 0) process.exit(1);
}
