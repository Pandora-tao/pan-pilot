import { describe, expect, it, vi } from "vitest";
import type { ModelClient } from "../src/model/model-client.js";
import {
  ChatModelRegistry,
  createChatModelRegistry,
  DEEPSEEK_OFFICIAL_V4_FLASH,
  UnavailableChatModelError,
  UnsupportedChatModelError,
  VOLCENGINE_DEEPSEEK_V4_FLASH,
} from "../src/model/model-registry.js";

describe("ChatModelRegistry", () => {
  it("uses Volcengine as the default and exposes a redacted catalog", () => {
    const registry = createChatModelRegistry({
      VOLCENGINE_API_KEY: "volc-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
    });

    expect(registry.defaultModelId).toBe(VOLCENGINE_DEEPSEEK_V4_FLASH);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: VOLCENGINE_DEEPSEEK_V4_FLASH,
        provider: "volcengine",
        upstreamModel: "deepseek-v4-flash",
        status: "available",
      }),
      expect.objectContaining({
        id: DEEPSEEK_OFFICIAL_V4_FLASH,
        provider: "deepseek",
        upstreamModel: "deepseek-v4-flash",
        status: "available",
      }),
    ]);
    expect(JSON.stringify(registry.list())).not.toContain("secret");
    expect(JSON.stringify(registry.list())).not.toContain("baseURL");
  });

  it("routes exact stable ids to distinct clients", () => {
    const volcengine = fakeModelClient();
    const deepseek = fakeModelClient();
    const registry = fakeRegistry(volcengine, deepseek);

    expect(registry.resolve().client).toBe(volcengine);
    expect(registry.resolve(VOLCENGINE_DEEPSEEK_V4_FLASH).client).toBe(volcengine);
    expect(registry.resolve(DEEPSEEK_OFFICIAL_V4_FLASH).client).toBe(deepseek);
  });

  it("rejects unknown and unavailable ids without fallback", () => {
    const available = fakeModelClient();
    const registry = new ChatModelRegistry([
      entry(VOLCENGINE_DEEPSEEK_V4_FLASH, "volcengine", available),
      entry(DEEPSEEK_OFFICIAL_V4_FLASH, "deepseek"),
    ], VOLCENGINE_DEEPSEEK_V4_FLASH);

    expect(() => registry.resolve("unknown/model"))
      .toThrow(UnsupportedChatModelError);
    expect(() => registry.resolve(DEEPSEEK_OFFICIAL_V4_FLASH))
      .toThrow(UnavailableChatModelError);
    expect(registry.resolve().client).toBe(available);
  });

  it("rejects an unavailable default model at startup", () => {
    expect(() => createChatModelRegistry({
      DEEPSEEK_API_KEY: "deepseek-secret",
    })).toThrow("Default chat model is unavailable");
  });
});

function fakeRegistry(volcengine: ModelClient, deepseek: ModelClient) {
  return new ChatModelRegistry([
    entry(VOLCENGINE_DEEPSEEK_V4_FLASH, "volcengine", volcengine),
    entry(DEEPSEEK_OFFICIAL_V4_FLASH, "deepseek", deepseek),
  ], VOLCENGINE_DEEPSEEK_V4_FLASH);
}

function entry(
  id: string,
  provider: "volcengine" | "deepseek",
  client?: ModelClient,
) {
  return {
    descriptor: {
      id,
      provider,
      label: id,
      upstreamModel: "deepseek-v4-flash",
      status: client ? "available" as const : "unavailable" as const,
      ...(client ? {} : { reason: "missing_api_key" as const }),
    },
    ...(client ? { client } : {}),
  };
}

function fakeModelClient(): ModelClient {
  return { complete: vi.fn(), completeStream: vi.fn() };
}
