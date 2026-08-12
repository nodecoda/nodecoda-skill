# 安装与接线指南

> 让 `nodecoda-workflow` skill 在你的代理里跑起来，顺便把 NodeCoda MCP 服务接好。
> 30 秒入门版在 [README](../README.zh-CN.md)；这里是每个代理的完整细节。

## 支持哪些代理？

任何遵循 **Claude Code skill 约定**的代理都能装。默认路径如下：

| 代理 | 默认 skill 路径 | 备注 |
|---|---|---|
| **Claude Code** | `~/.claude/skills/nodecoda-workflow/` | 或项目级 `<project>/.claude/skills/nodecoda-workflow/` |
| **Codex CLI** | `.codex/skills/nodecoda-workflow/` | 项目级，和 AGENTS.md 放一起 |
| **Gemini CLI** | `~/.gemini/skills/nodecoda-workflow/` | （假定路径；以 `gemini --help` 为准） |
| **Cursor** | `.cursor/rules/nodecoda.mdc` | Cursor 不直接读 `SKILL.md`——见下文"Cursor 特殊情况" |

## 方式 A — npx 一条命令（推荐）

```bash
npx -y @nodecoda/skill add nodecoda-workflow
```

CLI（`nodecoda-skill`，发布为 `@nodecoda/skill`）会自动识别当前代理的 skill 目录并复制过去，**并自动注册 `nodecoda` MCP server**（v0.2.10+）：

- **Claude Code**：执行 `claude mcp add nodecoda --scope user -- npx -y @nodecoda/skill mcp`（写 `~/.claude.json`，全局生效）
- **Codex**：向 `~/.codex/config.toml` 追加 `[mcp_servers.nodecoda]`（`command = "npx"`，零安装）
- **Gemini CLI**：向 `~/.gemini/settings.json` 合并 `mcpServers.nodecoda`
- **Cursor**：向 `.cursor/mcp.json` 合并 `mcpServers.nodecoda`

装完 agent 直接拥有 `build_dify_workflow` / `get_workflow_build` / `cancel_workflow_build` 三个工具，无需任何手动接线。MCP 注册是幂等的（已注册就跳过）且**绝不阻断安装**——失败只打警告并给出手动命令。

指定目标的写法：

```bash
npx -y @nodecoda/skill add nodecoda-workflow              # 自动：探测当前代理（见下）
npx -y @nodecoda/skill add nodecoda-workflow codex        # 用户级：~/.codex/skills + config.toml
npx -y @nodecoda/skill add nodecoda-workflow claude-code  # 用户级：~/.claude/skills + claude mcp add
npx -y @nodecoda/skill add nodecoda-workflow cursor       # 生成 .cursor/rules/*.mdc + .cursor/mcp.json
npx -y @nodecoda/skill add nodecoda-workflow ~/.claude/skills   # 显式指定目录
npx -y @nodecoda/skill mcp-register <target>              # 只注册/修复 MCP，不重装 skill
npx -y @nodecoda/skill list / info / validate             # 查看与自检
```

`install` 是 `add` 的别名。平台差异已处理：Codex / Claude Code / Gemini CLI 走 `SKILL.md` 搜索目录；**Cursor 是例外**——它读不了 `SKILL.md`，所以 `add ... cursor`（或自动探测到 Cursor 项目时）会生成一个 `.cursor/rules/nodecoda-workflow.mdc`（YAML frontmatter + 内联 skill 内容）。

**不带目标的 `add` 按这个顺序探测平台与层级：**
1. 调用 CLI 的代理会话（`CODEX_HOME` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_HOME` / `GEMINI_CACHE_DIR`）→ **用户级**（装到 `~/.claude/skills` 等，全局生效）
2. 当前项目里已配置的代理（存在 `.codex/`、`.claude/`、`.gemini/`、`.cursor/` 目录）→ **项目级**（`<项目>/.claude/skills`，MCP 也按项目 scope 注册）
3. 主目录里配置过的代理 → **用户级**
4. 兜底：Codex，用户级（`~/.codex/skills`）

显式给平台名（如 `add ... codex`）一律装到**用户级**；给目录则精确落到该目录。装完记得**重启代理**，让它加载新 skill 并连上 MCP server。

## 方式 B — git clone 手动装（不用 CLI）

```bash
# 挑一个符合你代理的路径
DEST=~/.claude/skills/nodecoda-workflow
git clone --depth 1 https://github.com/nodecoda/nodecoda-skill.git /tmp/nodecoda-skill
cp -R /tmp/nodecoda-skill/skills/nodecoda-workflow "$DEST"
rm -rf /tmp/nodecoda-skill
```

验证：

```bash
ls "$DEST"      # 应该能看到 SKILL.md、manifest.json、references/、examples/
```

## 接 MCP

> v0.2.10+ 的 `add`/`install` **已自动完成接线**（见上表），这一节留给手动配置 / 自定义端点 / 排障。

### Codex CLI 的接线

本仓库自带 `.codex/config.example.toml` 模板。**首选**是公网 Streamable HTTP 端点（`https://www.nodecoda.com/mcp`），Key 从 `NODECODA_KEY` 环境变量读取——永远不落盘：

