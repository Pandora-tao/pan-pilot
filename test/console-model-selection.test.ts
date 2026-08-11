import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseModelId,
  modelDisplayLabel,
} from "../web/src/model-selection.js";
import type { ModelsResponse } from "../web/src/types.js";

const catalog: ModelsResponse = {
  defaultModelId: "volcengine/deepseek-v4-flash",
  models: [
    {
      id: "volcengine/deepseek-v4-flash",
      provider: "volcengine",
      label: "火山方舟 · DeepSeek V4 Flash",
      upstreamModel: "deepseek-v4-flash",
      status: "available",
    },
    {
      id: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      label: "DeepSeek 官方 · V4 Flash",
      upstreamModel: "deepseek-v4-flash",
      status: "available",
    },
  ],
};

describe("console model selection", () => {
  it("keeps a stored available choice", () => {
    expect(chooseModelId(catalog, "deepseek/deepseek-v4-flash"))
      .toBe("deepseek/deepseek-v4-flash");
  });

  it("falls back to the server default when the stored id is stale", () => {
    expect(chooseModelId(catalog, "removed/model"))
      .toBe("volcengine/deepseek-v4-flash");
  });

  it("skips an unavailable default and picks the first available model", () => {
    const degraded: ModelsResponse = {
      ...catalog,
      models: catalog.models.map((model) => model.provider === "volcengine"
        ? { ...model, status: "unavailable" as const, reason: "missing_api_key" }
        : model),
    };
    expect(chooseModelId(degraded, "volcengine/deepseek-v4-flash"))
      .toBe("deepseek/deepseek-v4-flash");
  });

  it("uses the catalog label in assistant metadata", () => {
    expect(modelDisplayLabel(catalog, "deepseek/deepseek-v4-flash"))
      .toBe("DeepSeek 官方 · V4 Flash");
  });

  it("renders a disabled model selector and sends the stable model id", async () => {
    const chatView = await readFile(
      path.resolve("web/src/features/chat/ChatView.tsx"),
      "utf8",
    );
    const api = await readFile(path.resolve("web/src/api.ts"), "utf8");
    const app = await readFile(path.resolve("web/src/App.tsx"), "utf8");

    expect(chatView).toContain('aria-label="选择聊天模型"');
    expect(chatView).toContain("disabled={running || !modelCatalog}");
    expect(chatView).toContain('model.status !== "available"');
    expect(api).toContain("...(modelId ? { model: modelId } : {})");
    expect(app).toContain("selectedModelId");
    expect(app).toContain("chooseModelId(catalog, current)");
  });
});
