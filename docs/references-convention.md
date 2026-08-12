# References 目录规范 — nodecoda-workflow skill

本文定义 `skills/nodecoda-workflow/references/` 的文件清单、格式模板与维护规则。
它是该目录的权威索引；manifest.json 的 `references` 字段必须与磁盘文件一一对应
（`scripts/validate-skill.mjs` 校验）。

## 1. 放什么（5 类 12 文件）

| 类别 | 文件 | 职能 | 维护方式 |
|---|---|---|---|
| A. 语言规范 | `grammar-reference.md` | EBNF 文法（用户面向陈述） | 跟随主仓库 `lang/docs/dify-dsl.y` + `parser.py` 重提炼 |
| A. 语言规范 | `language-reference.md` | 编程参考（场景化教学） | 手工维护，与文法一致 |
| A. 语言规范 | `target-capabilities.md` | 目标 profile 能力分类 | 随目标平台升级更新 |
| B. 协议契约 | `mcp-contract.md` | MCP 工具签名/输入输出 | 随 mcp-core.mjs 变更 |
| B. 协议契约 | `public-service.md` | 公共部署 REST/认证/健康 | 随部署变更 |
| C. 流程 | `project-workflow.md` | 项目模式状态机 | 随 cli project 变更 |
| C. 流程 | `iteration-loop.md` | 诊断→修复迭代循环 | 随产品实践更新 |
| C. 流程 | `source-generation.md` | 源码生成原则 | 随实践更新 |
| D. 诊断 | `diagnostics.md` | 诊断 code 理论分类 | 随编译器更新 |
| D. 诊断 | `diagnostics-map.md` | 实证 code→修复映射 | **每个新 Build 诊断回写** |
| D. 诊断 | `failure-modes.md` | 系统性失败模式 | 随实践更新 |
| D. 诊断 | `gotchas.md` | 反模式清单（实证） | **每个新反模式回写** |
| E. 索引 | `README.md` | 目录索引 + 分类 + 维护规则 | 随目录变更 |

## 2. 格式模板（每份文件统一）

### 2.1 头部
```markdown
# <职能> — NodeCoda Workflow Language
（一句用途：agent 据此判断是否相关）
```

### 2.2 来源/实证声明（标题下第一 blockquote，二选一或都写）
```markdown
> **源真理 = `docs/dify-dsl.y`**（主仓库规范文法）。本文是该规范的用户面向陈述；如与规范不一致，以规范为准。
```
```markdown
> 全部来自**真实 Build 诊断**实证(YYYY-MM-DD)。每条:现象 → 原因 → 正确写法；与最新 Build 不符时以 Build 为准并回写本文。
```

### 2.3 正文
- 表格优先：`| code | 原文 | 原因 | 修复动作 |` 或 `| 语法域 | 规范 | 实现 |`
- 代码块：EBNF 用 ```ebnf；源码示例用 ```nodecoda

### 2.4 尾部（文法类必带源码对照表）
```markdown
## 源码对照
| 语法域 | 规范 | 实现 |
|---|---|---|
| 全量文法 | `docs/dify-dsl.y` | `src/nclang/lang/parser.py` |
| 语义限制 | dify-dsl.y 末尾注释段 | `lang/passes/*` |
| 关键字表 | docs/dify-dsl.y | `src/nclang/lang/tokens.py` |
```

## 3. 维护规则
1. **文法类**：主仓库 `dify-dsl.y` / `parser.py` 变更 → 重提炼 `grammar-reference.md`；`language-reference.md` 随之核对。
2. **实证类**：真实 Build 出现未记录诊断码 → 回写 `diagnostics-map.md`（code→原文→修复）与 `gotchas.md`（现象→原因→正确写法）。
3. **契约类**：`mcp-core.mjs` / 部署变更 → 同步 `mcp-contract.md` / `public-service.md`。
4. **索引**：增删文件时同步 `README.md` 与 manifest.json `references`。
5. **校验**：`node scripts/validate-skill.mjs` 必须通过（含 manifest references 与磁盘文件一致性）。

## 4. 语言包（machine-readable，`../language-pack/`）

`references/*.md` 面向人读；`skills/<skill>/language-pack/` 是其**同源结构化数据**，
面向 agent 检索与程序校验。二者必须保持版本一致。

### 4.1 目录结构

```text
skills/nodecoda-workflow/language-pack/
  version.json                      # language/pack_version/source_docs/hashes/source_hashes
  grammar.ebnf                      # 带 [feature] 标签的 EBNF
  builtins.json                     # 内置函数签名/效应/输出字段/retry 支持
  diagnostics.json                  # 诊断分类（L1-L4）+ 实证 code→修复
  targets/dify-1.16-graphon-0.6.json# 能力矩阵 supported/partial/unsupported + capability gate
  antipatterns.json                 # G1-G8 反模式（id/codes/symptom/cause/correct）
```

### 4.2 数据来源（每份文件对应 source_docs）

| 语言包文件 | 来源 references 文档 |
|---|---|
| `grammar.ebnf` | `grammar-reference.md` |
| `builtins.json` | `language-reference.md` §8、`target-capabilities.md` |
| `diagnostics.json` | `diagnostics.md`、`diagnostics-map.md` |
| `targets/dify-1.16-graphon-0.6.json` | `target-capabilities.md` |
| `antipatterns.json` | `gotchas.md` |

### 4.3 格式与 hash 规则

- JSON 文件 hash = **递归排序键**后 compact 序列化的 sha256（与编译器侧 Python
  `json.dumps(sort_keys=True, separators=(',',':'))` 同算法，跨语言一致）；
- `grammar.ebnf` hash = 原始文本 sha256；
- `source_hashes` = 每个 source_doc 原文 sha256，用于**版本漂移检测**：
  任一源文档变更而未重生成语言包时，`validate-language-pack.mjs` 必须报错。

### 4.4 维护规则

1. 修改 `references/` 中任一 source_doc → **必须同步重提取语言包并重算 version.json**；
2. 新增诊断码/反模式 → 同时回写 `diagnostics-map.md`/`gotchas.md` 与
   `diagnostics.json`/`antipatterns.json`；
3. 目标能力变更 → 同步 `target-capabilities.md` 与 `targets/*.json`；
4. 校验：`node scripts/validate-language-pack.mjs`（`npm run validate` 已包含），
   回归：`node scripts/test-language-pack.mjs`（含漂移检测用例）。
