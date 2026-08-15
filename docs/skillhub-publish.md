# SkillHub.cn 发布流程

SkillHub.cn（协议见 iflytek/skillhub `docs/07-skill-protocol.md`）在发布时对技能包做
**文件类型白名单过滤**：

```
.md .txt .json .yaml .yml .js .cjs .mjs .ts .py .sh .png .jpg .svg
```

不在白名单内的文件（如 `examples/*.ncoda`、`language-pack/grammar.ebnf`）会被服务端
静默丢弃，导致 `manifest.json` / `language-pack/version.json` 出现悬空引用。因此不能
直接把仓库 skill 目录原样上传，必须使用构建脚本生成自洽的发布包。

## 构建发布包

```bash
# 默认输出: build/skillhub/nodecoda-workflow/ (已在 .gitignore 中)
node scripts/build-skillhub.mjs

# 同时生成 .zip (store 模式, 零依赖)
node scripts/build-skillhub.mjs --zip

# 直接重建指定上传目录(例如已有的发布目录)
node scripts/build-skillhub.mjs --out /home/dev/nodecoda-workflow-1.0.0

# 不清理已有输出目录
node scripts/build-skillhub.mjs --keep
```

脚本做的事：

1. **白名单拷贝** — 只复制白名单扩展名文件，丢弃 `.ncoda`、`.ebnf`
2. **示例镜像** — 每个 `examples/*.ncoda` 生成 `examples/<name>.md`（原文包裹在
   ` ```ncoda ` 代码块中），`examples/README.md` 追加镜像说明与还原指引
3. **manifest 重写** — `examples` 字段指向镜像 `.md`，附加 `x-skillhub-build`
   溯源信息（工具名、源 commit、生成时间）
4. **version.json 重写** — 移除 `grammar.ebnf` 的 hash，其余 hash 按实际文件重算，
   `source_docs`/`source_hashes` 重新对齐
5. **自校验** — 白名单纯净、文件数 ≤100、单文件 ≤1MB、总大小 ≤10MB、
   manifest/version.json 全部引用存在且 hash 匹配

## 发布

1. 构建并确认输出（`--zip` 产物可之间上传；也可用官方 CLI：
   `npx clawhub publish ./build/skillhub/nodecoda-workflow`）
2. 上传到 skillhub.cn（Web UI 选目录或 zip）
3. 平台会在包内写入 `_meta.json`（ownerId/publishedAt/slug/version）——这是平台
   私有元数据，不影响下次构建（构建时忽略 `_meta.json`）

## 纪律

- **repo 是唯一真相源**：不要手工维护第二个 skill 目录（会导致版本漂移，如
  0.2.19 已发布而 repo 已到 0.2.20 的情况）
- **每次发布前从最新 commit 构建**：skillhub 版本不可变，只能发新版本
- 版本号以 `skills/*/manifest.json` 的 `version` 为准；平台侧版本（`_meta.json`）
  独立递增，两者不需强行相等

## 已知限制

- `references/*.md` 与 `SKILL.md` 中的 `.ncoda` 概念引用（语言身份的一部分）原样
  保留；只有实际文件缺失，示例内容由 `.md` 镜像与 `examples/README.md` 表格覆盖
- `grammar.ebnf` 被白名单排除，`references/grammar-reference.md`（.md）承担语法
  文档职责
