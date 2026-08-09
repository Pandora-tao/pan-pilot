import { z } from "zod";
import { MEDIA_ID_PATTERN, type MediaStore } from "../media/media-store.js";
import type { AgentTool } from "./tool.js";
import {
  analyzeControlledMedia,
  memoizeProvider,
  type MediaToolOutput,
  type MultimodalClientProvider,
} from "./media-common.js";

const DEFAULT_TRANSCRIBE_PROMPT =
  "请逐字转写这段音频中的语音内容；如有多个说话人，请按出现顺序标注。"
  + "只输出转写文本。";

const transcribeAudioInputSchema = z.object({
  // 工具只接受受控 MediaStore 的 mediaId，不接受文件路径或远程 URL。
  mediaId: z.string().regex(MEDIA_ID_PATTERN, "mediaId 格式不正确"),
  language: z.string().trim().min(1, "language 不能为空").max(20).optional(),
}).strict();

export type TranscribeAudioInput = z.infer<typeof transcribeAudioInputSchema>;

/** 逐字转写用户上传的音频（固定转写提示词，结果回填主 Agent）。 */
export function createTranscribeAudioTool(
  mediaStore: MediaStore,
  provider: MultimodalClientProvider,
): AgentTool<TranscribeAudioInput, MediaToolOutput> {
  const getClient = memoizeProvider(provider);
  return {
    name: "transcribe_audio",
    description:
      "将用户上传的音频（mediaId 来自 /v1/media 上传结果）中的语音逐字转写为文本；"
      + "不能用于任意文件路径或远程 URL",
    inputSchema: transcribeAudioInputSchema,
    execute(input, signal) {
      const prompt = input.language === undefined
        ? DEFAULT_TRANSCRIBE_PROMPT
        : `请将这段音频中的语音逐字转写为 ${input.language} 文本；`
          + "如有多个说话人，请按出现顺序标注。只输出转写文本。";
      return analyzeControlledMedia(
        { mediaStore, provider: getClient },
        input,
        "audio",
        prompt,
        signal,
      );
    },
  };
}
