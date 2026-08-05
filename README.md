# PanPilot

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区。当前已实现无工具调用的聊天生成，以及尚未接入 Agent Loop 的安全工具层；流式输出、完整工具调用、记忆与规划保留为后续能力。

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

旧的 `{"message":"你好"}` 请求仍然兼容。`stream: true` 当前返回明确的
`501 CAPABILITY_NOT_IMPLEMENTED`，不会伪装成流式生成。

## 聊天内容日志

设置 `PAN_PILOT_LOG_CHAT_CONTENT=true` 后，PanPilot 会写入两类结构化日志：

- `pan_pilot.chat.prompt`：实际发送给模型的完整 `messages`，包括人设、关系上下文和聊天历史。
- `pan_pilot.chat.reply`：模型回复正文、模型名、Token 数量和调用耗时。

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
序列化检查。模型协议已经支持工具定义、工具请求和工具结果消息，但注册表尚未
接入 `ChatAgent` 的循环，所以对外能力声明中的 `tools` 仍为 `reserved`，
`POST /v1/chat` 也不会执行工具。

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
