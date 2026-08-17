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
├── model/         # 模型适配端口：DeepSeek 与火山方舟多模态（OpenAI 兼容协议）
├── media/         # 受控媒体存储（MediaStore）：魔数校验、mediaId 访问边界
├── tools/         # 内置工具实现（含多模态分析工具，作为插件框架的 builtin 引用来源）
└── plugins/       # 插件框架：manifest 校验、加载器、http 执行器、生命周期管理
plugins/           # 声明式插件目录：每个工具一个 manifest.json
test/              # Vitest 测试
web/               # React + TypeScript + Vite 控制台，构建产物输出到 web/dist
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
- `GET /v1/models` — 返回脱敏的聊天模型目录、可用状态和默认模型 ID。
- `POST /v1/chat` — 聊天接口，支持非流式与 SSE 流式两种响应。
- `GET /v1/artifacts/:artifactId` — 下载 Agent 生成的受控单文件代码产物；
  始终作为附件返回，不在服务端执行或内联预览。
- `POST /v1/scheduled-task-runs/:id/pause` — 请求在当前模型/工具步骤完成后安全暂停；排队任务立即暂停。
- `POST /v1/scheduled-task-runs/:id/resume` — 从最近一次持久化检查点恢复已暂停运行。
- `POST /v1/scheduled-task-runs/:id/recovery` — 对异常中断在工具内部的运行明确选择 `retry` 或 `terminate`。
- `POST /v1/media` — multipart 上传图片（png/jpg/jpeg/webp/gif）或音频
  （mp3/wav），返回受控 `mediaId`。
- `GET /v1/media/:mediaId` — 下载原始媒体，需要与 `/v1/chat` 相同的 Bearer 鉴权。
- `DELETE /v1/media/:mediaId` — 删除受控媒体（媒体文件与元数据边车），
  需要相同的 Bearer 鉴权；成功返回 `200 { deleted: true, mediaId }`，
  不存在返回 `404 MEDIA_NOT_FOUND`，非法 mediaId 返回 `400 INVALID_REQUEST`，
  底层删除失败（如 EACCES/EPERM/EIO）返回 `500 MEDIA_DELETE_FAILED`（通用
  错误，不泄露路径/内部细节，绝不谎报删除成功）。供调用方在会话删除/事务
  回滚时联动清理；当前没有定时对账/TTL 自动清理。

配置了 `PAN_PILOT_API_TOKEN` 后，除密码登录外的 `/v1/*` 要求请求头
`Authorization: Bearer <credential>`。Portal 后端等服务调用方继续使用原始 API
token；网页控制台通过 `POST /v1/auth/login` 提交
`PAN_PILOT_CONSOLE_PASSWORD`，换取默认有效期 30 天的 HMAC 签名通行证。
原始 API token 不会下发到浏览器；密码修改后旧通行证自动失效。登录接口按客户端
IP 在 10 分钟内最多接受 5 次错误尝试。未配置 API token 时 `/v1/*` 开放访问。
`GET /v1/auth/status` 公开返回 `{ loginRequired }`，只有 API token 与控制台密码
都配置时前端才要求登录：本地开发未配置密码时控制台完全不弹「验证访问密码」框，
生产部署（两者都配置）在无有效通行证时弹出且**不可关闭**（无 X 按钮、Escape 与
点击遮罩均无效，只能输入正确密码登录）。未配置控制台密码时登录接口 fail-closed
返回 503；`/health` 始终公开。

### 出站代理（多模态调用）

图片/音频理解走火山方舟 OpenAI 兼容端点；进程存在
`http_proxy`/`HTTP_PROXY`/`https_proxy`/`HTTPS_PROXY` 任一环境变量时，
SDK 传输自动经 undici `EnvHttpProxyAgent` 走代理，并遵循
`no_proxy`/`NO_PROXY`（大小写不敏感）；无代理环境保持直连。代理值、
API Key 等凭据不会写入日志。部署在需要代理出网的服务器（如隔离测试
环境）时，请为该服务进程配置上述代理环境变量。

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

网页控制台：

```bash
open http://127.0.0.1:3000/console
```

