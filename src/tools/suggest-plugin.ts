import { z } from "zod";
import type { PluginService } from "../plugins/plugin-service.js";
import type { AnyAgentTool } from "./tool.js";

/** Agent 只能推荐插件；安装、启停和重载都由用户从控制台发起。 */
export function createSuggestPluginTool(
  serviceRef: () => PluginService,
): AnyAgentTool {
  return {
    name: "suggest_plugin",
    description:
      "向用户推荐一个声明式插件并加入控制台的待安装列表；"
      + "不会写入磁盘或启用插件，必须由用户自行点击安装",
    inputSchema: z.object({ manifest: z.unknown() }).strict(),
    async execute(input) {
      const suggestion = serviceRef().suggest(
        (input as { manifest: unknown }).manifest,
      );
      return { suggestion };
    },
  };
}