```bash
cp .codex/config.example.toml .codex/config.toml
export NODECODA_KEY=sk-...   # 加到你的 shell profile
```

**零安装替代**（不 clone、不本地 npm install）——让 Codex 每次会话按需拉取：

```toml
[mcp_servers.nodecoda]
command = "npx"
args = ["-y", "@nodecoda/skill", "mcp"]
enabled = true
```

npm 包通过 `nodecoda-skill mcp` 提供 MCP（`--http [--port N]` 切 Streamable HTTP 传输；需要 npm registry 上的 v0.2.0+；Key 在请求时从 `NODECODA_KEY` 读取）。

公网 `/mcp` 路由已上线（2026-08-12 实测通过）。注意：OAuth metadata 端点还没开，所以用 `NODECODA_KEY` 而不是 `codex mcp login`；Key 必须存在于后端数据库。

自托管 / 本地开发，用模板里注释掉的替代方案之一：

- **本地 HTTP server**：`command = "node"`，`args = ["scripts/mcp-http-server.mjs", "--port", "4001"]`
- **本地 dev stack**：`url = "http://127.0.0.1:8000/mcp"` + `http_headers`
- **stdio bridge**：`command = "node"`，`args = ["scripts/mcp-stdio-server.mjs"]`

`.codex/config.toml` 是 gitignored 的（本地 dev 变体可能含真实 Key）。skill 本体装在 `.codex/skills/nodecoda-workflow/`（同样本地、gitignored）：

```bash
cp -R skills/nodecoda-workflow .codex/skills/
```

## Cursor 特殊情况

Cursor 读 `.cursor/rules/*.mdc`，不读 `SKILL.md`。`npx ... add ... cursor` 会自动生成 `.mdc`；想手动建也可以：

```bash
# 一次性设置
mkdir -p .cursor/rules
curl -L https://raw.githubusercontent.com/nodecoda/nodecoda-skill/main/skills/nodecoda-workflow/SKILL.md \
  -o .cursor/rules/nodecoda-workflow.mdc
```

`.mdc` 只是带 frontmatter 的 markdown 包装，Cursor 会把它当规则对待。

## 装完怎么验证

装好之后，直接问代理：

> "用 NodeCoda 写一个最小工作流，接受字符串输入并原样返回。"

装对了，它应该产出一个以 `@language nodecoda/1` 开头、用 `function main(...) -> string { return ... }` 的 `.ncoda` 文件——不用你多解释一句。

如果代理不知道 `build_dify_workflow`，说明没装好：检查 `SKILL.md` 是否在安装路径的**顶层**（别嵌套）。

## 版本与升级

skill 和 NodeCoda core **独立版本化**。查兼容性：

```bash
cat ~/.claude/skills/nodecoda-workflow/manifest.json | grep -E 'min_nodecoda|target_profile'
```

如果 NodeCoda 版本低于 `min_nodecoda`，skill 的 MCP 契约可能和你 MCP server 说的对不上。升级 NodeCoda，或把 skill 钉到旧版本：

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/nodecoda/nodecoda-skill.git
cp -R nodecoda-skill/skills/nodecoda-workflow ~/.claude/skills/
```

## 卸载

```bash
rm -rf ~/.claude/skills/nodecoda-workflow    # Claude Code
rm -rf .codex/skills/nodecoda-workflow        # Codex
rm -f  .cursor/rules/nodecoda-workflow.mdc    # Cursor

# 顺手移除自动注册的 MCP server（可选）
claude mcp remove nodecoda                    # Claude Code
# Codex: 删掉 ~/.codex/config.toml 里的 [mcp_servers.nodecoda] 段
```

重启代理，清掉缓存的上下文。

## Python（pip / uv）通道——暂缓

Python 分发通道**故意不发布**：npm 包已经覆盖所有主流代理（它们都通过 `npx` 拉起 MCP server 或 skill 安装器，不需要 Python 运行时）。等出现真正的纯 Python 消费方，再补 `pyproject.toml` + PyPI 发布。
