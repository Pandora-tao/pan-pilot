import { z } from "zod";
import { MEDIA_ID_PATTERN, type MediaStore } from "../media/media-store.js";
import type { AgentTool } from "./tool.js";
import {
  analyzeControlledMedia,
  memoizeProvider,
  type MediaToolOutput,
  type MultimodalClientProvider,
} from "./media-common.js";

const DEFAULT_AUDIO_PROMPT =
  "请分析这段音频：先逐字转写语音内容，再说明说话人数量、语气与背景声音。";

const analyzeAudioInputSchema = z.object({
  // 工具只接受受控 MediaStore 的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN, "mediaId 格式不正确"),
  prompt: z.string().trim().min(1, "prompt 不能为空").max(2000).optional(),
}).strict();

export type AnalyzeAudioInput = z.infer<typeof analyzeAudioInputSchema>;

/** 分析用户上传的音频（转写 + 语音/情绪/背景理解），结果回填主 Agent。 */
export function createAnalyzeAudioTool(
  mediaStore: MediaStore,
  provider: MultimodalClientProvider,
): AgentTool<AnalyzeAudioInput, MediaToolOutput> {
  const getClient = memoizeProvider(provider);
  return {
    name: "analyze_audio",
    description:
      "分析用户上传的音频（mediaId 来自 /v1/media 上传结果）："
      + "转写语音并描述说话人、语气与背景声音；不能用于任意文件路径或远程 URL",
    inputSchema: analyzeAudioInputSchema,
    execute(input, ctx) {
      return analyzeControlledMedia(
        { mediaStore, provider: getClient },
        input,
        "audio",
        DEFAULT_AUDIO_PROMPT,
        ctx.signal,
      );
    },
  };
}
