import path from "node:path";
import { ExtensionError } from "../validate.js";

/** 常见 Node 内置模块（含 node: 前缀由调用处处理）。 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

export interface BundleBuildOptions {
  /** 输入入口（source 下的 index 文件）。 */
  entry: string;
  sourceDir: string;
  /** 声明在 manifest.dependencies 中的直接依赖名集合。 */
  declaredDeps: ReadonlySet<string>;
  /** esbuild 解析第三方依赖的 node_modules 根（依赖缓存目录）。 */
  nodeModulesDir: string;
  outfile: string;
}

/**
 * 固定构建流程：esbuild `bundle:true` + platform:browser + IIFE + globalName __panpilot。
 * onResolve 守卫拒绝 Node 内置模块、未声明依赖与动态外部；产物单文件自包含
 * （QuickJS 无 require 加载器）。Agent 不能提供构建命令或打包配置。
 */
export async function buildBundle(options: BundleBuildOptions): Promise<{ outputBytes: number }> {
  // esbuild 是 devDependency（构建工具）；只有在真正构建扩展包时才懒加载，
  // 避免生产 prod 依赖无 esbuild 时服务启动即失败。
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [options.entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    outfile: options.outfile,
    write: true,
    minify: false,
    absWorkingDir: options.sourceDir,
    nodePaths: [options.nodeModulesDir],
    logLevel: "silent",
    plugins: [guardPlugin(options.sourceDir, options.declaredDeps)],
  });
  const output = result.outputFiles?.[0];
  const outputBytes = output?.contents.byteLength ?? 0;
  return { outputBytes };
}

function guardPlugin(
  sourceDir: string,
  declaredDeps: ReadonlySet<string>,
): import("esbuild").Plugin {
  return {
    name: "ppkg-guard",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // 入口点本身（绝对路径或相对路径）直接放行。
        if (args.kind === "entry-point") return undefined;
        const request = args.path;
        const importer = args.importer === "" ? "<entry>" : args.importer;

        // 相对导入：必须在 source 根内。
        if (request.startsWith("./") || request.startsWith("../")
          || request === "." || request === "..") {
          return undefined; // 交给 esbuild 默认解析
        }
        // Node 内置模块（含 node: 前缀）。
        if (request.startsWith("node:") || NODE_BUILTINS.has(request)) {
          return {
            errors: [{ text: `拒绝 Node 内置模块: ${request}` }],
          };
        }
        // 裸导入必须命中声明的直接依赖。
        if (!declaredDeps.has(request)) {
          return {
            errors: [{
              text: `未声明依赖 import "${request}"（importer: ${importer}）；` +
                "请在 plugin.json 的 dependencies 中声明精确版本",
            }],
          };
        }
        return undefined;
      });
    },
  };
}

export function defaultEntryPoint(sourceDir: string): string {
  return path.join(sourceDir, "index.ts");
}

export function isNodeBuiltin(request: string): boolean {
  return request.startsWith("node:") || NODE_BUILTINS.has(request);
}

export function extensionError(message: string): ExtensionError {
  return new ExtensionError("INVALID_PACKAGE", message);
}
