# PanPilot

PanPilot 是一个用于学习和实现 AI Agent 的 TypeScript 工作区。当前仓库只包含工程、运行和部署骨架；Agent Loop、模型适配和工具逻辑由你自行实现。

## 环境

- Node.js 22+
- pnpm 10.33.2

## 目录

```text
src/
├── index.ts       # 服务入口，目前仅提供健康检查
├── agent/         # Agent Loop 与会话控制
├── model/         # DeepSeek、MiMo 等模型适配
└── tools/         # 工具定义、校验与执行
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
