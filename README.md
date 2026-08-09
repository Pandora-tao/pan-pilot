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
- `POST /v1/media` — multipart 上传图片（png/jpg/jpeg/webp/gif）或音频
  （mp3/wav），返回受控 `mediaId`。
- `GET /v1/media/:mediaId` — 下载原始媒体，需要与 `/v1/chat` 相同的 Bearer 鉴权。

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

聊天请求还可携带 `attachments`（`[{"mediaId":"...","kind":"image"|"audio"}]`，
最多 10 个）：媒体必须先通过 `/v1/media` 上传；服务端校验 mediaId 存在且与
`kind` 一致后，向模型注入强制提示——图片附件必须先用 `analyze_image` 分析，
音频附件按用户请求必须先用 `transcribe_audio`（语音转写）或 `analyze_audio`
（转写 + 说话人/语气/背景分析）。提示只含 mediaId，媒体字节与 Base64
不进日志、不回传 HTTP。

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
- `PAN_PILOT_PLUGINS_DIR`：声明式插件目录，默认 `./plugins`。
- `PAN_PILOT_PLUGIN_ALLOWED_HOSTS`：http 插件 host 白名单（逗号分隔）；
  默认拒绝：未配置时 http 插件在加载期与草案期都会被拒绝。
- `PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS`：允许插件通过 `${env:NAME}` 引用的
  环境变量名白名单（逗号分隔）；默认拒绝全部引用，禁止访问任意 `process.env`。
- `PAN_PILOT_PLUGIN_APPROVAL_TTL_MINUTES`：自服务插件审批有效期（分钟），
  默认 15；过期后批准与执行都会被拒绝。
- `PAN_PILOT_MEDIA_DIR`：受控媒体存储目录，默认 `./media`。
- `PAN_PILOT_API_TOKEN` 同时是审批执行接口的开关：未配置时
  approve/reject/execute 一律返回 503（fail-closed），匿名只能创建草案，
  无法批准或执行任何动作。
- `PAN_PILOT_LOG_CHAT_CONTENT`：聊天内容日志开关，默认关闭。
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

`src/tools/` 提供工具契约、白名单注册表、两个只读工具、三个 Word
文档工具（见下文「文档上传与编辑」）和一个搜索工具：

- `get_current_time`：读取指定 IANA 时区的当前时间，默认使用 UTC。
- `calculator`：只执行参数受限的加、减、乘、除，不解析表达式或使用 `eval`。
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

工具白名单由 `plugins/` 目录下的 manifest 声明式驱动（内置 9 个工具已迁移），
加工具不再改核心代码：新增纯 HTTP-JSON 工具只需要放一个 manifest 并重载。
`list_plugins`、`create_plugin`、`reload_plugins` 三个管理工具也以 manifest
形式对 Agent 可见（builtin 自引用）。详见 `plugins/README.md`；操作接口：

```bash
curl -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins
```

### 自服务插件闭环（审批协议）

Agent 可以通过工具发起插件变更，但任何有副作用的写入、启用或重载都必须先
经过人工审批。闭环如下：

1. `list_plugins`（模型工具，只读，无需审批）：返回脱敏插件状态；
2. `create_plugin`（模型工具）：只校验并规范化 manifest，生成审批草案
   （approvalId / 内容哈希 / 有效期 / 预览与风险摘要），**不落盘、不启用**；
   `reload_plugins`（模型工具）同样只创建重载审批草案，绝不直接重载；
3. 人工通过受鉴权 HTTP API 批准或拒绝；
4. 执行：只执行已批准且哈希匹配的一次性动作——原子写入
   `PAN_PILOT_PLUGINS_DIR/<name>/manifest.json`，重载注册表；任一环节失败
   回滚新文件并保留旧注册表；
5. 新工具进入 ChatAgent 使用的同一个 `ToolRegistry`，模型下一轮即可调用。

模型没有 approve/reject/execute 工具，无法批准自己的动作；审批是绑定不可变
规范化动作的一次性凭证（哈希 + 有效期 + 防重放）。审批记录当前保存在进程
内存（`ApprovalStore` 接口已为未来持久化预留边界），**重启后全部失效**，
需要重新创建草案。

