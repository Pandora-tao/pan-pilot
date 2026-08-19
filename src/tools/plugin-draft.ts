import { z } from "zod";
import type { SandboxPackageManager } from "../extension/package-manager.js";
import type { AnyAgentTool } from "./tool.js";

/**
 * Agent 开发工具（仅交互式聊天）：创建 / 更新 / 校验 / 提交沙箱插件草稿。
 * - 定时任务调用被拒（ctx.origin !== "chat"）；
 * - 依赖安装、构建只在这些工具里发起，且每次调用独立受控；
 * - 只能提交候选包，安装必须由已鉴权用户接口完成。
 */

const manifestField = z.unknown();
const filesSchema = z.array(z.object({
  path: z.string().min(1).max(4096),
  content: z.string(),
}).strict()).max(200);

const createSchema = z.object({
  manifest: manifestField,
  files: filesSchema.optional(),
}).strict();

const updateSchema = z.object({
  draftId: z.string().min(1).max(200),
  manifest: manifestField.optional(),
  files: filesSchema.optional(),
}).strict();

const idSchema = z.object({ draftId: z.string().min(1).max(200) }).strict();

export function createPluginDraftTools(
  managerRef: () => SandboxPackageManager,
): AnyAgentTool[] {
  const manager = (): SandboxPackageManager => managerRef();

  return [
    {
      name: "plugin_draft_create",
      description:
        "创建一个沙箱插件草稿：入参 manifest（apiVersion 固定为 pan-pilot.plugin/v2、"
        + "runtime.type 为 sandbox-js）与可选 files（源码/测试）。仅限交互式聊天调用，"
        + "定时任务不得生成代码包。优先复用现有工具；只有用户明确要求，或确实缺少能力时才使用。",
      inputSchema: createSchema,
      async execute(input, ctx) {
        if (ctx.origin !== "chat") {
          return { error: "CHAT_ONLY", message: "开发工具仅限交互式聊天调用" };
        }
        const record = await manager().createDraft(
          (input as { manifest: unknown }).manifest,
          ((input as { files?: unknown[] }).files ?? []) as Array<{ path: string; content: string }>,
        );
        return { draftId: record.id, name: record.name, version: record.version, state: record.state };
      },
    },
    {
      name: "plugin_draft_update",
      description: "按文件更新草稿内容；禁止路径穿越、符号链接与非法文件类型。",
      inputSchema: updateSchema,
      async execute(input, ctx) {
        if (ctx.origin !== "chat") {
          return { error: "CHAT_ONLY", message: "开发工具仅限交互式聊天调用" };
        }
        const record = await manager().updateDraft(
          input.draftId,
          (input as { manifest?: unknown }).manifest,
          ((input as { files?: unknown[] }).files ?? []) as Array<{ path: string; content: string }>,
        );
        return { draftId: record.id, state: record.state, updatedAt: record.updatedAt };
      },
    },
    {
      name: "plugin_draft_validate",
      description:
        "校验草稿：类型检查 → 安装精确版本依赖（--ignore-scripts）→ esbuild 浏览器构建 → 沙箱测试，"
        + "产出报告。失败时草稿保持可编辑并返回诊断。仅限交互式聊天。",
      inputSchema: idSchema,
      async execute(input, ctx) {
        if (ctx.origin !== "chat") {
          return { error: "CHAT_ONLY", message: "开发工具仅限交互式聊天调用" };
        }
        const { ok, report } = await manager().validateDraft(input.draftId);
        return { draftId: input.draftId, ok, report };
      },
    },
    {
      name: "plugin_draft_submit",
      description:
        "冻结已通过校验的草稿并生成待审核候选包（含 integrity 摘要）。"
        + "候选包不会自动安装，需要用户在控制台审核确认后由服务端安装启用。",
      inputSchema: idSchema,
      async execute(input, ctx) {
        if (ctx.origin !== "chat") {
          return { error: "CHAT_ONLY", message: "开发工具仅限交互式聊天调用" };
        }
        const candidate = await manager().submitCandidate(input.draftId);
        return {
          candidateId: candidate.id,
          name: candidate.name,
          version: candidate.version,
          digest: candidate.digest,
          note: "请在控制台「待审核扩展」中确认并安装",
        };
      },
    },
  ];
}
