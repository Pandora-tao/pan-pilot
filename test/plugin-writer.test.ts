import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifest } from "../src/plugins/manifest-schema.js";
import {
  PluginWriteError,
  pluginExistsOnDisk,
  rollbackNewPlugin,
  writeNewPluginManifest,
  type PluginWriteErrorCode,
} from "../src/plugins/plugin-writer.js";
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

function manifest(name: string): PluginManifest {
  return {
    apiVersion: "v1",
    name,
    description: `${name} 测试插件`,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    executor: { type: "builtin", ref: "echo" },
    enabled: true,
  };
}

function expectWriteError(fn: () => unknown, code: PluginWriteErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginWriteError);
  expect((caught as PluginWriteError).code).toBe(code);
}

describe("writeNewPluginManifest", () => {
  it("writes a plugin atomically into a fresh directory", () => {
    fixtureRoot = createPluginFixture({});

    const written = writeNewPluginManifest(fixtureRoot, manifest("alpha"));

    expect(written.manifestPath).toBe(
      path.join(fixtureRoot, "alpha", "manifest.json"),
    );
    expect(existsSync(written.manifestPath)).toBe(true);
    expect(JSON.parse(readFileSync(written.manifestPath, "utf8")))
      .toMatchObject({ name: "alpha", executor: { type: "builtin", ref: "echo" } });
    expect(pluginExistsOnDisk(fixtureRoot, "alpha")).toBe(true);
  });

  it("never overwrites an existing plugin directory (create-only)", () => {
    fixtureRoot = createPluginFixture({ alpha: null });

    expectWriteError(
      () => writeNewPluginManifest(fixtureRoot, manifest("alpha")),
      "PLUGIN_EXISTS",
    );
  });

  it("never overwrites a pre-existing manifest.json", () => {
    fixtureRoot = createPluginFixture({ alpha: null });
    writeFileSync(
      path.join(fixtureRoot, "alpha", "manifest.json"),
      JSON.stringify(manifest("alpha")),
    );

    expectWriteError(
      () => writeNewPluginManifest(fixtureRoot, manifest("alpha")),
      "PLUGIN_EXISTS",
    );
    // 原文件内容保持不变。
    expect(JSON.parse(
      readFileSync(path.join(fixtureRoot, "alpha", "manifest.json"), "utf8"),
    )).toMatchObject({ name: "alpha" });
  });

  it("rejects names that could escape the plugins directory", () => {
    fixtureRoot = createPluginFixture({});

    expectWriteError(
      () => writeNewPluginManifest(fixtureRoot, manifest("../escape")),
      "WRITE_FAILED",
    );
    expect(existsSync(path.join(fixtureRoot, "..", "escape"))).toBe(false);
  });

  it("rollback removes only the files it created", () => {
    fixtureRoot = createPluginFixture({});
    const written = writeNewPluginManifest(fixtureRoot, manifest("alpha"));
    // 有人在新目录里放了额外文件：回滚必须保留这些既有内容。
    writeFileSync(
      path.join(fixtureRoot, "alpha", "keep.txt"),
      "keep me",
    );

    rollbackNewPlugin(fixtureRoot, written.name);

    expect(existsSync(written.manifestPath)).toBe(false);
    expect(existsSync(path.join(fixtureRoot, "alpha", "keep.txt"))).toBe(true);
  });

  it("rollback of a fresh empty plugin removes the whole directory", () => {
    fixtureRoot = createPluginFixture({});
    const written = writeNewPluginManifest(fixtureRoot, manifest("beta"));

    rollbackNewPlugin(fixtureRoot, written.name);

    expect(existsSync(path.join(fixtureRoot, "beta"))).toBe(false);
  });
});
