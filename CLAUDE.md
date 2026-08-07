# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区，提供 Fastify HTTP 服务。当前已实现带工具循环和 SSE 流式输出的聊天生成（白名单工具、最大轮次控制、取消信号）；记忆与规划是后续能力（当前状态见 `src/agent/capabilities.ts` 的 `reserved` 声明）。

## 常用命令

```bash
pnpm dev          # tsx watch 热重载开发
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run --dir test --passWithNoTests
pnpm test:watch   # vitest 监听模式
pnpm build        # tsc 编译到 dist/
pnpm start        # node --enable-source-maps dist/src/index.js
```

运行单个测试文件：

```bash
pnpm exec vitest run test/chat-route.test.ts
```

## 架构

三层职责分离，依赖单向注入（HTTP → Agent → 模型），通过 `buildApp()` 组装：

```text
src/index.ts     进程入口：读环境变量、buildApp()、listen()
src/app.ts       buildApp(options)：组装依赖 + 注册路由，不监听端口
src/routes/      HTTP 适配层：校验、鉴权、状态码、日志，不含厂商细节
src/agent/       应用层：ChatAgent 会话控制与工具循环
src/model/       模型适配端口与实现
src/tools/       工具定义、白名单注册、校验与执行
src/docs/        docx 存储（DocStore）与读写/编辑引擎（word-editor）
src/search/      搜索提供端口（SearchClient）与 Bing 实现
```

核心契约是 `ModelClient` 接口（`src/model/model-client.ts`）：Agent 只认识这个接口，生产用 `DeepSeekClient`（OpenAI 兼容协议）实现，测试注入假实现。新增模型厂商 = 实现该接口，不需要改动上层。

`buildApp(options)` 是依赖注入入口：`modelClient`、`apiToken`、`logChatContent`、`loggerInstance` 均可由调用方覆盖——测试因此不需要真实 API Key、外部网络或监听端口。

路由以 `registerXxxRoute(app, deps)` 形式注册：

- `/health` — 探活，不鉴权、不调模型
- `/v1/capabilities` — 能力发现
- `/v1/chat` — 聊天接口
- `/v1/files` — multipart 上传 .docx；`GET /v1/files/:fileId` 下载（含修改版）

Word 文档工具（`create_word_document` / `read_word_document` /
`edit_word_document`）通过白名单注册表接入 Agent 循环：上传原件不可变，
创建/编辑结果另存新文件并返回 `downloadUrl`；工具结果只含摘要
（fileId/下载地址/每条编辑的 applied 状态），正文不进 HTTP。
创建走 `docx` 包生成完整样式包（A4/页边距/styles.xml），支持标题、段落、
项目符号和表格；编辑引擎仍只重写 `word/document.xml`，两种产物结构兼容。
`web_search` 工具走 `SearchClient` 端口（默认 Bing 网页搜索，无 Key；
`SEARCH_BASE_URL` 可覆盖），结果标题/链接/摘要回填模型。

## 关键约定

- **能力声明优先**：新能力（tools/memory/planning/streaming）先改 `src/agent/capabilities.ts` 的状态，而不是让客户端通过调用失败来猜测
- **协议向前兼容**：`/v1/chat` 同时接受旧 `message` 和新 `messages` 格式（二者互斥）；`stream: true` 走 SSE 流式响应（事件格式见下一条）
- **错误码**：400 `INVALID_REQUEST`（zod 校验失败）、502 `CHAT_FAILED`（非流式）——对外隐藏 SDK/网络/密钥细节，详细原因只进服务端日志
- **SSE 约定**：`/v1/chat` 的 `stream: true` 用 `text/event-stream` 返回；事件是 `data: {json}` 行，`type` 为 `content`/`tool_execution`/`done`/`error`；流建立后的失败以 `error` 事件返回，客户端断开则直接终止（响应流 close 时未正常写完会触发 AbortSignal）
- **HTTP 不暴露工具细节**：`/v1/chat` 只返回工具执行摘要（`id`/`name`/`status`）；原始参数和工具结果只回填给模型，可能含敏感数据，不得默认回传 HTTP
- **请求校验用 zod `.strict()`**：拒绝未声明字段，避免拼写错误被静默忽略后仍然调用付费模型
- **TS 严格配置**：`verbatimModuleSyntax` 要求类型导入必须写 `import type`；NodeNext ESM 要求相对导入带 `.js` 后缀；`noUncheckedIndexedAccess` 要求处理索引可能 undefined；`exactOptionalPropertyTypes` 禁止把 `undefined` 显式赋给可选属性
- **注释与用户可见文案用中文**（项目约定），代码标识符用英文
- 聊天内容日志（`PAN_PILOT_LOG_CHAT_CONTENT=true`）会记录隐私数据，默认关闭；不要将含对话内容的日志提交进 Git

## 测试

vitest + Fastify `app.inject()` 在进程内走完整 HTTP 生命周期，用假 ModelClient 隔离外部网络：

```ts
const complete = vi.fn<ModelClient["complete"]>().mockResolvedValue({ content: "你好", model: "test-model" });
const app = buildApp({ modelClient: { complete } });
const response = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "hi" } });
```

- 每个用例创建的 app 收集到数组，`afterEach` 统一 `app.close()`，避免 hook/句柄泄漏到下一条用例
- 鉴权和日志断言通过 `apiToken`、`loggerInstance` 注入替身完成

## 环境变量

`DEEPSEEK_API_KEY` 必填（缺失时 `DeepSeekClient` 构造函数直接抛错）。`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`）、`DEEPSEEK_RESOLVED_ADDRESS`（只覆盖 DeepSeek 主机的 DNS 解析结果，URL 域名保留以维持 Host/TLS SNI/证书校验）、`PAN_PILOT_API_TOKEN`（/v1 路由 Bearer 鉴权，用 `timingSafeEqual` 常时比较）、`PAN_PILOT_DOCS_DIR`（docx 存储目录，默认 `./docs`）、`SEARCH_BASE_URL`（搜索端点，默认 Bing）、`HOST`/`PORT`。完整清单见 `.env.example`；不要提交 `.env`。

## 构建与部署

`Dockerfile` 多阶段构建：build 阶段执行 typecheck + test + build；`bundle` 阶段导出「应用目录 + Linux Node 二进制」的自包含产物，供不装全局 Node 的 systemd 主机直接运行。
