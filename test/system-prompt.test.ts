import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  ModelClient,
  ModelMessage,
  ModelStreamEvent,
} from "../src/model/model-client.js";

/**
 * /v1/chat 的默认 agent 系统提示词注入：让模型被问“你有 xx 能力吗”时
 * 依据当前可用工具如实回答，而不是凭通用 AI 认知自我否定。
 */
describe("默认 agent 系统提示词注入", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  function fakeModelClient(complete: ModelClient["complete"]): ModelClient {
    return {
      complete,
      completeStream: async function* (): AsyncGenerator<ModelStreamEvent> {
        yield {
          type: "completion",
          completion: { content: "", toolCalls: [], model: "test-model" },
        };
      },
    };
  }

  function makeComplete(): ModelClient["complete"] {
    return vi.fn<ModelClient["complete"]>().mockResolvedValue({
      content: "ok",
      toolCalls: [],
      model: "test-model",
    });
  }

  /** 发送一次请求并返回真正送给模型的 messages 数组。 */
  async function sentMessages(
    complete: ModelClient["complete"],
    payload: Record<string, unknown>,
    buildOptions: { systemPrompt?: string } = {},
  ): Promise<ModelMessage[]> {
    const app = buildApp({
      modelClient: fakeModelClient(complete),
      ...buildOptions,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { stream: false, ...payload },
    });
    expect(response.statusCode).toBe(200);
    const firstCall = (complete as ReturnType<typeof vi.fn>).mock.calls[0];
    return (firstCall?.[0] as { messages: ModelMessage[] }).messages;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("message 简写形态默认注入系统提示词（含工具清单）", async () => {
    const messages = await sentMessages(makeComplete(), { message: "你会用 shell 吗" });

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("你是运行在宿主机上的 PanPilot Agent");
    expect(messages[0]!.content).toContain("当前可用工具");
    expect(messages[0]!.content).toContain("terminal");
    expect(messages[0]!.content).toContain("fs_write");
    expect(messages[1]).toMatchObject({ role: "user", content: "你会用 shell 吗" });
  });

  it("messages 形态且无 system 时注入默认提示词", async () => {
    const messages = await sentMessages(makeComplete(), {
      messages: [{ role: "user", content: "帮我列一下文件" }],
    });

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("PanPilot Agent");
  });

  it("调用方自带 system 消息时原样透传，不注入默认提示词", async () => {
    const messages = await sentMessages(makeComplete(), {
      messages: [
        { role: "system", content: "完整的人设提示词" },
        { role: "user", content: "继续" },
      ],
    });

    expect(messages[0]).toMatchObject({
      role: "system",
      content: "完整的人设提示词",
    });
    expect(messages[0]!.content).not.toContain("PanPilot Agent");
  });

  it("systemPrompt 覆盖默认正文且仍附加工具清单", async () => {
    const messages = await sentMessages(
      makeComplete(),
      { message: "你好" },
      { systemPrompt: "自定义指令：只讲中文。" },
    );

    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]!.content).toContain("自定义指令：只讲中文。");
    expect(messages[0]!.content).toContain("当前可用工具");
  });

  it("systemPrompt 为空字符串时不注入任何系统消息", async () => {
    const messages = await sentMessages(
      makeComplete(),
      { message: "你好" },
      { systemPrompt: "" },
    );

    expect(messages[0]).toMatchObject({ role: "user", content: "你好" });
    expect(messages.some((message) => message.role === "system")).toBe(false);
  });
});
