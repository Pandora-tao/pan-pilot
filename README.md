# PanPilot

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区，提供 Fastify HTTP
服务。当前已实现带工具循环和 SSE 流式输出的聊天生成（白名单工具、最大轮次控制、
取消信号）；记忆与规划保留为后续能力，状态见 `src/agent/capabilities.ts` 的
`reserved` 声明。

## 环境

- Node.js 22+
- pnpm 10.33.2

## 目录

```text
src/
├── index.ts       # 服务入口：读取环境变量、组装应用并监听端口
├── app.ts         # buildApp(options)：依赖注入、鉴权、注册路由，不监听端口
├── routes/        # HTTP 适配层：请求校验、鉴权、状态码、日志
├── agent/         # ChatAgent：工具循环、SSE 流式输出、取消与最大轮次控制
├── model/         # 模型适配端口与 DeepSeek（OpenAI 兼容协议）实现
└── tools/         # 安全工具定义、白名单注册、校验与执行
test/              # Vitest 测试
```

## 开始使用

```bash
cp .env.example .env
pnpm install
pnpm dev
```

## 接口与鉴权

- `GET /health` — 探活；不鉴权、不调用模型。
- `GET /v1/capabilities` — 能力发现，返回当前可用/预留的能力状态。
- `POST /v1/chat` — 聊天接口，支持非流式与 SSE 流式两种响应。

配置了 `PAN_PILOT_API_TOKEN` 后，`/v1/*` 要求请求头
`Authorization: Bearer <token>`（恒定时间比较）；未配置时 `/v1/*` 开放访问。
`/health` 始终公开。

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

网页控制台（单 HTML 文件）：

```bash
open http://127.0.0.1:3000/console
```

页面覆盖三类能力：能力状态（`/v1/capabilities`）、对话（`/v1/chat`，支持 SSE
流式与停止）、Word 文档（`/v1/files` 上传/下载，fileId 可一键填入聊天框）。
连接地址与 Bearer Token 保存在浏览器 localStorage；服务端未配置
`PAN_PILOT_API_TOKEN` 时留空即可。页面代码在 `web/console.html`，无外部依赖。
也可以直接双击打开该文件（file://）：服务端仅对 file:// 与 localhost 来源放行
CORS，其他网页来源不会拿到跨域权限。

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

非流式响应返回 `message`（最终正文）、`model`、`usage` 和
`execution.toolExecutions`（工具执行摘要）。旧的 `{"message":"你好"}` 请求
仍然兼容。请求参数错误返回 400 `INVALID_REQUEST`；非流式调用失败返回 502
`CHAT_FAILED`，内部细节只进服务端日志。

`stream: true` 返回 `text/event-stream`，每个事件是一行 `data: {json}`，
`type` 字段区分事件：

- `{"type":"content","content":"文本增量"}`：模型正文逐段生成。
- `{"type":"tool_execution","execution":{"id","name","status"}}`：单次工具执行摘要。
- `{"type":"done","result":{...}}`：整轮结束，携带与 `chat()` 相同的最终结果
  （content、model、totalTokens、steps、toolExecutions）。
- `{"type":"error","error":"CHAT_FAILED","message":"Agent 调用失败"}`：流建立后
  发生的失败；客户端断开时流直接终止，不再发送事件。

流式响应同样只回传工具执行摘要，不回传原始参数和工具结果。`stream: true`
时客户端断开会中止模型调用和工具执行（通过 `AbortSignal` 传递）。

## 环境变量

完整清单见 `.env.example`，要点：

- `DEEPSEEK_API_KEY`：必填，缺失时 `DeepSeekClient` 构造直接抛错。
- `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`：模型与端点，默认
  `deepseek-v4-flash` / `https://api.deepseek.com`。
- `DEEPSEEK_RESOLVED_ADDRESS`：部署环境的系统 DNS 把 DeepSeek 解析到不可达
  地址时，可只为 PanPilot 覆盖该主机的 DNS 结果；不修改全局 DNS，URL 中的
  域名保留以维持 Host/TLS SNI/证书校验。
- `PAN_PILOT_API_TOKEN`：`/v1/*` 的 Bearer 鉴权令牌。
- `PAN_PILOT_DOCS_DIR`：上传与修改版 docx 的存储目录，默认 `./docs`。
- `PAN_PILOT_LOG_CHAT_CONTENT`：聊天内容日志开关，默认关闭。
- `HOST` / `PORT`：监听地址，默认 `0.0.0.0:3000`。
- `SEARCH_BASE_URL`：搜索端点覆盖，默认 Bing 网页搜索（无需 Key）。
- `MIMO_API_KEY`、`JAVA_SERVICE_URL`：预留，当前代码未使用。

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

## 安全工具层

