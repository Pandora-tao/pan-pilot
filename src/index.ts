import { buildApp } from "./app.js";

// 进程入口只负责读取运行环境并监听端口，应用组装留在可测试的 buildApp 中。
const app = buildApp();

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host, port });
