import type { FastifyInstance } from "fastify";
import type { ConsoleAuth } from "../auth/console-auth.js";

const FAILURE_WINDOW_MS = 10 * 60 * 1_000;
const MAX_FAILURES = 5;

interface LoginAttempt {
  failures: number;
  windowStartedAt: number;
}

interface LoginBody {
  password: string;
}

/** 注册公开的密码换通行证接口；所有其他 /v1/* 仍由全局鉴权钩子保护。 */
export function registerConsoleAuthRoute(app: FastifyInstance, auth: ConsoleAuth): void {
  const attempts = new Map<string, LoginAttempt>();

  // 公开只读状态：只有服务端同时配置了 API token 与控制台密码时，前端才需要弹登录框。
  app.get("/v1/auth/status", async () => ({ loginRequired: auth.configured }));

  app.post<{ Body: LoginBody }>("/v1/auth/login", {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["password"],
        properties: {
          password: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    if (!auth.configured) {
      return reply.code(503).send({
        error: "CONSOLE_AUTH_NOT_CONFIGURED",
        message: "控制台密码登录尚未配置",
      });
    }

    const now = Date.now();
    const previous = attempts.get(request.ip);
    const current = previous && now - previous.windowStartedAt < FAILURE_WINDOW_MS
      ? previous
      : { failures: 0, windowStartedAt: now };
    if (current.failures >= MAX_FAILURES) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.windowStartedAt + FAILURE_WINDOW_MS - now) / 1_000),
      );
      reply.header("retry-after", String(retryAfterSeconds));
      return reply.code(429).send({
        error: "TOO_MANY_LOGIN_ATTEMPTS",
        message: "密码尝试次数过多，请稍后再试",
      });
    }

    if (!auth.verifyPassword(request.body.password)) {
      attempts.set(request.ip, { ...current, failures: current.failures + 1 });
      return reply.code(401).send({
        error: "INVALID_CONSOLE_PASSWORD",
        message: "控制台密码不正确",
      });
    }

    attempts.delete(request.ip);
    return reply.send(auth.issuePassport());
  });
}
