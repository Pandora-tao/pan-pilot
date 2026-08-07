import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

/**
 * 单文件网页控制台：/ 与 /console 返回同一个 HTML，
 * 与业务 API 同源，浏览器无需 CORS 即可调用 /v1/*。
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * dev 与构建产物目录深度不同（src/routes 与 dist/src/routes），
 * 逐个候选探测，保证 tsx 与 dist 两种运行方式都能找到页面。
 */
function consoleHtmlCandidates(): string[] {
  return [
    path.resolve(process.cwd(), "web", "console.html"),
    path.resolve(MODULE_DIR, "..", "..", "..", "web", "console.html"),
    path.resolve(MODULE_DIR, "..", "..", "web", "console.html"),
  ];
}

async function readConsoleHtml(): Promise<string> {
  for (const candidate of consoleHtmlCandidates()) {
    try {
      await access(candidate);
      return await readFile(candidate, "utf8");
    } catch {
      // 继续尝试下一个候选。
    }
  }
  throw new Error("web/console.html not found");
}

export function registerConsoleRoute(app: FastifyInstance): void {
  const serveConsole = async (
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    try {
      const html = await readConsoleHtml();
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(html);
    } catch {
      // 发布包漏掉 web 目录时给出可诊断的提示，而不是空白页。
      return reply.code(404).send({
        error: "CONSOLE_NOT_FOUND",
        message: "未找到 web/console.html，请确认发布包包含 web 目录",
      });
    }
  };

  app.get("/", serveConsole);
  app.get("/console", serveConsole);
}
