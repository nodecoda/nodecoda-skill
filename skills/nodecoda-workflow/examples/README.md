# Examples

最小可运行的 `.ncoda` 示例,展示每种核心模式。所有示例都按 `dify-1.16-graphon-0.6` target profile 编写。

| 文件 | 模式 | 关键构造 |
|------|------|----------|
| `01-hello-workflow.ncoda` | workflow 最小化 | `function main` + `return` |
| `02-with-llm.ncoda` | 经典 LLM 调用 | `llm(model, { messages })` + `const` |
| `03-parallel-branches.ncoda` | 命名并行 | `parallel { name: { yield } }` + 结果汇总 |
| `04-code-node.ncoda` | Python FFI | `foreign code python3(...)` + 多输出结构体 |

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
3. 不引入构造不在这 4 个示例里的写法(除非有明确需求且查过 `language-reference.md`)

## 后续添加

按需补充更多模式:
- 条件分支 + 多输出
- 工具调用
- HTTP + LLM 链
- 多轮对话 (`@mode advanced-chat`)
- 知识库检索
- 结构化抽取
- 错误处理 (`attempt` / `with retry`)
- 会话变量
