import { z } from "zod";
import type { AnyAgentTool } from "../tools/tool.js";
import {
  assertHttpExecutorPolicy,
  executeHttpRequest,
  type HttpExecutorRuntimeOptions,
} from "./http-executor.js";
import type { PluginManifest } from "./manifest-schema.js";

/**
 * 把声明式 manifest 变成可执行工具。
 *
 * - builtin：委托框架内注册的实现。参数校验以实现自身的 zod schema 为准，
 *   保证迁移前后行为完全一致；manifest.parameters 作为同源生成的声明快照。
 * - http：manifest.parameters 是唯一校验源（fromJSONSchema），执行走 http executor。
 */
export function createDeclarativeTool(
  manifest: PluginManifest,
  builtinTools: ReadonlyMap<string, AnyAgentTool>,
  httpOptions: HttpExecutorRuntimeOptions,
): AnyAgentTool {
  const executor = manifest.executor;
  if (executor.type === "builtin") {
    const builtin = builtinTools.get(executor.ref);
    if (!builtin) {
      throw new Error(`builtin 引用 ${executor.ref} 不存在`);
    }
    return {
      name: manifest.name,
      description: manifest.description,
      inputSchema: builtin.inputSchema,
      execute: (input, ctx) => builtin.execute(input, ctx),
    };
  }

  // JSON Schema -> zod；不受支持的结构会在这里抛错，由加载方记为该插件错误。
  const inputSchema = z.fromJSONSchema(
    manifest.parameters as Record<string, unknown>,
  );
  // 构造期策略校验：https、静态 host 白名单（默认拒绝）、环境变量名白名单。
  // 加载与草案阶段都通过本函数落地同一份安全策略。
  assertHttpExecutorPolicy(executor, httpOptions);
  return {
    name: manifest.name,
    description: manifest.description,
    inputSchema,
    async execute(input, ctx) {
      return executeHttpRequest(
        executor,
        input as Record<string, unknown>,
        httpOptions,
        ctx.signal,
      );
    },
  };
}
