import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PLUGIN_NAME_PATTERN } from "./manifest-schema.js";
import {
  PluginOperationError,
  type PluginOperationErrorCode,
} from "./plugin-operation-error.js";
import type { PluginManager } from "./plugin-manager.js";
import type { PluginService } from "./plugin-service.js";
import type { SandboxPackageManager } from "../extension/package-manager.js";
import { ExtensionError } from "../extension/validate.js";

/**
 * 单用户插件接口：用户可以直接安装、重载和启停；Agent 产生的建议由用户选择
 * 安装或忽略。鉴权完全跟随全局 /v1 Bearer 钩子：配置了 PAN_PILOT_API_TOKEN
 * 时所有 /v1/*（含插件变更）都要求正确令牌，未配置时全部放行。
 *
 * sandbox 传入时，/v1/plugins 合并展示沙箱包，且 enable/disable/versions/
 * rollback/uninstall 按名字分派给沙箱管理器（沙箱包优先）。
 */
export function registerPluginRoutes(
  app: FastifyInstance,
  pluginManager: PluginManager,
  pluginService: PluginService,
  sandbox?: SandboxPackageManager,
): void {
  app.get("/v1/plugins", async () => {
    const declarative = pluginManager.listStatuses().map((status) => ({
      ...status,
      kind: "declarative" as const,
    }));
    const sandboxEntries = await (sandbox === undefined
      ? Promise.resolve([])
      : sandbox.listInstalled().then((records) => records.map((record) => ({
          name: record.name,
          kind: "sandbox-js" as const,
          description: `沙箱扩展 ${record.name}`,
          version: record.activeVersion,
          runtime: "sandbox-js",
          capabilities: ["sandbox-js"],
          activeVersion: record.activeVersion,
          enabled: record.enabled,
          toolNames: [],
        }))));
    return { plugins: [...sandboxEntries, ...declarative] };
  });

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
    return setEnabled(request.params as { name: string }, reply, pluginService, sandbox, true);
  });

  app.post("/v1/plugins/:name/disable", async (request, reply) => {
    return setEnabled(request.params as { name: string }, reply, pluginService, sandbox, false);
  });

  // ---- 沙箱包生命周期（仅当管理器存在且名字归属沙箱包）----
  app.get("/v1/plugins/:name/versions", async (request, reply) => {
    if (sandbox === undefined) return sandboxUnavailable(reply);
    const params = nameParam(request.params);
    if (params === undefined) return notFound(reply, "包不存在");
    try {
      return { versions: await sandbox.getVersions(params) };
    } catch (error) {
      return handleSandboxError(reply, error);
    }
  });

  app.post("/v1/plugins/:name/rollback", async (request, reply) => {
    if (sandbox === undefined) return sandboxUnavailable(reply);
    const params = nameParam(request.params);
    if (params === undefined) return notFound(reply, "包不存在");
    try {
      return { package: await sandbox.rollback(params) };
    } catch (error) {
      return handleSandboxError(reply, error);
    }
  });

  app.delete("/v1/plugins/:name", async (request, reply) => {
    if (sandbox === undefined) return sandboxUnavailable(reply);
    const params = nameParam(request.params);
    if (params === undefined) return notFound(reply, "包不存在");
    const body = z.object({ deleteStorage: z.boolean().optional() }).strict()
      .safeParse(request.body ?? {});
    if (!body.success) return invalidRequest(reply, body.error.issues);
    try {
      await sandbox.uninstall(params, { deleteStorage: body.data.deleteStorage ?? false });
      return reply.code(204).send();
    } catch (error) {
      return handleSandboxError(reply, error);
    }
  });
}

function nameParam(rawParams: unknown): string | undefined {
  const name = (rawParams as { name?: unknown }).name;
  return typeof name === "string" && PLUGIN_NAME_PATTERN.test(name) ? name : undefined;
}

function sandboxUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: "NOT_ENABLED",
    message: "自我扩展未启用",
  });
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: "PLUGIN_NOT_FOUND", message });
}

function handleSandboxError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ExtensionError) {
    return reply.code(statusForSandbox(error.code)).send({
      error: error.code,
      message: error.message,
    });
  }
  throw error;
}

function statusForSandbox(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "NOT_ENABLED":
      return 503;
    case "DIGEST_MISMATCH":
    case "VERSION_REGRESSION":
    case "ALREADY_INSTALLED":
    case "DUPLICATE_DECISION":
    case "CANDIDATE_EXPIRED":
      return 409;
    case "FORBIDDEN":
      return 403;
    default:
      return 400;
  }
}

function setEnabled(
  params: { name: string },
  reply: FastifyReply,
  pluginService: PluginService,
  sandbox: SandboxPackageManager | undefined,
  enabled: boolean,
) {
  if (!PLUGIN_NAME_PATTERN.test(params.name)) {
    return reply.code(404).send({
      error: "PLUGIN_NOT_FOUND",
      message: `插件 ${params.name} 不存在`,
    });
  }
  try {
    // 沙箱包优先；否则走声明式插件。
    const sandboxHandler = sandbox === undefined
      ? undefined
      : () => sandbox.setEnabled(params.name, enabled).then(() => ({ name: params.name, enabled }));
    if (sandboxHandler !== undefined) {
      return handleSandboxWithFallback(reply, sandboxHandler, () => pluginService.setEnabled(params.name, enabled));
    }
    return { plugin: pluginService.setEnabled(params.name, enabled) };
  } catch (error) {
    return handlePluginError(reply, error);
  }
}

async function handleSandboxWithFallback(
  reply: FastifyReply,
  sandboxAction: () => Promise<unknown>,
  fallback: () => unknown,
): Promise<FastifyReply | unknown> {
  try {
    const result = await sandboxAction();
    return { package: result };
  } catch (error) {
    if (error instanceof ExtensionError && error.code === "NOT_FOUND") {
      return { plugin: fallback() };
    }
    return handleSandboxError(reply, error);
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
