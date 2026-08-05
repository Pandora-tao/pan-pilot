# PanPilot

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区。当前已实现带工具循环和 SSE 流式输出的聊天生成（白名单工具、最大轮次控制、取消信号）；记忆与规划保留为后续能力。

## 环境

- Node.js 22+
- pnpm 10.33.2

## 目录

```text
src/
├── index.ts       # 服务入口，目前仅提供健康检查
├── agent/         # Agent Loop 与会话控制
├── model/         # DeepSeek、MiMo 等模型适配
└── tools/         # 安全工具定义、注册、校验与执行
test/              # 测试
```

## 开始使用

```bash
cp .env.example .env
pnpm install
pnpm dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

能力声明：

```bash
curl -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/capabilities
```

聊天接口接受完整的 `system`、`user`、`assistant` 消息历史，以便调用方继续
管理人设、会话和业务上下文：

```bash
curl -X POST http://127.0.0.1:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  --data '{"messages":[{"role":"user","content":"你好"}],"stream":false}'
```

旧的 `{"message":"你好"}` 请求仍然兼容。`stream: true` 返回
`text/event-stream`，每个事件是一行 `data: {json}`，`type` 字段区分事件：

- `{"type":"content","content":"文本增量"}`：模型正文逐段生成。
- `{"type":"tool_execution","execution":{"id","name","status"}}`：单次工具执行摘要。
- `{"type":"done","result":{...}}`：整轮结束，结构与非流式响应一致（含 model、usage、steps、toolExecutions）。
- `{"type":"error","error":"CHAT_FAILED","message":"Agent 调用失败"}`：流建立后发生的失败；客户端断开时流直接终止，不再发送事件。

流式响应同样只回传工具执行摘要，不回传原始参数和工具结果。`stream: true`
时客户端断开会中止模型调用和工具执行（通过 `AbortSignal` 传递）。

## 聊天内容日志

设置 `PAN_PILOT_LOG_CHAT_CONTENT=true` 后，PanPilot 会写入两类结构化日志：

- `pan_pilot.chat.prompt`：实际发送给模型的完整 `messages`，包括人设、关系上下文和聊天历史。
- `pan_pilot.chat.reply`：模型回复正文、模型名、Token 数量、调用步数、工具执行摘要和调用耗时。

该开关默认关闭。提示词和回复可能包含账号信息、关系上下文及其他隐私数据，
只应在访问受控且有明确保留周期的环境启用，不能把日志提交到 Git。

systemd 环境可使用以下命令查看：

```bash
journalctl -u pan-pilot-test -f -o cat
journalctl -u pan-pilot-test --since "30 minutes ago" -o cat \
  | grep 'pan_pilot.chat.prompt\|pan_pilot.chat.reply'
```

如果部署环境的系统 DNS 会把 DeepSeek 解析到不可达地址，可只为 PanPilot
设置 `DEEPSEEK_RESOLVED_ADDRESS`。该覆盖不会修改主机的全局 DNS。

## 安全工具层

`src/tools/` 已提供工具契约、白名单注册表，以及两个只读工具：

- `get_current_time`：读取指定 IANA 时区的当前时间，默认使用 UTC。
- `calculator`：只执行参数受限的加、减、乘、除，不解析表达式或使用 `eval`。

注册表统一处理 Zod 参数校验、未知/重复工具、取消信号、执行异常和结果 JSON
序列化检查。`ChatAgent` 已接入工具循环：每轮向模型暴露注册表定义，收到工具
请求就执行并把结果回填给模型，直到模型产出最终正文；`maxSteps` 控制最大轮次，
`AbortSignal` 支持取消。对外能力声明中的 `tools` 已标记为 `available`，
`POST /v1/chat` 会执行工具，但 HTTP 响应（含流式事件）只返回执行摘要
（`id`、`name`、`status`），不回传原始参数和工具结果——未来工具的参数与返回
可能包含敏感数据。

## 验证与构建

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

编译结果输出到 `dist/`。生产环境通过环境变量注入 API Key，不要将 `.env` 或密钥提交到仓库。

## 建议实现顺序

1. 在 `src/model/` 完成单个模型的非流式调用。
2. 在 `src/tools/` 实现 2～3 个参数受限的只读工具。
3. 在 `src/agent/` 完成单 Agent 工具循环和最大轮次控制。
4. 为工具参数校验、异常和循环终止补充测试。
5. 最后再增加 SSE、权限确认、持久化和 Java 服务调用。

前 4 步和 SSE 流式输出已完成；下一步是权限确认、持久化和 Java 服务调用。
