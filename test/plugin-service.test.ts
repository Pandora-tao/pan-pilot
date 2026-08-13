import { afterEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { PluginService } from "../src/plugins/plugin-service.js";
import { calculatorTool } from "../src/tools/calculator.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  createPluginFixture,
  removePluginFixture,
} from "./helpers/plugin-fixture.js";

let fixtureRoot = "";

afterEach(() => {
  if (fixtureRoot) removePluginFixture(fixtureRoot);
  fixtureRoot = "";
});

function manifest(name: string) {
  return {
    apiVersion: "v1",
    name,
    description: "计算器别名",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executor: { type: "builtin", ref: "calculator" },
  };
}

function setup() {
  fixtureRoot = createPluginFixture({});
  const registry = new ToolRegistry();
  const manager = new PluginManager({
    pluginsDir: fixtureRoot,
    builtinTools: [calculatorTool],
    registry,
  });
  manager.loadInitial();
  return {
    manager,
    service: new PluginService({ manager, builtinTools: [calculatorTool] }),
  };
}

describe("PluginService suggestions", () => {
  it("keeps suggested manifests hidden until the user installs them", () => {
    const { manager, service } = setup();
    const suggestion = service.suggest(manifest("calc_alias"));

    expect(manager.listStatuses()).toEqual([]);
    expect(service.listSuggestions()).toEqual([suggestion]);
    expect(JSON.stringify(suggestion)).not.toContain("parameters");

    const installed = service.installSuggestion(suggestion.id);
    expect(installed.result.applied).toBe(true);
    expect(manager.getStatus("calc_alias")).toMatchObject({ state: "loaded" });
    expect(service.listSuggestions()).toEqual([]);
  });

  it("lets the user dismiss a suggestion without side effects", () => {
    const { manager, service } = setup();
    const suggestion = service.suggest(manifest("ignored_plugin"));

    service.dismissSuggestion(suggestion.id);

    expect(service.listSuggestions()).toEqual([]);
    expect(manager.listStatuses()).toEqual([]);
  });
});
