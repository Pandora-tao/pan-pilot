import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifests } from "../src/plugins/plugin-loader.js";
import {
  createPluginFixture,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) {
    removePluginFixture(fixtureRoot);
    fixtureRoot = "";
  }
});

describe("loadPluginManifests", () => {
  it("loads valid manifests and reports per-plugin errors", () => {
    fixtureRoot = createPluginFixture({
      alpha: {
        apiVersion: "v1",
        name: "alpha",
        description: "正常插件",
        parameters: { type: "object", properties: {} },
        executor: { type: "builtin", ref: "echo" },
      },
      "broken-json": "{ 不是 JSON",
      nomanifest: null,
      "bad-name": {
        apiVersion: "v1",
        name: "bad-name",
        description: "名字带横线",
        parameters: { type: "object", properties: {} },
        executor: { type: "builtin", ref: "echo" },
      },
      mismatched: {
        apiVersion: "v1",
        name: "other_name",
        description: "目录名与 name 不一致",
        parameters: { type: "object", properties: {} },
        executor: { type: "builtin", ref: "echo" },
      },
    });

    const result = loadPluginManifests(fixtureRoot);

    expect(result.plugins.map((p) => p.manifest.name)).toEqual(["alpha"]);
    expect(result.errors.map((e) => e.dirName)).toEqual(
      expect.arrayContaining(["broken-json", "nomanifest", "bad-name", "mismatched"]),
    );
    expect(result.errors.find((e) => e.dirName === "nomanifest")!.message)
      .toContain("缺少 manifest.json");
    expect(result.errors.find((e) => e.dirName === "mismatched")!.message)
      .toContain("manifest.name 必须是 mismatched");
  });

  it("skips non-directory entries", () => {
    fixtureRoot = createPluginFixture({});
    writeFileSync(path.join(fixtureRoot, "readme.txt"), "not a plugin");
    mkdirSync(path.join(fixtureRoot, ".hidden"));

    const result = loadPluginManifests(fixtureRoot);

    expect(result.plugins).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("treats a missing plugins directory as an empty set", () => {
    const result = loadPluginManifests("/nonexistent/panpilot/plugins");
    expect(result).toEqual({ plugins: [], errors: [] });
  });
});
