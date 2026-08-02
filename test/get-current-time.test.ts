import { describe, expect, it } from "vitest";
import { createGetCurrentTimeTool } from "../src/tools/get-current-time.js";

describe("get_current_time", () => {
  const fixedTime = new Date("2026-08-02T07:30:00.000Z");
  const tool = createGetCurrentTimeTool({ now: () => fixedTime });

  it("returns the injected time in the requested time zone", async () => {
    const result = await tool.execute({ timeZone: "Asia/Shanghai" });

    expect(result).toEqual({
      isoTime: "2026-08-02T07:30:00.000Z",
      localTime: expect.any(String),
      timeZone: "Asia/Shanghai",
    });
    expect(result.localTime).toContain("15:30");
  });

  it("uses UTC by default", async () => {
    const result = await tool.execute({});

    expect(result.timeZone).toBe("UTC");
    expect(result.localTime).toContain("07:30");
  });

  it("rejects invalid or extra input fields", () => {
    expect(tool.inputSchema.safeParse({ timeZone: "Mars/Olympus" }).success)
      .toBe(false);
    expect(tool.inputSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("停止读取时间"));

    await expect(tool.execute({}, controller.signal))
      .rejects.toThrow("停止读取时间");
  });
});
