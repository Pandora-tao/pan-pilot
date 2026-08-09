import { z } from "zod";
import { MEDIA_ID_PATTERN, type MediaStore } from "../media/media-store.js";
import type { AgentTool } from "./tool.js";
import {
  analyzeControlledMedia,
  memoizeProvider,
  type MediaToolOutput,
  type MultimodalClientProvider,
} from "./media-common.js";

const DEFAULT_IMAGE_PROMPT =
  "请描述这张图片的内容：包括主要主体、文字、颜色和构图；如包含风险内容请明确指出。";

const analyzeImageInputSchema = z.object({
  // 工具只接受受控 MediaStore 的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN, "mediaId 格式不正确"),
  prompt: z.string().trim().min(1, "prompt 不能为空").max(2000).optional(),
}).strict();

export type AnalyzeImageInput = z.infer<typeof analyzeImageInputSchema>;

/** 分析用户通过 /v1/media 上传的图片，返回结构化描述供主 Agent 引用。 */
export function createAnalyzeImageTool(
  mediaStore: MediaStore,
  provider: MultimodalClientProvider,
): AgentTool<AnalyzeImageInput, MediaToolOutput> {
  const getClient = memoizeProvider(provider);
  return {
    name: "analyze_image",
    description:
      "分析用户上传的图片（mediaId 来自 /v1/media 上传结果），"
      + "返回主体、文字、颜色等结构化描述；不能用于任意文件路径或远程 URL",
    inputSchema: analyzeImageInputSchema,
    execute(input, signal) {
      return analyzeControlledMedia(
        { mediaStore, provider: getClient },
        input,
        "image",
        DEFAULT_IMAGE_PROMPT,
        signal,
      );
    },
  };
}
