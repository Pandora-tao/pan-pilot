import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "../../src/tools/tool.js";

/** 插件目录规格：值为 manifest 对象；null 表示目录存在但没有 manifest.json。 */
export interface PluginFixtureSpec {
  [dirName: string]: unknown;
}

export function createPluginFixture(spec: PluginFixtureSpec): string {
  const root = mkdtempSync(path.join(tmpdir(), "panpilot-plugins-"));
  for (const [dirName, manifest] of Object.entries(spec)) {
    const dir = path.join(root, dirName);
    mkdirSync(dir);
    if (manifest !== null) {
      writeFileSync(
        path.join(dir, "manifest.json"),
        typeof manifest === "string"
          ? manifest
          : JSON.stringify(manifest, null, 2),
      );
    }
  }
  return root;
}

export function removePluginFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** 与框架无关的测试内置工具，供 builtin 引用用例使用。 */
export function createTestEchoTool(name = "echo"): AgentTool<any, unknown> {
  return {
    name,
    description: "返回输入内容",
    inputSchema: z.object({ value: z.string().min(1) }).strict(),
    async execute(input) {
      return { echoed: input.value };
    },
  };
}

export function httpManifest(name: string, url: string): Record<string, unknown> {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    executor: { type: "http", url },
  };
}
