# Examples

最小可运行的 `.ncoda` 示例,展示每种核心模式。所有示例都按 `dify-1.16-graphon-0.6` target profile 编写。

| 文件 | 模式 | 关键构造 |
|------|------|----------|
| `01-hello-workflow.ncoda` | workflow 最小化 | `function main` + `return` |
| `02-with-llm.ncoda` | 经典 LLM 调用 | `llm(model, { messages })` + `const` |
| `03-parallel-branches.ncoda` | 命名并行 | `parallel { name: { yield } }` + 结果汇总 |
| `04-code-node.ncoda` | Python FFI | `foreign code python3(...)` + 多输出结构体 |
| `05-conditional-output.ncoda` | 条件分支 + 多输出 | `if / else if / else` + `output("key", value)` |
| `06-error-handling.ncoda` | 错误处理 | `attempt/success/failure` + `with retry/timeout` |
| `07-structured-extract.ncoda` | 结构化抽取 | `extract<T>` + 具名 record + 三元表达式 |
| `08-tool-and-http.ncoda` | 工具 + HTTP + LLM 链 | `tool()` + `http()` + 模板字符串 |

## 用法

### 直接 build

把任一文件保存为 `.ncoda`,调 `build_dify_workflow`:

```json
{
  "source": "<文件内容>",
  "source_filename": "01-hello-workflow.ncoda",
  "language_identity": "nodecoda/1",
  "target_profile": "dify-1.16-graphon-0.6",
  "idempotency_key": "example-01-build-1"
}
```

### 作为 skill agent 的写作模板

> "请按 `examples/02-with-llm.ncoda` 的风格帮我写一个工作流,做 X"。

agent 应当:
1. 复制对应文件作为骨架
2. 只改 `main` 函数体
3. 不引入构造不在示例集里的写法(除非有明确需求且查过 `language-reference.md`)

> 新增/修改示例文件必须通过 `node scripts/validate-examples.mjs`(结构化语法门)
> 与 `node scripts/test-contract.mjs`(manifest/MCP 契约)。完整语法合法性以真实
> Build pipeline 为准(e2e 冒烟见 `.github/workflows/e2e.yml`)。

## 后续添加

按需补充更多模式:
- 多轮对话 (`@mode advanced-chat` + `answer()`)
- 知识库检索 (`knowledge()` + `extract_text()` + `file<>` 类型)
- 会话变量 (`@conversation`)
- 循环与集合操作 (`for` + `split`/`filter`/`take`)
- `parallel for` 并发控制
- `enum` 声明与 `file<>` 文件类型
