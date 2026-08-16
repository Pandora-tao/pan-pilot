import { z } from "zod";
import {
  artifactFormatSchema,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from "../artifacts/artifact-store.js";
import type { AgentTool } from "./tool.js";

export const MAX_CODE_ARTIFACT_TOOL_CHARS = 8_000;

const createCodeArtifactInputSchema = z.object({
  name: z.string().trim().min(1, "name 不能为空").max(100)
    .regex(/^[^\\/]+$/, "name 不能包含路径"),
  format: artifactFormatSchema,
  content: z.string().min(1, "content 不能为空").max(MAX_CODE_ARTIFACT_TOOL_CHARS)
    .refine(
      (content) => Buffer.byteLength(content, "utf8") <= MAX_ARTIFACT_BYTES,
      `content 的 UTF-8 大小不能超过 ${MAX_ARTIFACT_BYTES} 字节`,
    ),
}).strict();

export type CreateCodeArtifactInput = z.infer<typeof createCodeArtifactInputSchema>;

export interface CreateCodeArtifactOutput {
  artifactId: string;
  name: string;
  format: CreateCodeArtifactInput["format"];
  sizeBytes: number;
  downloadUrl: string;
}

/** 保存单文件 UTF-8 源码，不执行、不渲染，也不接受任意路径或二进制内容。 */
export function createCodeArtifactTool(
  store: ArtifactStore,
): AgentTool<CreateCodeArtifactInput, CreateCodeArtifactOutput> {
  return {
    name: "create_code_artifact",
    description:
      "把完整的单文件 HTML、CSS、JavaScript、TypeScript、JSON、Markdown 或纯文本源码"
      + "保存为可下载代码产物；适合网页、小游戏和代码示例。工具不会执行或预览代码。"
      + "content 必须是 8000 字符以内、无需外部资源即可工作的紧凑 MVP；若功能较多，"
      + "优先保留核心可玩功能，不得输出半截源码。保存成功后只需向用户说明结果并给出"
      + " downloadUrl，不要重复整份源码。",
    inputSchema: createCodeArtifactInputSchema,
    async execute(input, signal) {
      signal?.throwIfAborted();
      const artifact = await store.save(input);
      signal?.throwIfAborted();
      return {
        artifactId: artifact.id,
        name: artifact.name,
        format: artifact.format,
        sizeBytes: artifact.sizeBytes,
        downloadUrl: `/v1/artifacts/${artifact.id}`,
      };
    },
  };
}
