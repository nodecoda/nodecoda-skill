# Design - Customer Support Workflow

## 用途
把用户的客服问题发给 LLM，返回简洁的专业回答。

## 输入/输出
- 输入：`query`（string，用户问题）
- 输出：`string`，模型回答

## 模式与依赖
- 模式：`workflow`（单次请求-响应）
- 依赖：`openai_api_compatible` 提供方（示例占位，生产前替换为真实 provider）

## 边界与异常
- 不做多轮对话（如需会话改用 advanced-chat）
- LLM 失败时返回固定兜底文案（示例中省略，生产实现需补）
