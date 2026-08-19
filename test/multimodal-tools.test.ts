import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStore } from "../src/media/media-store.js";
import type { MultimodalClient } from "../src/model/multimodal-client.js";
import { defaultToolContext } from "../src/tools/tool.js";
import { createAnalyzeAudioTool } from "../src/tools/analyze-audio.js";
import { createAnalyzeImageTool } from "../src/tools/analyze-image.js";
import type { MultimodalClientProvider } from "../src/tools/media-common.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createTranscribeAudioTool } from "../src/tools/transcribe-audio.js";
import { mp3Bytes, pngBytes } from "./helpers/media-fixture.js";

/*
 * 多模态工具单元测试：用内存假 MultimodalClient 隔离网络，
 * 覆盖成功、未知 mediaId、类型不符、provider 错误、取消与 schema 校验。
 */
describe("multimodal tools", () => {
  let root = "";
  let mediaStore: MediaStore;
  let imageId = "";
  let audioId = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "panpilot-tools-"));
    mediaStore = new MediaStore(root);
    imageId = (await mediaStore.save(pngBytes(), "a.png")).mediaId;
    audioId = (await mediaStore.save(mp3Bytes(), "a.mp3")).mediaId;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("analyzes an image through the provider and returns a structured result", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>().mockResolvedValue({
      content: "图片里有一只猫",
      model: "fake-model",
      totalTokens: 5,
    });
    const tool = createAnalyzeImageTool(mediaStore, providerOf(analyze));

    const result = await tool.execute({ mediaId: imageId, prompt: "有什么？" }, defaultToolContext());

    expect(result).toEqual({
      mediaId: imageId,
      kind: "image",
      summary: "图片里有一只猫",
      model: "fake-model",
    });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      kind: "image",
      mimeType: "image/png",
      format: "png",
      prompt: "有什么？",
      dataBase64: expect.any(String),
    }));
    // 结果与请求都不携带可反推媒体内容的字段名之外的字节信息。
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("uses a default prompt when none is provided", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>().mockResolvedValue({
      content: "描述",
      model: "fake-model",
    });
    const tool = createAnalyzeImageTool(mediaStore, providerOf(analyze));

    await tool.execute({ mediaId: imageId }, defaultToolContext());

    expect(analyze.mock.calls[0]![0].prompt).toContain("描述这张图片");
  });

  it("transcribes audio with a fixed transcription prompt", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>().mockResolvedValue({
      content: "你好，这是测试",
      model: "fake-model",
    });
    const tool = createTranscribeAudioTool(mediaStore, providerOf(analyze));

    const result = await tool.execute({ mediaId: audioId }, defaultToolContext());

    expect(result).toMatchObject({
      mediaId: audioId,
      kind: "audio",
      summary: "你好，这是测试",
    });
    expect(analyze.mock.calls[0]![0]).toMatchObject({
      kind: "audio",
      format: "mp3",
    });
    expect(analyze.mock.calls[0]![0].prompt).toContain("逐字转写");
  });

  it("analyzes audio with language hint from transcribe input", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>().mockResolvedValue({
      content: "转写",
      model: "fake-model",
    });
    const tool = createTranscribeAudioTool(mediaStore, providerOf(analyze));

    await tool.execute({ mediaId: audioId, language: "zh" }, defaultToolContext());

    expect(analyze.mock.calls[0]![0].prompt).toContain("zh 文本");
  });

  it("fails on unknown media ids without calling the provider", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>();
    const tool = createAnalyzeImageTool(mediaStore, providerOf(analyze));

    await expect(tool.execute({ mediaId: "does-not-exist" }, defaultToolContext()))
      .rejects.toThrow("媒体 does-not-exist 不存在");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects media of the wrong kind", async () => {
    const imageTool = createAnalyzeImageTool(mediaStore, providerOf(vi.fn()));
    const audioTool = createAnalyzeAudioTool(mediaStore, providerOf(vi.fn()));

    await expect(imageTool.execute({ mediaId: audioId }, defaultToolContext()))
      .rejects.toThrow("不是图片");
    await expect(audioTool.execute({ mediaId: imageId }, defaultToolContext()))
      .rejects.toThrow("不是音频");
  });

  it("propagates provider errors", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>()
      .mockRejectedValue(new Error("provider 挂了"));
    const tool = createAnalyzeImageTool(mediaStore, providerOf(analyze));

    await expect(tool.execute({ mediaId: imageId }, defaultToolContext()))
      .rejects.toThrow("provider 挂了");
  });

  it("propagates cancellation without calling the provider", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>();
    const tool = createAnalyzeAudioTool(mediaStore, providerOf(analyze));
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));

    await expect(tool.execute({ mediaId: audioId }, defaultToolContext(controller.signal)))
      .rejects.toThrow("用户取消");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("forwards the signal to the provider", async () => {
    const analyze = vi.fn<MultimodalClient["analyze"]>().mockResolvedValue({
      content: "ok",
      model: "fake-model",
    });
    const tool = createAnalyzeImageTool(mediaStore, providerOf(analyze));
    const controller = new AbortController();

    await tool.execute({ mediaId: imageId }, defaultToolContext(controller.signal));

    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it("rejects invalid inputs and unsafe media ids through the registry", async () => {
    const tool = createAnalyzeImageTool(mediaStore, providerOf(vi.fn()));
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("analyze_image", { mediaId: "../secret" }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    await expect(registry.execute("analyze_image", {}))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    await expect(registry.execute("analyze_image", { mediaId: "a.png", extra: 1 }))
      .rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
  });

  it("wraps unknown media ids as tool execution failures in the registry", async () => {
    const tool = createAnalyzeImageTool(mediaStore, providerOf(vi.fn()));
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("analyze_image", { mediaId: "nope" }))
      .rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
  });
});

function providerOf(analyze: MultimodalClient["analyze"]): MultimodalClientProvider {
  const fake: MultimodalClient = { analyze };
  return () => fake;
}