`src/tools/` 提供工具契约、白名单注册表、两个只读工具、三个 Word
文档工具（见下文「文档上传与编辑」）和一个搜索工具：

- `get_current_time`：读取指定 IANA 时区的当前时间，默认使用 UTC。
- `calculator`：只执行参数受限的加、减、乘、除，不解析表达式或使用 `eval`。
- `web_search`：搜索互联网，返回标题、链接和摘要；默认走 Bing 网页搜索，
  无需 API Key（`SEARCH_BASE_URL` 可覆盖，换 Tavily 等带 Key 服务时实现
  同一个 `SearchClient` 接口即可）。

注册表统一处理 Zod 参数校验、未知/重复工具、取消信号、执行异常和结果 JSON
序列化检查，错误按稳定错误码区分。`ChatAgent` 已接入工具循环：每轮向模型暴露
注册表定义，收到工具请求就执行并把结果回填给模型，直到模型产出最终正文；
`maxSteps` 控制最大轮次（默认 10），`AbortSignal` 支持取消。对外能力声明中的
`tools` 已标记为 `available`，`POST /v1/chat` 会执行工具，但 HTTP 响应（含流式
事件）只返回执行摘要（`id`、`name`、`status`），不回传原始参数和工具结果——
未来工具的参数与返回可能包含敏感数据。

## 文档上传与编辑

支持上传 `.docx`、让 Agent 读取并修改、再下载修改后的文件：

- `POST /v1/files`：multipart 上传（字段名 `file`，≤10MB），只接受 `.docx`，
  校验 zip 结构与包内必需条目后落盘，返回 `fileId` 与 `downloadUrl`。
- `GET /v1/files/:fileId`：下载文件，需要与 `/v1/chat` 相同的 Bearer 鉴权，
  附件名为原文件名（中文名走 RFC 5987 `filename*`）。
- 工具 `read_word_document`：按段落返回正文（上限 300 段 / 3 万字符），
  供模型了解文档内容后再编辑。
- 工具 `create_word_document`：根据标题和结构化内容（一级到三级标题、段落、
  项目符号、表格）从零生成排版完整的 Word 文档——A4 页面与页边距、中文字体、
  标题配色与行距段距（styles.xml），产物落盘并返回 `fileId` 与 `downloadUrl`。
- 工具 `edit_word_document`：支持替换文本（`replace_text`）和在指定段落后
  插入段落（`insert_paragraph`）；原件保持不变，修改结果另存为新文件，工具
  结果只返回 `fileId`、`downloadUrl` 和每条编辑的 `applied` 状态，不返回正文。
- 存储目录由 `PAN_PILOT_DOCS_DIR` 配置（默认 `./docs`）；文件 ID 使用白名单
  字符集并二次校验解析路径，防止路径穿越。

当前编辑能力限制：替换文本要求目标串完整落在 Word 的单个文本节点内（Word
可能把一段文字拆成多个节点，跨节点匹配会返回未应用原因），由模型根据
`applied: false` 的结果调整匹配文本。

## 验证与构建

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

编译结果输出到 `dist/`。生产环境通过环境变量注入 API Key，不要将 `.env` 或
密钥提交到仓库。`Dockerfile` 使用多阶段构建：build 阶段执行 typecheck + test +
build；bundle 阶段导出「应用目录 + Linux Node 二进制」的自包含产物，供不装
全局 Node 的 systemd 主机直接运行。

## 实现状态

已完成：

1. DeepSeek 模型适配（OpenAI 兼容协议，非流式 + 流式）。
2. 两个参数受限的只读工具与白名单注册表。
3. ChatAgent 单 Agent 工具循环：工具执行与结果回填、`maxSteps` 最大轮次、
   `AbortSignal` 取消。
4. 工具参数校验、异常与循环终止测试。
5. SSE 流式输出：`content` / `tool_execution` / `done` / `error` 事件，
   客户端断开自动取消。
6. 文档上传与编辑：multipart 上传、docx 正文读取、文本替换与段落插入、
   修改版下载（`files` 能力已 `available`）。
7. `web_search` 工具：Bing 无 Key 搜索，标题/链接/摘要回填模型
   （`search` 能力已 `available`）。
8. `create_word_document` 工具：用 `docx` 包生成完整样式包（A4、styles.xml、
   页边距），支持标题/段落/项目符号/表格，生成结果可直接被编辑工具继续修改。

规划中（`/v1/capabilities` 对应 `reserved`）：

- `memory` / `planning` 能力。
- MiMo 等其他模型适配（`.env.example` 已预留 `MIMO_API_KEY`）。
- Java 业务服务工具（`.env.example` 已预留 `JAVA_SERVICE_URL`）。
- 权限确认与持久化。
