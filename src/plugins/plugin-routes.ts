import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PLUGIN_NAME_PATTERN } from "./manifest-schema.js";
import {
  PluginOperationError,
  type PluginOperationErrorCode,
} from "./plugin-operation-error.js";
import type { PluginManager } from "./plugin-manager.js";
import type { PluginService } from "./plugin-service.js";

/**
 * 单用户插件接口：用户可以直接安装、重载和启停；Agent 产生的建议由用户选择
 * 安装或忽略。鉴权完全跟随全局 /v1 Bearer 钩子：配置了 PAN_PILOT_API_TOKEN
 * 时所有 /v1/*（含插件变更）都要求正确令牌，未配置时全部放行。
 */
export function registerPluginRoutes(
  app: FastifyInstance,
  pluginManager: PluginManager,
  pluginService: PluginService,
): void {
  app.get("/v1/plugins", async () => ({
    plugins: pluginManager.listStatuses(),
  }));

  app.get("/v1/plugins/suggestions", async () => ({
    suggestions: pluginService.listSuggestions(),
  }));

  app.post("/v1/plugins/install", async (request, reply) => {
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);
    try {
      return reply.code(201).send({
        result: pluginService.install(parsed.data.manifest),
      });
    } catch (error) {
      return handlePluginError(reply, error);
    }
  });

  app.post("/v1/plugins/suggestions/:id/install", async (request, reply) => {
    try {
      return reply.code(201).send(pluginService.installSuggestion(
        (request.params as { id: string }).id,
      ));
    } catch (error) {
      return handlePluginError(reply, error);
    }
  });

  app.delete("/v1/plugins/suggestions/:id", async (request, reply) => {
    try {
      return {
        suggestion: pluginService.dismissSuggestion(
          (request.params as { id: string }).id,
        ),
      };
    } catch (error) {
      return handlePluginError(reply, error);
    }
  });

  app.post("/v1/plugins/reload", async (_request, reply) => {
    try {
      return { result: pluginService.reload() };
    } catch (error) {
      return handlePluginError(reply, error);
    }
  });

  app.post("/v1/plugins/:name/enable", async (request, reply) => {
    return setEnabled(request.params as { name: string }, reply, pluginService, true);
  });

  app.post("/v1/plugins/:name/disable", async (request, reply) => {
    return setEnabled(request.params as { name: string }, reply, pluginService, false);
  });
}

function setEnabled(
  params: { name: string },
  reply: FastifyReply,
  pluginService: PluginService,
  enabled: boolean,
) {
  if (!PLUGIN_NAME_PATTERN.test(params.name)) {
    return reply.code(404).send({
      error: "PLUGIN_NOT_FOUND",
      message: `插件 ${params.name} 不存在`,
    });
  }
  try {
    return { plugin: pluginService.setEnabled(params.name, enabled) };
  } catch (error) {
    return handlePluginError(reply, error);
  }
}

const installSchema = z.object({ manifest: z.unknown() }).strict();

function invalidRequest(reply: FastifyReply, details: unknown): FastifyReply {
  return reply.code(400).send({
    error: "INVALID_REQUEST",
    message: "请求参数不正确",
    details,
  });
}

function handlePluginError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PluginOperationError) {
    return reply.code(statusFor(error.code)).send({
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  throw error;
}

function statusFor(code: PluginOperationErrorCode): number {
  switch (code) {
    case "PLUGIN_VALIDATION_FAILED":
      return 400;
    case "PLUGIN_NOT_FOUND":
    case "PLUGIN_SUGGESTION_NOT_FOUND":
      return 404;
    case "PLUGIN_APPLY_FAILED":
      return 500;
    case "AUTH_NOT_CONFIGURED":
      return 503;
    default:
      return 409;
  }
}
