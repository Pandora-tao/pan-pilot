import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "../src/plugins/manifest-schema.js";

const validBuiltin = {
  apiVersion: "v1",
  name: "echo",
  description: "返回输入内容",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  executor: { type: "builtin", ref: "echo" },
};

const validHttp = {
  apiVersion: "v1",
  name: "http_echo",
  description: "HTTP 测试工具",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  executor: {
    type: "http",
    method: "POST",
    url: "https://example.com/api?q=${text}",
    headers: { Authorization: "Bearer ${env:TOKEN}" },
    timeoutMs: 5000,
    responsePath: "data.result",
  },
};

describe("pluginManifestSchema", () => {
  it("accepts builtin and http manifests", () => {
    expect(pluginManifestSchema.parse(validBuiltin)).toMatchObject({
      name: "echo",
      executor: { type: "builtin", ref: "echo" },
    });
    expect(pluginManifestSchema.parse(validHttp)).toMatchObject({
      name: "http_echo",
      executor: { type: "http", method: "POST", responsePath: "data.result" },
    });
  });

  it("rejects wrong apiVersion", () => {
    expect(() =>
      pluginManifestSchema.parse({ ...validBuiltin, apiVersion: "v2" }),
    ).toThrow();
  });

  it("rejects invalid plugin names", () => {
    for (const name of ["Echo", "echo-tool", "1echo", "echo工具"]) {
      expect(() =>
        pluginManifestSchema.parse({ ...validBuiltin, name }),
      ).toThrow();
    }
  });

  it("rejects missing description and unknown top-level fields", () => {
    const { description: _omitted, ...noDescription } = validBuiltin;
    expect(() => pluginManifestSchema.parse(noDescription)).toThrow();
    expect(() =>
      pluginManifestSchema.parse({ ...validBuiltin, extra: true }),
    ).toThrow();
  });

  it("rejects non-object parameters", () => {
    for (const parameters of ["object", { type: "array" }, [], null]) {
      expect(() =>
        pluginManifestSchema.parse({ ...validBuiltin, parameters }),
      ).toThrow();
    }
  });

  it("rejects unknown executor types", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...validBuiltin,
        executor: { type: "script", path: "./run.js" },
      }),
    ).toThrow();
  });

  it("rejects invalid http executor fields", () => {
    expect(() =>
      pluginManifestSchema.parse({
        ...validHttp,
        executor: { type: "http", url: "", method: "PUT" },
      }),
    ).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...validHttp,
        executor: { ...validHttp.executor, timeoutMs: 0 },
      }),
    ).toThrow();
  });
});
