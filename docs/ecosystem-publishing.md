# 生态同步发布指南

本仓库的 Skill（`skills/nodecoda-workflow`）如何进入主流 Agent Skill 生态，
以及如何确保被聚合平台**自动抓取**。所有平台行为均为 2026-08-15 实测核实。

## 平台机制总览

| 平台 | 收录方式 | 是否需要人工提交 | 当前状态 |
|---|---|---|---|
| [skills.sh](https://skills.sh) (Vercel) | 半自动：首次 `npx skills add <owner>/<repo>` 产生**安装遥测**触发收录；`skills.sh.json` 元数据辅助分组；可在 [vercel-labs/skills](https://github.com/vercel-labs/skills) 提索引请求 issue | 首次需遥测触发（已满足）+ 一次性 issue | ✅ 遥测已注册，issue #1970 已提交 |
| [SkillsMP](https://skillsmp.com) | **纯爬虫**：爬取公开 GitHub 上的全部 `SKILL.md`（自称 2M+），无提交入口 | 否 | ⏳ 等爬虫周期收录 |
| [SkillsCat](https://skills.cat) | 自动爬（GitHub Events cron + Code Search `filename:SKILL.md`）+ 手动 `npx skillscat submit <repo-url>` 加速 | 建议手动加速（需 GitHub OAuth 一次） | ⏳ 未收录，待提交 |
| [agentskill.sh](https://agentskill.sh) | 仅 Web 表单：粘贴 repo URL → Analyze & Import + 安全扫描 | 是 | ⏳ 待手动提交 |
| [ClawHub/OpenClaw](https://clawhub.ai) | 提交制：`clawhub skill publish` 或 web 从 GitHub 导入 | 是 | 可选 |
| [SkillsPAI](https://www.npmjs.com/package/skillspai) | **未上线**：skillspai.com 不可达、GitHub 仓库 404，仅 npm 早期包 + 本地 localhost registry | 暂不可用 | 预留 |
| SkillHub.cn (iflytek) | 已有独立链路（`scripts/publish-skillhub.mjs`） | 是（走既有流程） | ✅ 已接入 |

## 核心结论：如何保证被自动抓取

1. **公开 repo + 标准结构**（已满足）：`skills/<name>/SKILL.md`，frontmatter 含
   `name` + `description`——这是 skills.sh / SkillsMP / SkillsCat 的最低要求。
2. **skills.sh 不是纯自索引**：必须先有人用 `npx skills` CLI 安装过产生遥测，
   目录才看得到。已通过 `npx skills add nodecoda/nodecoda-skill --list` 验证并注册遥测。
3. **`skills.sh.json`**（本仓库根目录）：提供目录分组/描述元数据，索引后展示更完整。
4. **GitHub topics**：帮助 SkillsMP 等爬虫分类与搜索（见下方一次性步骤）。
5. **SkillsMP / SkillsCat 无需白名单**：公开 repo + SKILL.md 即会被爬虫收录，
   只是存在各自爬虫周期延迟；手动提交只是加速。

## 一次性手动步骤（需要浏览器 / GitHub OAuth）

```bash
# 1) SkillsCat — 登录后提交 repo（加速收录）
npx skillscat login          # 浏览器授权
npx skillscat submit https://github.com/nodecoda/nodecoda-skill
npx skillscat search nodecoda   # 验证收录

# 2) agentskill.sh — Web 表单
#    打开 https://agentskill.sh/submit
#    粘贴 https://github.com/nodecoda/nodecoda-skill → Analyze & Import

# 3) skills.sh — 已提交 issue #1970，等待索引（数小时~数天）
#    收录后徽章: https://skills.sh/b/nodecoda/nodecoda-skill

# 4) GitHub topics（一次性）
gh api -X PUT repos/nodecoda/nodecoda-skill/topics \
  -H "Accept: application/vnd.github+json" \
  -f names='nodecoda,dify,mcp,agent-skills,skill,claude-code,codex,cursor,workflow,ai-agents'

# 5) ClawHub/OpenClaw（可选）
node scripts/build-skillhub.mjs --zip   # 复用白名单构建产物
npx clawhub skill publish ./build/skillhub/nodecoda-workflow --slug nodecoda-workflow
```

## 自动化：发布前就绪检查

```bash
node scripts/publish-ecosystems.mjs        # 检查 + 打印各平台同步清单
node scripts/publish-ecosystems.mjs --check  # 仅检查（CI 用，失败退出码 1）
node scripts/publish-ecosystems.mjs --json   # JSON 输出
```

检查项：

- 每个 `skills/*/SKILL.md` frontmatter 含 `name` + `description`（所有爬虫的最低要求）
- `manifest.json` 存在且 `version` 与 `package.json` 对齐
- 根目录 `skills.sh.json` 存在、`$schema` 正确、`groupings` 引用的 skill 都存在

已在 `.github/workflows/release.yml` 接入：每次 tag 发布后自动跑 `--check`，
并打印同步清单到日志，防止发布时元数据悄悄失效。

## 维护纪律

- **repo 是唯一真相源**：`skills.sh.json` 只在新增/删除 skill 或调整分组时改动；
  不要为同步各平台而维护第二份 skill 目录。
- **版本**：manifest/package 版本对齐由 `--check` 强制，发布走既有 tag 流程
  （`git tag vX.Y.Z && git push origin vX.Y.Z`）。
- **SkillsPAI**：目前未上线。若其 registry 上线，补充 `skillspai publish` 调用即可，
  本仓库结构（SKILL.md + manifest.json）已满足其解析要求。
- 收录后如需改名/迁移 repo，先在 skills.sh 提 issue 说明（避免统计分裂），
  见 https://community.vercel.com/t/44376。
