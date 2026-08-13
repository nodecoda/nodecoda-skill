# Gotchas / 反模式清单 — NodeCoda Workflow Language

> 全部来自**真实 Build 诊断**实证(2026-08-12)。每条:现象 → 原因 → 正确写法。这些是文档里不明显、但编译器强制执行的硬约束。遇到类似报错先查这里。

## G1. `@conversation` 声明顺序 — SYNTAX_ERROR
- **现象**:`Expected declaration, got AT_CONVERSATION ('@conversation')`
- **原因**:解析器把 `@conversation` 当顶层声明,要求它位于 `const`/`type`/`function` 之前。放在 `const MODEL` 之后即报错。
- **正确写法**:`@conversation` 全部紧跟在 `@mode` 之后,`const` 之前。
  ```nodecoda
  @mode advanced-chat
  @conversation string content = "";
  const MODEL = "...";
  ```

## G2. 文件变量没有 `.text` 字段 — FIELD_NOT_FOUND
- **现象**:`Field 'text' not found on file type. Available fields: name, filename, extension, mime_type, size, type, transfer_method, url, remote_url, related_id`
- **原因**:`file<>` 变量只暴露元数据字段,不直接提供文本内容。
- **正确写法**:用 `extract_text(doc)` 内置函数提取,再取 `.text`:
  ```nodecoda
  let extracted = extract_text(doc);
  return extracted.text;
  ```

## G3. `extract_text` 要求声明可提取扩展名 — TARGET_NOT_LOWERABLE
- **现象**:`extract_text requires a selector-backed scalar file with a declared extractable extension`
- **原因**:只有文件类型声明了可提取扩展名,才能下降为 document-extractor 节点。
- **正确写法**:`file<document; .pdf>`(可多扩展名 `file<document; .pdf, .md, .txt>`)。
  ```nodecoda
  function main(file<document; .pdf> doc) -> string { ... }
  ```

## G4. 会话变量赋值只支持标量字面量 — TARGET_NOT_LOWERABLE
- **现象**:`conversation variable set operation only supports scalar literal values`
- **原因**:`@conversation` 变量在运行期只能写标量字面量,不能存动态计算值。
- **正确写法**:只存字面量标记(`first_done = true`);动态数据(如提取的文本)靠 LLM 对话记忆或 Dify 端处理,别塞会话变量。
  ```nodecoda
  @conversation bool first_done = false;
  // first_done = true;            // OK
  // content = extracted.text;     // 非法
  ```

## G5. `@conversation` 默认值仅限字面量
- **现象**:默认值若不是字面量会报错。
- **原因**:target 要求会话变量默认值是常量。
- **正确写法**:默认值写死:`@conversation string content = "";`(不能 `= someExpr`)。

## G6. 文件直传 LLM 不被接受 — TYPE_MISMATCH
- **现象**:`Map value has incompatible type Type(file); expected Type(string)`
- **原因**:LLM 的 `content` 字段要 string;把整个 `file` 变量当 user 消息传进去不行。
- **正确写法**:先 `extract_text` 变成 string,再喂给 LLM。

## G7. 构建入口 / 工具 base 路径
- **现象**:`/api/v1/workflow-builds` 返回 `401 INVALID_TOKEN`;`save-build.mjs` 配 `.../v1` 会拼出 `/v1/v1/...` 404。
- **原因**:两套 base——admin `/api/v1`(登录/key)与 MCP gateway `/v1`(build/poll/cancel);`sk-` key 走 `/v1`。`save-build.mjs` 内部已含 `/v1`,base 传宿主根。
- **正确写法**:构建 `POST https://www.nodecoda.com/v1/workflow-builds`;`NODECODA_API_BASE=https://www.nodecoda.com`。

## G8. 变量名避开保留字
- **现象**:用 `code`/`source`/`answer`/`limit` 等当变量名会撞保留字。
- **原因**:§7 保留字表(见 `grammar-reference.md`)。
- **正确写法**:换名,如 `result`/`content`。(保留字全表见 grammar-reference §7)

## G9. 操作策略支持矩阵（白名单实证）
- **白名单来源**:主仓 `lang/src/nclang/lang/operation_registry.py`（`OperationPolicySupport`）+
  真实 Build 实证。违反白名单报 `OPERATION_POLICY`。

| 操作 | retry | timeout | default | failure_branch(attempt) |
|------|:---:|:---:|:---:|:---:|
| `llm` | ✓ | ✗ | ✓ | ✓ |
| `http` | ✓ | ✓ | ✓ | ✓ |
| `tool` | ✓ | ✗ | ✗ | ✓ |
| `knowledge` / `extract_text` / `classify` | ✗ | ✗ | ✗ | ✗ |
| `extract<T>` | ✗（E1045） | ✗ | ✗ | ✓ |

- **实证现象**:`Operation 'llm' does not support timeout`（OPERATION_POLICY，2026-08-13 e2e）。
- **正确写法**:
  - llm 要兜底:`with default(...)` 合法;要超时:别写 `timeout`,用 `attempt` 包装或 Dify 端配置。
  - http 超时:`with timeout(30s)` 合法(主仓单测 `test_http_timeout_and_default_policies_serialize`)。
  - `attempt` + `default` 冲突:`attempt ... with default(...) as x` 会被拒
    （`default policy cannot be combined with an explicit failure branch`）。
  - `retry(max: N)` 必须 N ≥ 1,且同调用不能重复 `retry`。

## 排查顺序
1. 按 error code 定位到上面某条(不全时配 `diagnostics-map.md`)。
2. 若文档与现象不符 → **先跑最小复现探针**(一个最小文件单向验证),隔离【声明顺序】vs【构造不支持】,别猜。