import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite 控制台构建产物目录。开发源码位于 web/src，运行时只暴露 web/dist，
 * 防止服务端把源文件、source config 或其他仓库内容当成静态资源发布。
 */
function consoleDistCandidates(): string[] {
  return [
    path.resolve(process.cwd(), "web", "dist"),
    path.resolve(MODULE_DIR, "..", "..", "..", "web", "dist"),
    path.resolve(MODULE_DIR, "..", "..", "web", "dist"),
  ];
}

async function findConsoleDist(): Promise<string> {
  for (const candidate of consoleDistCandidates()) {
    try {
      await access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // 继续尝试开发与 dist 运行目录对应的候选。
    }
  }
  throw new Error("web/dist/index.html not found");
}

async function serveConsole(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    const root = await findConsoleDist();
    const html = await readFile(path.join(root, "index.html"), "utf8");
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(html);
  } catch {
    return reply.code(404).send({
      error: "CONSOLE_NOT_FOUND",
      message: "未找到 web/dist/index.html，请先运行 pnpm build:web",
    });
  }
}

export function registerConsoleRoute(app: FastifyInstance): void {
  app.get("/", serveConsole);
  app.get("/console", serveConsole);
  app.get("/console/", serveConsole);
  app.get<{ Params: { "*": string } }>(
    "/console/*",
    async (request, reply) => {
      let root: string;
      try {
        root = await findConsoleDist();
      } catch {
        return reply.code(404).send({
          error: "CONSOLE_NOT_FOUND",
          message: "未找到控制台构建产物，请先运行 pnpm build:web",
        });
      }

      const relativePath = request.params["*"];
      const assetPath = path.resolve(root, relativePath);
      if (!assetPath.startsWith(root + path.sep)) {
        return reply.code(400).send({
          error: "INVALID_CONSOLE_ASSET",
          message: "静态资源路径不正确",
        });
      }

      try {
        const content = await readFile(assetPath);
        return reply
          .header("content-type", contentTypeFor(assetPath))
          .header("cache-control", "public, max-age=31536000, immutable")
          .send(content);
      } catch {
        return reply.code(404).send({
          error: "CONSOLE_ASSET_NOT_FOUND",
          message: "控制台静态资源不存在",
        });
      }
    },
  );
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
