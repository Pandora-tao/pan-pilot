import { z } from "zod";
import type { AgentTool } from "./tool.js";

const textStatsInputSchema = z.object({
  text: z.string().max(100_000, "text 最多 100000 个 UTF-16 代码单元"),
}).strict();

export type TextStatsInput = z.infer<typeof textStatsInputSchema>;

export interface TextStatsOutput {
  characters: number;
  charactersWithoutWhitespace: number;
  words: number;
  sentences: number;
  lines: number;
  utf8Bytes: number;
}

const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const sentenceSegmenter = new Intl.Segmenter("zh-CN", {
  granularity: "sentence",
});
const characterSegmenter = new Intl.Segmenter("zh-CN", {
  granularity: "grapheme",
});

/** 按字素簇与 Intl.Segmenter 统计，中英文混排时也不会把每个汉字误作一词。 */
export const textStatsTool: AgentTool<TextStatsInput, TextStatsOutput> = {
  name: "text_stats",
  description:
    "按可见字素统计文本的字符数、非空白字符数、词数、句数、行数和 UTF-8 字节数。",
  inputSchema: textStatsInputSchema,
  async execute(input, signal) {
    signal?.throwIfAborted();

    const characters = [...characterSegmenter.segment(input.text)];
    const charactersWithoutWhitespace = characters
      .filter((character) => !/^\s+$/u.test(character.segment))
      .length;
    const words = [...wordSegmenter.segment(input.text)]
      .filter((segment) => segment.isWordLike)
      .length;
    const sentences = [...sentenceSegmenter.segment(input.text)]
      .filter((segment) => segment.segment.trim().length > 0)
      .length;

    return {
      characters: characters.length,
      charactersWithoutWhitespace,
      words,
      sentences,
      lines: input.text.length === 0 ? 0 : input.text.split(/\r\n|\r|\n/u).length,
      utf8Bytes: Buffer.byteLength(input.text, "utf8"),
    };
  },
};
