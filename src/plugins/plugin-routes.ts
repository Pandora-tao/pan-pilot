import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";
import { PLUGIN_NAME_PATTERN } from "./manifest-schema.js";
import type { PluginApprovalService } from "./plugin-approval-service.js";
import {
  PluginApprovalError,
  type PluginApprovalErrorCode,
} from "./plugin-approval-error.js";
import type { PluginManager } from "./plugin-manager.js";

export interface PluginRouteOptions {
  /**
   * 是否已配置 PAN_PILOT_API_TOKEN。
   * 未配置时 approve/reject/execute 等副作用审批入口 fail-closed 拒绝，
   * 匿名只能创建草案，不能批准或执行任何动作。
   */
  approvalAuthConfigured: boolean;
}

/**
 * 插件操作接口（沿用 /v1/* 的 Bearer 鉴权钩子）。
 *
 * 所有有副作用的变更（新建写入、重载、启停）都走同一套审批协议：
 * POST /v1/plugins/approvals 创建草案 → approve → execute。
 * 模型工具只暴露 create_plugin（草案）；approve/reject/execute 只走 HTTP，
 * 模型无法批准自己的动作。
 *
 * 兼容入口 POST /v1/plugins/reload 与 /v1/plugins/:name/enable|disable
 * 不再直接执行，而是创建对应草案并返回 approval，调用方仍需批准并执行。
 */
export function registerPluginRoutes(
  app: FastifyInstance,
  pluginManager: PluginManager,
  approvalService: PluginApprovalService,
  options: PluginRouteOptions,
): void {
  app.get("/v1/plugins", async () => ({
    plugins: pluginManager.listStatuses(),
  }));

  app.get("/v1/plugins/approvals", async () => ({
    approvals: approvalService.listApprovals(),
  }));

  app.post("/v1/plugins/approvals", async (request, reply) => {
    const parsed = approvalCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "请求参数不正确",
        details: parsed.error.issues,
      });
    }
    try {
      const approval = approvalService.createDraft(parsed.data.action);
      return reply.code(201).send({ approval });
    } catch (error) {
      return handleApprovalError(reply, error);
    }
  });

  app.post("/v1/plugins/approvals/:id/approve", async (request, reply) => {
    if (!guardApprovalAuth(reply, options.approvalAuthConfigured)) return;
    const parsed = approvalMutationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "请求参数不正确",
        details: parsed.error.issues,
      });
    }
    try {
      const approval = approvalService.approve(
        (request.params as { id: string }).id,
        parsed.data.hash,
      );
      return { approval };
    } catch (error) {
      return handleApprovalError(reply, error);
    }
  });

  app.post("/v1/plugins/approvals/:id/reject", async (request, reply) => {
    if (!guardApprovalAuth(reply, options.approvalAuthConfigured)) return;
    try {
      const approval = approvalService.reject(
        (request.params as { id: string }).id,
      );
      return { approval };
    } catch (error) {
      return handleApprovalError(reply, error);
    }
  });

  app.post("/v1/plugins/approvals/:id/execute", async (request, reply) => {
    if (!guardApprovalAuth(reply, options.approvalAuthConfigured)) return;
    const parsed = approvalMutationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "请求参数不正确",
        details: parsed.error.issues,
      });
    }
    try {
      const outcome = await approvalService.execute(
        (request.params as { id: string }).id,
        parsed.data.hash,
      );
      return { approval: outcome.approval, result: outcome.result };
    } catch (error) {
      return handleApprovalError(reply, error);
    }
  });

  // 兼容入口：重载现在是待审批的一次性动作，不再直接生效。
  app.post("/v1/plugins/reload", async (_request, reply) => {
    try {
      const approval = approvalService.createDraft({ type: "reload_plugins" });
      return reply.code(201).send({
        approval,
        message: "重载需要审批：请调用 approve 批准后 execute 执行",
      });
    } catch (error) {
      return handleApprovalError(reply, error);
    }
  });

  app.post("/v1/plugins/:name/enable", async (request, reply) => {
    return setEnabledDraft(request, reply, pluginManager, approvalService, true);
  });

  app.post("/v1/plugins/:name/disable", async (request, reply) => {
    return setEnabledDraft(request, reply, pluginManager, approvalService, false);
  });
}

async function setEnabledDraft(
  request: FastifyRequest,
  reply: FastifyReply,
  pluginManager: PluginManager,
  approvalService: PluginApprovalService,
  enabled: boolean,
) {
  const name = (request.params as { name: string }).name;
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    return reply.code(404).send({
      error: "PLUGIN_NOT_FOUND",
      message: `插件 ${name} 不存在`,
    });
  }
  if (pluginManager.getStatus(name) === undefined) {
    return reply.code(404).send({
      error: "PLUGIN_NOT_FOUND",
      message: `插件 ${name} 不存在`,
    });
  }
  try {
    const approval = approvalService.createDraft({
      type: "set_plugin_enabled",
      plugin: name,
      enabled,
    });
    return reply.code(201).send({
      approval,
      message: "启停需要审批：请调用 approve 批准后 execute 执行",
    });
  } catch (error) {
    return handleApprovalError(reply, error);
  }
}

const approvalCreateSchema = z.object({
  action: z.unknown(),
}).strict();

const approvalMutationSchema = z.object({
  // 审批动作必须携带 64 位十六进制动作哈希：缺失或格式错误由路由拒绝（400），
  // 内容不符由服务拒绝（409），批准/执行都绑定同一份冻结动作。
  hash: z.string().regex(
    /^[0-9a-f]{64}$/,
    "hash 必须是 64 位十六进制动作哈希",
  ),
}).strict();

function guardApprovalAuth(
  reply: FastifyReply,
  configured: boolean,
): boolean {
  if (configured) return true;
  reply.code(503).send({
    error: "AUTH_NOT_CONFIGURED",
    message:
      "服务未配置 PAN_PILOT_API_TOKEN，审批执行接口拒绝服务（fail-closed）；"
      + "配置令牌后重试",
  });
  return false;
}

function handleApprovalError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PluginApprovalError) {
    return reply.code(statusFor(error.code)).send({
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  throw error;
}

function statusFor(code: PluginApprovalErrorCode): number {
  switch (code) {
    case "PLUGIN_VALIDATION_FAILED":
      return 400;
    case "APPROVAL_NOT_FOUND":
    case "PLUGIN_NOT_FOUND":
      return 404;
    case "PLUGIN_APPLY_FAILED":
      return 500;
    case "AUTH_NOT_CONFIGURED":
      return 503;
    default:
      return 409;
  }
}
