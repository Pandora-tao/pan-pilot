import { describe, expect, it } from "vitest";
import { textStatsTool } from "../src/tools/text-stats.js";
import { defaultToolContext } from "../src/tools/tool.js";

describe("text_stats", () => {
  it("counts Unicode characters, words, sentences, lines and UTF-8 bytes", async () => {
    const result = await textStatsTool.execute(
      { text: "Hello world.\n你好！" },
      defaultToolContext(),
    );

    expect(result).toEqual({
      characters: 16,
      charactersWithoutWhitespace: 14,
      words: 3,
      sentences: 2,
      lines: 2,
      utf8Bytes: 22,
    });
  });

  it("returns zero counts for empty text", async () => {
    await expect(textStatsTool.execute({ text: "" }, defaultToolContext()))
      .resolves.toEqual({
        characters: 0,
        charactersWithoutWhitespace: 0,
        words: 0,
        sentences: 0,
        lines: 0,
        utf8Bytes: 0,
      });
  });

  it("treats a joined emoji as one visible character and rejects extra fields", async () => {
    const result = await textStatsTool.execute(
      { text: "👨‍👩‍👧‍👦" },
      defaultToolContext(),
    );
    expect(result.characters).toBe(1);
    expect(result.utf8Bytes).toBe(25);

    expect(textStatsTool.inputSchema.safeParse({
      text: "hello",
      locale: "en",
    }).success).toBe(false);
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("停止统计"));

    await expect(textStatsTool.execute(
      { text: "hello" },
      defaultToolContext(controller.signal),
    )).rejects.toThrow("停止统计");
  });
});
