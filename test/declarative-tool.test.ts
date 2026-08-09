import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { createDeclarativeTool } from "../src/plugins/declarative-tool.js";
import {
  executeHttpRequest,
  type HttpExecutorRuntimeOptions,
} from "../src/plugins/http-executor.js";
import type { PluginManifest } from "../src/plugins/manifest-schema.js";
import {
  createTestEchoTool,
  httpManifest,
} from "./helpers/plugin-fixture.js";

function builtinManifest(name: string, ref: string): PluginManifest {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试工具`,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref },
  };
}

function jsonFetch(response: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(response), { status: 200 }),
  );
}

/** 默认的 http 策略选项：只放行 example.com 与测试用环境变量。 */
function httpOptions(
  fetchImpl: typeof fetch,
  extra: Partial<HttpExecutorRuntimeOptions> = {},
): HttpExecutorRuntimeOptions {
  return {
    fetchImpl,
    allowedHosts: ["example.com"],
    allowedEnvVars: ["PLUGIN_TEST_TOKEN"],
    ...extra,
  };
}

describe("createDeclarativeTool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("delegates builtin execution to the referenced implementation", async () => {
    const tool = createDeclarativeTool(
      builtinManifest("echo", "echo"),
      new Map([["echo", createTestEchoTool()]]),
      {},
    );

    await expect(tool.execute({ value: "你好" })).resolves.toEqual({
      echoed: "你好",
    });
  });

  it("throws when the builtin reference does not exist", () => {
    expect(() =>
      createDeclarativeTool(
        builtinManifest("echo", "missing"),
        new Map([["echo", createTestEchoTool()]]),
        {},
      ),
    ).toThrow("builtin 引用 missing 不存在");
  });

  it("validates http inputs from manifest parameters", async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const tool = createDeclarativeTool(
      httpManifest("http_echo", "https://example.com/api") as PluginManifest,
      new Map(),
      httpOptions(fetchImpl),
    );
    const registry = new ToolRegistry([tool]);

    await expect(registry.execute("http_echo", { text: "hi" }))
      .resolves.toEqual({ ok: true });
    await expect(registry.execute("http_echo", {})).rejects.toMatchObject({
      code: "INVALID_TOOL_INPUT",
      toolName: "http_echo",
    });
  });

  it("expands url templates and extracts responsePath", async () => {
    const fetchImpl = jsonFetch({ data: { items: [{ title: "第一条" }] } });
    const manifest = httpManifest(
      "search",
      "https://example.com/search?q=${text}",
    ) as PluginManifest;
    manifest.executor = {
      ...manifest.executor,
      type: "http",
      url: "https://example.com/search?q=${text}",
      responsePath: "data.items[0].title",
    };
    const tool = createDeclarativeTool(manifest, new Map(), httpOptions(fetchImpl));

    await expect(tool.execute({ text: "上海" })).resolves.toBe("第一条");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(
      "q=%E4%B8%8A%E6%B5%B7",
    );
  });

  it("resolves allowlisted env references in headers without exposing them in results", async () => {
    vi.stubEnv("PLUGIN_TEST_TOKEN", "secret123");
    const fetchImpl = jsonFetch({ ok: true });
    const manifest = httpManifest(
      "guarded",
      "https://example.com/guarded",
    ) as PluginManifest;
    manifest.executor = {
      ...manifest.executor,
      type: "http",
      url: "https://example.com/guarded",
      headers: { Authorization: "Bearer ${env:PLUGIN_TEST_TOKEN}" },
    };
    const tool = createDeclarativeTool(manifest, new Map(), httpOptions(fetchImpl));

    const result = await tool.execute({ text: "hi" });

    expect(result).toEqual({ ok: true });
    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization)
      .toBe("Bearer secret123");
  });

  it("rejects missing env variables and unknown template params", async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const manifest = httpManifest(
      "env_tool",
      "https://example.com/${missing}",
    ) as PluginManifest;
    const tool = createDeclarativeTool(manifest, new Map(), httpOptions(fetchImpl));

    await expect(tool.execute({ text: "hi" })).rejects.toThrow(
      "模板参数 missing 未在入参中提供",
    );

    const envManifest = httpManifest(
      "env_tool",
      "https://example.com/x",
    ) as PluginManifest;
    envManifest.executor = {
      ...envManifest.executor,
      type: "http",
      url: "https://example.com/x",
      headers: { Authorization: "Bearer ${env:PLUGIN_TEST_TOKEN}" },
    };
    const envTool = createDeclarativeTool(
      envManifest,
      new Map(),
      httpOptions(fetchImpl),
    );
    await expect(envTool.execute({ text: "hi" })).rejects.toThrow(
      "环境变量 PLUGIN_TEST_TOKEN 未配置",
    );
  });

  it("enforces https, the host allowlist and default-deny at construction", () => {
    const fetchImpl = jsonFetch({ ok: true });

    // 非 https 在构造期被拒绝。
    expect(() =>
      createDeclarativeTool(
        httpManifest("http_tool", "http://example.com/x") as PluginManifest,
        new Map(),
        httpOptions(fetchImpl),
      ),
    ).toThrow("只允许 https");

    // 未配置白名单 = 默认拒绝。
    expect(() =>
      createDeclarativeTool(
        httpManifest("http_tool", "https://example.com/x") as PluginManifest,
        new Map(),
        { fetchImpl },
      ),
    ).toThrow("默认拒绝");

    // host 不在白名单。
    expect(() =>
      createDeclarativeTool(
        httpManifest("http_tool", "https://evil.example.com/x") as PluginManifest,
        new Map(),
        httpOptions(fetchImpl, { allowedHosts: ["example.com"] }),
      ),
    ).toThrow("不在白名单中");

    // host 部分不允许模板占位符（防止模型动态指定 SSRF 目标）。
    expect(() =>
      createDeclarativeTool(
        httpManifest("http_tool", "https://${target}/x") as PluginManifest,
        new Map(),
        httpOptions(fetchImpl),
      ),
    ).toThrow("host 部分不允许模板占位符");
  });

  it("rejects env references outside the allowlist at construction", () => {
    const fetchImpl = jsonFetch({ ok: true });
    const manifest = httpManifest(
      "env_tool",
      "https://example.com/x",
    ) as PluginManifest;
    manifest.executor = {
      ...manifest.executor,
      type: "http",
      url: "https://example.com/x",
      headers: { Authorization: "Bearer ${env:SECRET_TOKEN}" },
    };

    expect(() =>
      createDeclarativeTool(
        manifest,
        new Map(),
        // 只放行 example.com，但环境变量白名单为空 -> 默认拒绝全部引用。
        { fetchImpl, allowedHosts: ["example.com"] },
      ),
    ).toThrow("SECRET_TOKEN 不在允许引用白名单中");
  });

  it("re-checks https and the host allowlist at runtime as defense in depth", async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const manifest = httpManifest(
      "http_tool",
      "https://example.com/x",
    ) as PluginManifest;
    if (manifest.executor.type !== "http") {
      throw new Error("fixture 应为 http executor");
    }

    // 运行时白名单为空：即使构造期已放行，执行期仍默认拒绝。
    await expect(
      executeHttpRequest(manifest.executor, { text: "hi" }, { fetchImpl }),
    ).rejects.toThrow("默认拒绝执行");

    // 运行时白名单不包含目标 host：拒绝。
    await expect(
      executeHttpRequest(
        manifest.executor,
        { text: "hi" },
        { fetchImpl, allowedHosts: ["other.example.com"] },
      ),
    ).rejects.toThrow("不在白名单中");
  });

  it("times out slow requests", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      }),
    );
    const manifest = httpManifest(
      "slow",
      "https://example.com/slow",
    ) as PluginManifest;
    manifest.executor = {
      ...manifest.executor,
      type: "http",
      url: "https://example.com/slow",
      timeoutMs: 5,
    };
    const tool = createDeclarativeTool(manifest, new Map(), httpOptions(fetchImpl));

    await expect(tool.execute({ text: "hi" })).rejects.toThrow("超时");
  });

  it("rejects non-JSON responses", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("<html>not json</html>", { status: 200 }),
    );
    const tool = createDeclarativeTool(
      httpManifest("html_tool", "https://example.com/html") as PluginManifest,
      new Map(),
      httpOptions(fetchImpl),
    );

    await expect(tool.execute({ text: "hi" })).rejects.toThrow(
      "不是有效 JSON",
    );
  });

  it("caps oversized responses", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("x".repeat(1024 * 1024 + 10), { status: 200 }),
    );
    const tool = createDeclarativeTool(
      httpManifest("big_tool", "https://example.com/big") as PluginManifest,
      new Map(),
      httpOptions(fetchImpl),
    );

    await expect(tool.execute({ text: "hi" })).rejects.toThrow("字节上限");
  });

  it("sends POST requests with JSON body", async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const manifest = httpManifest(
      "post_tool",
      "https://example.com/post",
    ) as PluginManifest;
    manifest.executor = {
      ...manifest.executor,
      type: "http",
      url: "https://example.com/post",
      method: "POST",
    };
    const tool = createDeclarativeTool(manifest, new Map(), httpOptions(fetchImpl));

    await tool.execute({ text: "hi" });

    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ text: "hi" }));
    expect((init.headers as Record<string, string>)["content-type"])
      .toBe("application/json");
  });

  it("passes redirect:error so the allowlisted host cannot redirect elsewhere", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const tool = createDeclarativeTool(
      httpManifest("tool", "https://example.com/x") as PluginManifest,
      new Map(),
      httpOptions(fetchImpl),
    );

    await tool.execute({ text: "hi" });
  });

  it("rejects 3xx redirect responses instead of following them", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response("", {
        status: 301,
        headers: { location: "https://evil.example.com/x" },
      }),
    );
    const tool = createDeclarativeTool(
      httpManifest("tool", "https://example.com/x") as PluginManifest,
      new Map(),
      httpOptions(fetchImpl),
    );

    // 任何 3xx 都直接失败，绝不跟随到白名单之外的 host。
    await expect(tool.execute({ text: "hi" })).rejects.toThrow("返回 301");
  });
});
