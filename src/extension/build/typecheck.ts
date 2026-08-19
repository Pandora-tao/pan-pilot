import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);

const TSC_BIN: string | undefined = (() => {
  try {
    const pkg = require.resolve("typescript/package.json");
    return path.join(path.dirname(pkg), "bin", "tsc");
  } catch {
    return undefined;
  }
})();

const PLUGIN_TSC_ARGS = [
  "--ignoreConfig",
  "--noEmit",
  "--strict",
  "--skipLibCheck",
  "--lib", "ES2022",
  "--types", "",
  "--pretty", "false",
];

export interface TypecheckResult {
  ok: boolean;
  diagnostics: string[];
}

/**
 * 用安装版 TypeScript 的 tsc 子进程对草稿源码做无输出类型检查。
 * 固定选项，Agent 不能提供编译选项。
 */
export function typecheckDraft(sourceDir: string): TypecheckResult {
  if (TSC_BIN === undefined) {
    return { ok: false, diagnostics: ["未找到 TypeScript 编译器（typescript 依赖缺失）"] };
  }
  const files = listSourceFiles(sourceDir);
  if (files.length === 0) {
    return { ok: false, diagnostics: ["source/ 下没有可检查的源文件"] };
  }
  const result = spawnSync(TSC_BIN, [...PLUGIN_TSC_ARGS, ...files], {
    cwd: sourceDir,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output === "") return { ok: true, diagnostics: [] };
  const diagnostics = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ok: false, diagnostics };
}

function listSourceFiles(sourceDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = path.join(dir, name);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(abs);
      else if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(name)) out.push(abs);
    }
  };
  walk(sourceDir);
  return out;
}