控制台采用 React + TypeScript + Vite，包含对话、媒体、插件、定时任务和能力
五个工作区；支持按供应商切换聊天模型、SSE 流式停止、媒体附件、Office MCP 文档，
以及由用户安装、启用和禁用插件。模型选择保存在同一份浏览器 localStorage 状态中。
连接地址与登录后签发的通行证保存在浏览器 localStorage；控制台不再要求用户接触
原始 API token。源码位于 `web/src`，`pnpm build:web`
生成 `web/dist`，由 Fastify 同源托管；开发时 `pnpm dev` 会同时启动后端和
Vite 前端服务。

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
  --data '{"model":"volcengine/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

`model` 可省略；省略时使用 `PAN_PILOT_DEFAULT_MODEL_ID`。当前稳定 ID 为
`volcengine/deepseek-v4-flash` 与 `deepseek/deepseek-v4-flash`。未知 ID 返回
400 `UNSUPPORTED_MODEL`，缺少对应供应商密钥返回 503 `MODEL_UNAVAILABLE`，
不会自动回退到另一条线路。

非流式响应返回 `message`（最终正文）、`modelId`（稳定选择 ID）、`model`
（厂商实际版本）、`usage` 和
`execution.toolExecutions`（工具执行摘要）。旧的 `{"message":"你好"}` 请求
仍然兼容。请求参数错误返回 400 `INVALID_REQUEST`；非流式调用失败返回 502
`CHAT_FAILED`，内部细节只进服务端日志。

聊天请求还可携带 `attachments`（`[{"mediaId":"...","kind":"image"|"audio"}]`，
最多 10 个）：媒体必须先通过 `/v1/media` 上传；服务端校验 mediaId 存在且与
`kind` 一致后，向模型注入强制提示——图片附件必须先用 `analyze_image` 分析，
音频附件按用户请求必须先用 `transcribe_audio`（语音转写）或 `analyze_audio`
（转写 + 说话人/语气/背景分析）。提示只含 mediaId，媒体字节与 Base64
不进日志、不回传 HTTP。

### 上下文管理与压缩

普通聊天和后台任务共用 Agent 层上下文预算。每次调用模型前会估算消息与工具定义
占用的 Token；默认超过 48,000 tokens，或历史超过 80 条消息时，把较旧内容交给
当前选定模型生成滚动中文摘要。系统指令、最近消息以及完整的
`assistant tool_calls → tool results` 调用链不会从中间拆开。摘要器不暴露任何工具，
输出限制为 2,000 tokens；摘要调用的 Token 会计入本轮 `totalTokens`。

发生压缩后，结果中的 `context` 返回累计压缩次数、被摘要消息数和当前估算输入量。
普通聊天还在 `execution.contextMessages` 返回可供下一轮继续提交的安全历史，只包含
system/user/普通 assistant 消息，不包含原始工具调用参数和原始 tool 消息；控制台会自动用它替换
旧本地历史。后台任务则把完整压缩历史写入权限为 `0600` 的检查点，暂停、恢复或
服务重启后不会重新摘要同一段内容。

`stream: true` 返回 `text/event-stream`，每个事件是一行 `data: {json}`，
`type` 字段区分事件：

- `{"type":"content","content":"文本增量"}`：模型正文逐段生成。
- `{"type":"tool_execution","execution":{"id","name","status"}}`：单次工具执行摘要。
- `{"type":"done","result":{...}}`：整轮结束，携带与 `chat()` 相同的最终结果
  （content、modelId、model、totalTokens、steps、toolExecutions）。
- `{"type":"error","error":"CHAT_FAILED","message":"Agent 调用失败"}`：流建立后
  发生的失败；客户端断开时流直接终止，不再发送事件。

流式响应同样只回传工具执行摘要，不回传原始参数和工具结果。`stream: true`
时客户端断开会中止模型调用和工具执行（通过 `AbortSignal` 传递）。

## 定时任务暂停与恢复

定时任务按全局 FIFO 串行执行。运行时在模型调用完成和每项工具调用完成后持久化
消息历史、待执行工具位置、累计步数、Token 与安全工具摘要。暂停采用安全点语义：
不会中断正在执行的工具；当前步骤完成后进入 `paused`，恢复时从检查点继续，已经
完成并落盘的工具不会重复执行。停用任务只阻止未来计划触发，不会暂停当前运行。

服务重启时，拥有检查点且停在模型调用中的运行会自动续跑，已暂停运行保持暂停。
如果重启发生在工具调用内部，或旧运行没有检查点，状态变为
`needs_confirmation`；控制台要求用户明确选择重试（可能重复该工具副作用）或终止。
检查点可能含原始工具参数和结果，只保存在权限为 `0600` 的任务状态文件中，任务
HTTP 接口会剥离 `checkpoint` 与 `activity`，只返回安全摘要。