审批安全细节：

- **动作不可变**：存储边界做深拷贝，调用方拿不到内部引用；批准/执行前服务会
  重新哈希 `action` 与 `actionHash` 比对，任何篡改都会被拒绝（409）。
- **哈希必填**：approve/execute 必须提交 64 位十六进制动作哈希；缺失或格式
  错误返回 400，内容不符返回 409。
- **fail-closed 鉴权**：未配置 `PAN_PILOT_API_TOKEN` 时 approve/reject/execute
  返回 503，匿名不能完成任何副作用；草案创建保持可用。
- **快照绑定**：create 与 reload 草案都绑定创建时的插件目录快照哈希，
  执行前目录内容变化即拒绝（409 `PLUGIN_DIR_CHANGED`），批准后换入的插件
  不会被 create/reload 的全量重载顺带加载；启停草案绑定目标插件的 manifest
  指纹，同名内容被替换同样拒绝。
- **全局互斥**：所有插件变更执行共用进程内互斥锁，不同审批不会交错进入
  「快照校验 → 写入 → 重载」临界区；另一个审批正在执行时返回 409
  `APPROVAL_CONCURRENT`。
- **无重定向**：http 插件请求显式 `redirect: "error"`，白名单 host 的 3xx
  不会被跟随到任意地址/私网。

```bash
# 1. 创建草案（HTTP 调用方视角；模型通过 create_plugin 工具完成同一件事）
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":{"type":"create_plugin","manifest":{...}}}' \
  http://127.0.0.1:3000/v1/plugins/approvals

# 2. 列出审批（只含脱敏预览，不含 manifest 原文与密钥）
curl -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  http://127.0.0.1:3000/v1/plugins/approvals

# 3. 批准（必须携带动作哈希，缺失/格式错误 400，不符 409）
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"hash":"<hash>"}' \
  http://127.0.0.1:3000/v1/plugins/approvals/<id>/approve

# 4. 一次性执行（拒绝/过期/重放/哈希不符都会被拒绝）
curl -X POST -H "Authorization: Bearer $PAN_PILOT_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"hash":"<hash>"}' \
  http://127.0.0.1:3000/v1/plugins/approvals/<id>/execute
```

兼容入口 `POST /v1/plugins/reload` 与 `POST /v1/plugins/:name/enable|disable`
不再直接生效：它们现在创建对应审批草案（返回 `approval`），仍需批准并执行。
重载仍是原子操作（任一 manifest 失败则整体保留旧注册表）；启停只改内存态，
重启后回到 manifest 默认值。http 插件只允许 https，host 与 `${env:NAME}`
引用都受白名单约束且默认拒绝。

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
9. 声明式插件框架：manifest 驱动白名单（builtin 引用 + http 执行器）、
   `GET /v1/plugins` 状态与原子重载、运行时启停、控制台插件面板。
10. Agent 自服务插件闭环：`list_plugins`（只读）与 `create_plugin`（草案）
    工具 + HTTP 审批协议（approve/reject/execute），一次性哈希绑定动作、
    原子写入与失败回滚、host/环境变量默认拒绝（`plugins` 能力已 `available`）。
11. 多模态媒体能力：`/v1/media` 上传/下载（魔数校验、受控 mediaId、边车严格
    校验）、`analyze_image` / `analyze_audio` / `transcribe_audio` 工具、
    `/v1/chat` `attachments` 强制工具提示、火山方舟双通道 `MultimodalClient`。
    图片真实端点已验收；音频代码已实现但运行态因账号未开通模型而阻塞。

规划中（`/v1/capabilities` 对应 `reserved`）：

- `memory` / `planning` 能力。
- MiMo 等其他模型适配（`.env.example` 已预留 `MIMO_API_KEY`）。
- Java 业务服务工具（`.env.example` 已预留 `JAVA_SERVICE_URL`）。
- 审批记录的持久化（当前为进程内存，重启后失效）与过期记录清理。
- 在方舟控制台开通 `doubao-seed-2-0-lite-260428` 后，完成音频真实端点验收并
  将 `capabilities.media.audio` 从 `blocked` 改为 `available`。
