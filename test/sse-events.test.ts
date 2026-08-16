import { describe, expect, it } from "vitest";
import {
  parseSseBlock,
  SseEventParser,
} from "../web/src/features/chat/sse-events.js";
import type { ChatStreamEvent } from "../web/src/types.js";

/*
 * 前端 SSE 事件消费单元测试：解析器与 DOM 解耦，
 * 覆盖任意分片边界、多事件同块、损坏数据跳过与 CRLF 兼容。
 */
describe("SseEventParser (frontend event consumption)", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    const parser = new SseEventParser<ChatStreamEvent>();
    const raw = [
      'data: {"type":"status","stage":"model","step":1}\n\n',
      'data: {"type":"tool_execution","execution":{"id":"c1","name":"calculator","status":"success","durationMs":42}}\n\n',
      'data: {"type":"done","result":{"content":"结果","model":"test-model"}}\n\n',
    ].join("");
    const chunks = [raw.slice(0, 9), raw.slice(9, 63), raw.slice(63)];

    const events = chunks.flatMap((chunk) => parser.push(chunk));

    expect(events).toEqual([
      { type: "status", stage: "model", step: 1 },
      {
        type: "tool_execution",
        execution: {
          id: "c1",
          name: "calculator",
          status: "success",
          durationMs: 42,
        },
      },
      {
        type: "done",
        result: { content: "结果", model: "test-model" },
      },
    ]);
  });

  it("skips comment lines and malformed JSON without breaking the stream", () => {
    const parser = new SseEventParser<ChatStreamEvent>();
    const events = parser.push(
      ': keep-alive\n\n'
      + 'data: not-json\n\n'
      + 'data: {"type":"heartbeat","elapsedMs":5000,"stage":"model"}\n\n',
    );

    expect(events).toEqual([
      { type: "heartbeat", elapsedMs: 5000, stage: "model" },
    ]);
  });

  it("parses a block without a space after the colon and tolerates CRLF", () => {
    expect(parseSseBlock<ChatStreamEvent>(
      'data:{"type":"warning","code":"SLOW_RESPONSE","message":"慢响应"}',
    )).toEqual({
      type: "warning",
      code: "SLOW_RESPONSE",
      message: "慢响应",
    });
    expect(parseSseBlock<ChatStreamEvent>('data: {"type":"status","stage":"accepted"}\r'))
      .toEqual({ type: "status", stage: "accepted" });
    expect(new SseEventParser<ChatStreamEvent>().push(
      'data: {"type":"status","stage":"accepted"}\r\n\r\n',
    )).toEqual([{ type: "status", stage: "accepted" }]);
  });
});