## 环境变量

完整清单见 `.env.example`，要点：

- `PAN_PILOT_DEFAULT_MODEL_ID`：省略请求 `model` 时使用的稳定模型 ID，默认
  `volcengine/deepseek-v4-flash`；默认项缺少密钥时服务拒绝启动。
- `VOLCENGINE_API_KEY` / `VOLCENGINE_BASE_URL`：火山方舟聊天与图片理解共用的
  密钥和 Coding Plan 端点。
- `VOLCENGINE_CHAT_RESOLVED_ADDRESS`：只覆盖火山主对话域名的 DNS 结果。
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`：DeepSeek 官方线路的密钥与端点；
  缺少密钥时该线路仍出现在模型目录中，但状态为 unavailable。
- `DEEPSEEK_RESOLVED_ADDRESS`：部署环境的系统 DNS 把 DeepSeek 解析到不可达
  地址时，可只为 PanPilot 覆盖该主机的 DNS 结果；不修改全局 DNS，URL 中的
  域名保留以维持 Host/TLS SNI/证书校验。
- `PAN_PILOT_API_TOKEN`：`/v1/*` 的 Bearer 鉴权令牌；未配置时 `/v1/*` 开放访问。
- `PAN_PILOT_CONSOLE_PASSWORD`：控制台访问密码，只用于换取浏览器签名通行证；
  与 API token 都配置时，生产控制台在无有效通行证时弹出不可关闭的验证框；
  本地未配置密码不弹框。真实值只放运行环境，不提交到仓库。
- `PAN_PILOT_ARTIFACTS_DIR`：单文件代码产物目录，默认 `./artifacts`；
  生产应配置为 release 外持久目录。
- `PAN_PILOT_PLUGINS_DIR`：声明式插件目录，默认 `./plugins`。
- `PAN_PILOT_PLUGIN_ALLOWED_HOSTS`：http 插件 host 白名单（逗号分隔）；
  默认拒绝：未配置时 http 插件在加载期与安装时都会被拒绝。
- `PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS`：允许插件通过 `${env:NAME}` 引用的
  环境变量名白名单（逗号分隔）；默认拒绝全部引用，禁止访问任意 `process.env`。
- `PAN_PILOT_MEDIA_DIR`：受控媒体存储目录，默认 `./media`。
- `PAN_PILOT_SCHEDULED_TASKS_DIR`：定时任务与运行历史目录，默认
  `./scheduled-tasks`；生产应配置为 release 外持久目录。
- `PAN_PILOT_MCP_CONFIG`：可选 MCP Client 配置文件路径；未配置时不连接任何
  MCP Server。示例见 `mcp.example.json`。
- `PAN_PILOT_API_TOKEN` 同时是插件变更接口的开关：未配置时安装、重载、
  启用和禁用一律返回 503（fail-closed）。
- `PAN_PILOT_LOG_CHAT_CONTENT`：聊天内容日志开关，默认关闭。
- `PAN_PILOT_CONTEXT_MAX_TOKENS`：触发压缩的估算输入上限，默认 `48000`。
- `PAN_PILOT_CONTEXT_TARGET_TOKENS`：压缩目标预算，默认 `33600`。
- `PAN_PILOT_CONTEXT_RECENT_TOKENS`：尽量原样保留的近期内容预算，默认 `14400`。
- `PAN_PILOT_CONTEXT_SUMMARY_MAX_TOKENS`：摘要最大输出，默认 `2000`。
- `PAN_PILOT_CONTEXT_MAX_MESSAGES`：不论 Token 大小最多保留的消息数，默认 `80`。
- `HOST` / `PORT`：监听地址，默认 `0.0.0.0:3000`。
- `VOLCENGINE_API_KEY`：火山方舟密钥；图片通道使用，音频未单独配置密钥时
  也会复用。客户端懒加载，未配置时服务可启动、媒体工具调用会失败。
- `VOLCENGINE_BASE_URL`：图片理解的 Coding Plan 端点，默认
  `https://ark.cn-beijing.volces.com/api/coding/v3`。
- `VOLCENGINE_MULTIMODAL_MODEL`：图片理解模型，默认
  `doubao-seed-2.1-turbo`（精确字符串，不要改写为连字符形式）。
- `VOLCENGINE_AUDIO_API_KEY`：音频通道可选独立密钥；为空时复用
  `VOLCENGINE_API_KEY`。
- `VOLCENGINE_AUDIO_BASE_URL`：音频理解使用标准方舟端点，默认
  `https://ark.cn-beijing.volces.com/api/v3`；Coding Plan 端点不接受音频输入。
- `VOLCENGINE_AUDIO_MODEL`：官方支持音频的精确版本，默认
  `doubao-seed-2-0-lite-260428`，账号必须先在方舟控制台开通该模型。
- `SEARCH_BASE_URL`：搜索端点覆盖，默认 Bing 网页搜索（无需 Key）。
- `MIMO_API_KEY`、`JAVA_SERVICE_URL`：预留，当前代码未使用。

## MCP 工具协议

PanPilot 可以作为 MCP Client 连接外部 MCP Server，并把对方的 `tools/list`
结果加入现有 `ChatAgent` 工具循环。使用官方 TypeScript SDK，支持 stdio 和
Streamable HTTP；不自动回退到旧 SSE 传输。

在 `PAN_PILOT_MCP_CONFIG` 指向的 JSON 文件中声明连接：

```json
{
  "version": 1,
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp/filesystem-server.js"],
      "timeoutMs": 30000
    },
    "business": {
      "transport": "streamableHttp",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_BUSINESS_TOKEN}"
      }
    }
  }
}
```

- Server 名只允许小写字母、数字和下划线；远端工具公开为
  `mcp__<server>__<tool>`，不会覆盖本地插件或其他 MCP Server。
- Streamable HTTP 必须使用 HTTPS，只有 localhost、127.0.0.1、`::1` 允许
  HTTP。凭据通过 `${env:NAME}` 在启动时注入，状态接口不会回传 URL、命令、
  请求头或环境变量。
- stdio 进程只继承 SDK 的安全默认环境变量；配置 `env` 时会与安全默认值合并，
  不会继承完整 `process.env`。
- `GET /v1/mcp/servers` 返回脱敏连接状态与公开工具名。单个 Server 连接或工具
  清单失败会隔离为 `error`，其他聊天、插件和 MCP Server 继续工作。
- MCP 连接与状态接口要求配置 `PAN_PILOT_API_TOKEN`；未配置时不会连接任何
  外部 Server，防止匿名聊天间接调用远端副作用工具。
- MCP 工具参数仍经过 JSON Schema 校验；调用支持 `AbortSignal` 取消，默认
  30 秒超时，单个 Server 最多公开 100 个工具，单次结果最大 1MB。Agent
  不能自行新增或修改 MCP 连接。

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

## 安全工具层与声明式插件

`src/tools/` 提供工具契约、白名单注册表，以及计算、日期、换算、文本、搜索和
受控媒体工具；Office 文档工具由独立 MCP Server 提供：

- `get_current_time`：读取指定 IANA 时区的当前时间，默认使用 UTC。
- `calculator`：只执行参数受限的加、减、乘、除，不解析表达式或使用 `eval`。
- `date_calculator`：按日历日加减日期、计算日期差或查询星期；用 UTC 日历日
  运算，避免夏令时导致日期偏差。
- `unit_converter`：换算常用长度、重量、温度和容量单位；美制容量会明确标注。
- `text_stats`：按可见字素统计字符、非空白字符、词、句、行和 UTF-8 字节数。
- `web_search`：搜索互联网，返回标题、链接和摘要；默认走 Bing 网页搜索，
  无需 API Key（`SEARCH_BASE_URL` 可覆盖，换 Tavily 等带 Key 服务时实现
  同一个 `SearchClient` 接口即可）。
- `analyze_image`：分析用户上传的图片（只接受 `/v1/media` 返回的 `mediaId`），
  返回主体、文字、颜色等结构化描述。
- `analyze_audio`：转写音频语音并描述说话人、语气与背景声音（同样只接受
  `mediaId`）。
- `transcribe_audio`：逐字转写音频语音，可选 `language` 指定目标语言。

注册表统一处理 Zod 参数校验、未知/重复工具、取消信号、执行异常和结果 JSON
序列化检查，错误按稳定错误码区分。`ChatAgent` 已接入工具循环：每轮向模型暴露
注册表定义，收到工具请求就执行并把结果回填给模型，直到模型产出最终正文；
`maxSteps` 控制最大轮次（默认 10），`AbortSignal` 支持取消。对外能力声明中的
`tools` 已标记为 `available`，`POST /v1/chat` 会执行工具，但 HTTP 响应（含流式
事件）只返回执行摘要（`id`、`name`、`status`），不回传原始参数和工具结果——
未来工具的参数与返回可能包含敏感数据。

工具白名单由 `plugins/` 目录下的 manifest 声明式驱动（内置工具均已迁移），
加工具不再改核心代码：新增纯 HTTP-JSON 工具只需要放一个 manifest 并重载。
`list_plugins` 与 `suggest_plugin` 两个管理工具也以 manifest 形式对 Agent
可见（builtin 自引用）。详见 `plugins/README.md`；操作接口：

```bash
curl -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins
```

### 用户管理插件

PanPilot 采用单用户插件管理模式：Agent 的 `suggest_plugin` 只能生成待安装建议，
不会写文件或启用工具；用户可在控制台选择“安装”或“忽略”，也可以直接粘贴
manifest 安装。安装接口会重新校验 manifest，create-only 写入插件目录并原子
重载；加载失败会回滚新文件并保留旧注册表。

已安装插件可直接启用、禁用和重载。启停会写回 manifest 的 `enabled` 字段，
重启后保持用户选择。未配置 `PAN_PILOT_API_TOKEN` 时，这些副作用接口返回 503；
HTTP 插件仍只允许 HTTPS，host 与 `${env:NAME}` 引用受白名单约束且默认拒绝。

```bash
# 安装 manifest
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"manifest":{...}}' \
  http://127.0.0.1:3000/v1/plugins/install

# 查看 Agent 推荐并选择安装
curl -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins/suggestions
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins/suggestions/<id>/install

# 直接启停
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins/<name>/disable
```

## Office 文档

Word、PDF 与 PowerPoint 的读取和生成由独立的 `pan-pilot-office-mcp` 进程提供，
依赖与故障边界不进入 PanPilot 主进程：

- 文档统一上传到 `POST /v1/media`，工具只接受受控 `mediaId`，输出也重新上传到
  `/v1/media`；不接受任意路径或远程 URL。
- Word 工具公开为 `mcp__office__read_word_document`、
  `mcp__office__create_word_document`、`mcp__office__edit_word_document`。
- PDF/PPTX 工具分别公开为 `mcp__office__read_pdf`、`create_pdf`、
  `read_presentation`、`create_presentation`（均带 `mcp__office__` 前缀）。
- 主项目的 `read_attachment` 只读取文本附件；Office 文档必须交给对应 MCP 工具。
- 旧 `/v1/files` 与本地 Word builtin 已移除，历史 `docs` 目录不会被程序自动删除。

Office MCP 仍需独立构建，并通过 `PAN_PILOT_MCP_CONFIG` 配置 stdio Server；当前
修改配置或版本后需要重启 PanPilot。

## 代码产物

工具 `create_code_artifact` 用于保存网页、小游戏和代码示例，首版支持单文件
HTML、CSS、JavaScript、TypeScript、JSON、Markdown 与纯文本：

- 输入只包含不带路径的名称、固定格式枚举和 UTF-8 正文；底层存储上限为
  200,000 字符 / 512KB，当前 Agent 工具进一步限制为 8,000 字符，确保网页或
  小游戏以完整、紧凑的 MVP 落盘，而不是在厂商工具参数中途截断。不接受任意路径、
  URL、二进制或 Base64。
- 产物以版本化 JSON 原子写入 `PAN_PILOT_ARTIFACTS_DIR`，目录权限 `0700`、
  文件权限 `0600`；读取时重新严格校验。
- `GET /v1/artifacts/:artifactId` 使用格式对应的 MIME，但强制
  `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff` 和
  `Content-Security-Policy: sandbox`，服务端不会运行或预览代码。
- 工具结果只返回元数据与下载地址，不返回源码；最终回复默认只给简要说明和地址，
  不重复整份代码。Word 工具仅用于用户明确要求的 Word/DOCX/报告，不用于源码。

流式模型适配器会把推理块、工具参数块及 usage 块归一为不含任何内容的内部
`activity` 事件，用于刷新模型空闲超时。该事件不会进入 HTTP/SSE，也不会暴露
推理内容或工具参数；整体请求超时仍会终止无限活动的上游流。

## 媒体上传与理解

支持上传图片/音频，让 Agent 通过受控 `mediaId` 调用多模态工具理解内容：

- `POST /v1/media`：multipart 上传（字段名 `file`，默认 ≤10MB）。图片限
  png/jpg/jpeg/webp/gif，音频限 mp3/wav；先按扩展名粗筛，再以魔数判定真实
  类型，扩展名与内容不一致或魔数不识别都会拒绝（415）。返回 `mediaId`、
  `kind`、`mimeType`、`size`。
- `GET /v1/media/:mediaId`：下载原始媒体，需要 Bearer 鉴权；mediaId 使用
  白名单字符集，边车元数据经严格 schema 校验（extension 固定白名单），
  防止路径穿越。
- 三个分析工具都只接受 `mediaId`，不接受文件路径或远程 URL；媒体字节只在调用
  厂商时以 Base64 形式发送，不进日志、不回传 HTTP（聊天只回传工具执行摘要）。
- 多模态厂商通过 `MultimodalClient` 端口隔离：图片走 Coding Plan 的
  `doubao-seed-2.1-turbo`（`image_url` + Base64 Data URL）；音频走标准方舟的
  `doubao-seed-2-0-lite-260428`（`input_audio.data` + `format`，wav/mp3）。主
  `DeepSeekClient` 不承载媒体协议。
- 真实端点验收结果：图片已成功返回并正确识别测试图；Coding Plan 端点对
  `doubao-seed-2.1-turbo`、Seed 2.0 Lite/Mini 均返回“不支持 audio input”。
  标准方舟端点能定位到官方音频模型，但当前账号返回 `ModelNotOpen`。因此
  `capabilities.media.image` 为 `available`，`audio` 为 `blocked`；音频模型开通
  后再进行运行态验收。

## 验证与构建

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

服务端编译结果输出到 `dist/`，控制台输出到 `web/dist/`。生产环境通过环境变量注入 API Key，不要将 `.env` 或
密钥提交到仓库。`Dockerfile` 使用多阶段构建：build 阶段执行 typecheck + test +
build；bundle 阶段导出「应用目录 + Linux Node 二进制」的自包含产物，供不装
全局 Node 的 systemd 主机直接运行。

## 实现状态

已完成：

1. DeepSeek 模型适配（OpenAI 兼容协议，非流式 + 流式）。
2. 参数受限的只读工具与白名单注册表（计算、日期、单位换算和文本统计）。
3. ChatAgent 单 Agent 工具循环：工具执行与结果回填、`maxSteps` 最大轮次、
   `AbortSignal` 取消。
4. 工具参数校验、异常与循环终止测试。
5. SSE 流式输出：`content` / `tool_execution` / `done` / `error` 事件，
   客户端断开自动取消。
6. Office 文档统一通过 `/v1/media` 上传，由独立 Office MCP 读取、创建和编辑。
7. `web_search` 工具：Bing 无 Key 搜索，标题/链接/摘要回填模型
   （`search` 能力已 `available`）。
8. Word/PDF/PPTX 工具依赖隔离在 `pan-pilot-office-mcp`，主进程只保留受控
   `mediaId` 存储和 MCP Client。
9. 声明式插件框架：manifest 驱动白名单（builtin 引用 + http 执行器）、
   `GET /v1/plugins` 状态与原子重载、运行时启停、控制台插件面板。
10. 用户管理插件：Agent 通过 `suggest_plugin` 生成待安装建议；用户在控制台
    选择安装/忽略，并可直接启停、重载；安装保持原子写入与失败回滚，
    host/环境变量默认拒绝（`plugins` 能力已 `available`）。
11. 多模态媒体能力：`/v1/media` 上传/下载（魔数校验、受控 mediaId、边车严格
    校验）、`analyze_image` / `analyze_audio` / `transcribe_audio` 工具、
    `/v1/chat` `attachments` 强制工具提示、火山方舟双通道 `MultimodalClient`。
    图片真实端点已验收；音频代码已实现但运行态因账号未开通模型而阻塞。

规划中（`/v1/capabilities` 对应 `reserved`）：

- `memory` / `planning` 能力。
- MiMo 等其他模型适配（`.env.example` 已预留 `MIMO_API_KEY`）。
- Java 业务服务工具（`.env.example` 已预留 `JAVA_SERVICE_URL`）。
- 在方舟控制台开通 `doubao-seed-2-0-lite-260428` 后，完成音频真实端点验收并
  将 `capabilities.media.audio` 从 `blocked` 改为 `available`。
