# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区，提供 Fastify HTTP 服务。当前已实现带工具循环和 SSE 流式输出的聊天生成、声明式插件框架与单用户插件管理：Agent 通过 `suggest_plugin` 生成待安装建议，用户自行安装、忽略、启用、禁用和重载；`install_plugin` 允许 Agent 自主安装（默认关闭，`PAN_PILOT_PLUGIN_AUTO_INSTALL=true` 开启）；/v1 鉴权跟随全局 Bearer 钩子（配置 token 则全部要求鉴权，未配置则全部放行），安装保持 manifest 校验、create-only 写入、原子重载与失败回滚。记忆与规划是后续能力。

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
src/tools/       工具定义、白名单注册、校验与执行（含 list_plugins/suggest_plugin/install_plugin）
src/plugins/     插件框架：manifest 校验、加载器、http 执行器、生命周期管理、
                 用户安装建议与直接管理（plugin-service / plugin-routes）
src/search/      搜索提供端口（SearchClient）与 Bing 实现
```

核心契约是 `ModelClient` 接口（`src/model/model-client.ts`）：Agent 只认识这个接口，生产用 `DeepSeekClient`（OpenAI 兼容协议）实现，测试注入假实现。新增模型厂商 = 实现该接口，不需要改动上层。

`buildApp(options)` 是依赖注入入口：`modelClient`、`apiToken`、`logChatContent`、`loggerInstance` 均可由调用方覆盖——测试因此不需要真实 API Key、外部网络或监听端口。

路由以 `registerXxxRoute(app, deps)` 形式注册：

- `/health` — 探活，不鉴权、不调模型
- `/v1/capabilities` — 能力发现
- `/v1/chat` — 聊天接口
- `/v1/media` — 受控附件上传、下载与删除；Office 文档也只使用 mediaId

Word/PDF/PPTX 工具位于独立 `pan-pilot-office-mcp` 项目，通过 MCP stdio
接入；公开工具名带 `mcp__office__` 前缀，输入输出统一使用 `/v1/media` 的
`mediaId`。PanPilot 主进程不解析 Office 文档，也不安装 `docx`/`unpdf`。
`web_search` 工具走 `SearchClient` 端口（默认 Bing 网页搜索，无 Key；
`SEARCH_BASE_URL` 可覆盖），结果标题/链接/摘要回填模型。

## 关键约定

- **能力声明优先**：新能力（tools/memory/planning/streaming）先改 `src/agent/capabilities.ts` 的状态，而不是让客户端通过调用失败来猜测
- **协议向前兼容**：`/v1/chat` 同时接受旧 `message` 和新 `messages` 格式（二者互斥）；`stream: true` 走 SSE 流式响应（事件格式见下一条）
- **错误码**：400 `INVALID_REQUEST`（zod 校验失败）、502 `CHAT_FAILED`（非流式）——对外隐藏 SDK/网络/密钥细节，详细原因只进服务端日志
- **SSE 约定**：`/v1/chat` 的 `stream: true` 用 `text/event-stream` 返回；事件是 `data: {json}` 行，`type` 为 `content`/`tool_execution`/`done`/`error`；流建立后的失败以 `error` 事件返回，客户端断开则直接终止（响应流 close 时未正常写完会触发 AbortSignal）
- **HTTP 不暴露工具细节**：`/v1/chat` 只返回工具执行摘要（`id`/`name`/`status`）；原始参数和工具结果只回填给模型，可能含敏感数据，不得默认回传 HTTP
- **Agent 安装边界**：`suggest_plugin` 只生成建议（不落盘）；`install_plugin` 可落盘并重载注册表，但默认 fail-closed——未配置 `PAN_PILOT_PLUGIN_AUTO_INSTALL=true` 时调用必失败。两个工具都始终注册在 builtin 集合（供 `plugins/` 同名自引用解析），开关只在执行时生效
- **请求校验用 zod `.strict()`**：拒绝未声明字段，避免拼写错误被静默忽略后仍然调用付费模型
- **TS 严格配置**：`verbatimModuleSyntax` 要求类型导入必须写 `import type`；NodeNext ESM 要求相对导入带 `.js` 后缀；`noUncheckedIndexedAccess` 要求处理索引可能 undefined；`exactOptionalPropertyTypes` 禁止把 `undefined` 显式赋给可选属性
- **注释与用户可见文案用中文**（项目约定），代码标识符用英文
- **思考过程始终显示为中文**：AI 助手在分析、推理与决策时的思考过程，一律使用中文表达
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

`DEEPSEEK_API_KEY` 必填（缺失时 `DeepSeekClient` 构造函数直接抛错）。`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`）、`DEEPSEEK_RESOLVED_ADDRESS`（只覆盖 DeepSeek 主机的 DNS 解析结果，URL 域名保留以维持 Host/TLS SNI/证书校验）、`PAN_PILOT_API_TOKEN`（/v1 路由 Bearer 鉴权，用 `timingSafeEqual` 常时比较；未配置时 /v1 全部放行，含插件变更）、`PAN_PILOT_MEDIA_DIR`（受控附件目录）、`PAN_PILOT_MCP_CONFIG`（MCP Server 配置）、`SEARCH_BASE_URL`（搜索端点，默认 Bing）、`HOST`/`PORT`。完整清单见 `.env.example`；不要提交 `.env`。
插件相关：`PAN_PILOT_PLUGINS_DIR`（插件目录）、`PAN_PILOT_PLUGIN_ALLOWED_HOSTS`（http 插件 host 白名单，默认拒绝）、`PAN_PILOT_PLUGIN_ALLOWED_ENV_VARS`（${env:NAME} 引用白名单，默认拒绝）、`PAN_PILOT_PLUGIN_AUTO_INSTALL`（Agent 自主安装开关，默认关闭）。

## 构建与部署

`Dockerfile` 多阶段构建：build 阶段执行 typecheck + test + build；`bundle` 阶段导出「应用目录 + Linux Node 二进制」的自包含产物，供不装全局 Node 的 systemd 主机直接运行。
