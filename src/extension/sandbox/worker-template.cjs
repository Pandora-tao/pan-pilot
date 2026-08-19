// ============================================================================
// sandbox-worker-template.cjs — 在 worker_threads 中以 CommonJS `eval: true` 运行。
// 占位符 __MODULE_QUICKJS_CORE__ / __MODULE_QUICKJS_VARIANT__ 由 worker-runner
// 替换为绝对模块路径（同步 QuickJS wasm，离线加载）。
//
// 宿主调用使用「同步阻塞桥」：宿主编译 Sync QuickJS 模块，SDK 方法通过同步
// host 函数把 {op, payload} 写入共享请求缓冲、向主进程发出 op-ready、再用
// Atomics.wait 阻塞到应答写入共享应答缓冲。主进程侧执行校验/授权/网络并回写。
// 网络/权限等待会阻塞本 worker 线程，但不影响主进程；超限由主进程 terminate。
// ============================================================================

const { parentPort, workerData } = require("node:worker_threads");

const coreModule = "__MODULE_QUICKJS_CORE__";
const variantModule = "__MODULE_QUICKJS_VARIANT__";
const { newQuickJSWASMModuleFromVariant } = require(coreModule);
const variant = (function () {
  const loaded = require(variantModule);
  return loaded && loaded.default ? loaded.default : loaded;
})();

const { bundleSource, toolName, inputJson, limits, meta, buffers } = workerData || {};

const requestReady = new Int32Array(buffers.requestReady);
const replyReady = new Int32Array(buffers.replyReady);
const requestBuf = new Uint8Array(buffers.requestBuf);
const replyBuf = new Uint8Array(buffers.replyBuf);

/** 同步宿主调用：写请求、通知主进程、阻塞等到应答。返回 {ok, value|error}。 */
function hostCall(op, payload) {
  const text = JSON.stringify({ op, payload: payload === undefined ? null : payload });
  // 先清应答位，避免与上一轮的旧应答混淆。
  Atomics.store(replyReady, 0, 0);
  const bytes = Buffer.from(text);
  if (bytes.byteLength > requestBuf.byteLength) {
    return { ok: false, error: { message: "宿主调用请求超过共享缓冲上限" } };
  }
  bytes.copy(requestBuf);
  parentPort.postMessage({ type: "op-ready" });
  Atomics.wait(replyReady, 0, 0);
  const replyText = Buffer.from(replyBuf).toString("utf8").replace(/\0+$/, "");
  let parsed;
  try {
    parsed = JSON.parse(replyText);
  } catch {
    parsed = { ok: false, error: { message: "宿主应答无法解析" } };
  }
  return parsed;
}

function sendResult(ok, payload) {
  parentPort.postMessage({ type: "result", ok, payload });
}

function fail(message) {
  sendResult(false, { error: { message: String(message) } });
}

async function settleAsync(ctx) {
  for (let i = 0; i < 100; i += 1) {
    const had = ctx.runtime.hasPendingJob();
    await new Promise((resolve) => setImmediate(resolve));
    await ctx.runtime.executePendingJobs();
    if (!had) return;
  }
}

function jsonToHandle(ctx, value) {
  if (value === undefined || value === null) return ctx.newNull();
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const json = ctx.getProp(ctx.global, "JSON");
  const parse = ctx.getProp(json, "parse");
  const str = ctx.newString(text);
  return ctx.callFunction(parse, ctx.undefined, str);
}

function serializeResult(ctx, handle) {
  if (handle === undefined || handle === null) return sendResult(true, { value: null });
  let dumped;
  try {
    dumped = ctx.dump(handle);
  } catch {
    return sendResult(true, { value: null });
  }
  let serialized;
  try {
    serialized = JSON.stringify(dumped);
  } catch {
    serialized = "null";
  }
  if (serialized === undefined || serialized === "undefined" || serialized === "") {
    return sendResult(true, { value: null });
  }
  return sendResult(true, { value: JSON.parse(serialized) });
}

function serializeTo(buf, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength > buf.byteLength) return false;
  bytes.copy(buf);
  return true;
}

(async () => {
  try {
    const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
    const ctx = QuickJS.newContext();
    ctx.runtime.setMemoryLimit((limits && limits.memoryLimitBytes) || 67108864);
    ctx.runtime.setMaxStackSize((limits && limits.stackLimitBytes) || 1048576);
    let interruptTicks = 0;
    ctx.runtime.setInterruptHandler(() => {
      interruptTicks += 1;
      return interruptTicks * 100 > ((limits && limits.cpuLimitMs) || 5000);
    });

    // 同步宿主函数：__host(op, payload) -> {ok, value|error}
    const hostFn = ctx.newFunction("__host", (opHandle, payloadHandle) => {
      const op = ctx.dump(opHandle);
      const payload = payloadHandle === ctx.undefined ? undefined : ctx.dump(payloadHandle);
      const reply = hostCall(op, payload);
      return jsonToHandle(ctx, reply);
    });
    ctx.setProp(ctx.global, "__host", hostFn);

    // SDK：每个方法都先调用 __host 得到 {ok, ...} 信封，失败则抛 JS 异常。
    const sdk = [
      "(function () {",
      "  function call(op, payload) {",
      "    var reply = globalThis.__host(op, payload === undefined ? null : payload);",
      "    if (reply && reply.ok) return reply.value;",
      "    throw new Error((reply && reply.error && reply.error.message) || 'host operation failed');",
      "  }",
      "  function method(op) { return function (payload) { return call(op, payload); }; }",
      "  globalThis.panpilot = {",
      "    meta: { name: " + JSON.stringify((meta && meta.name) || "") + ", version: " + JSON.stringify((meta && meta.version) || "") + " },",
      "    http: { request: method('http.request') },",
      "    fs: {",
      "      list: method('fs.list'), info: method('fs.info'), read: method('fs.read'),",
      "      readBase64: method('fs.readBase64'), write: method('fs.write'), edit: method('fs.edit'),",
      "      applyPatch: method('fs.applyPatch'), delete: method('fs.delete'),",
      "      glob: method('fs.glob'), grep: method('fs.grep'),",
      "    },",
      "    terminal: { run: method('terminal.run') },",
      "    storage: { get: method('storage.get'), set: method('storage.set'), del: method('storage.del'), list: method('storage.list') },",
      "    clock: { now: function () { return call('clock.now', null); }, uuid: function () { return call('clock.uuid', null); } },",
      "  };",
      "})();",
    ].join("\n");
    const sdkResult = ctx.evalCode(sdk, { filename: "sdk.js" });
    if (sdkResult.error) {
      const message = ctx.dump(sdkResult.error);
      sdkResult.error.dispose();
      return fail("SDK 初始化失败: " + message);
    }
    sdkResult.value.dispose();

    // 装载 bundle。
    const loadResult = ctx.evalCode(bundleSource, { filename: "bundle/plugin.js" });
    if (loadResult.error) {
      const message = ctx.dump(loadResult.error);
      loadResult.error.dispose();
      return fail("bundle 装载失败: " + message);
    }
    loadResult.value.dispose();

    // 发现模式。
    if (toolName === "__discover__") {
      const d = "globalThis.__pp_result = (globalThis.__panpilot && globalThis.__panpilot.tools || []).map(function (t) { return { name: t && t.name, description: t && t.description, parameters: (t && t.parameters) || undefined }; });";
      const disc = ctx.evalCode(d, { filename: "discover.js" });
      if (disc.error) {
        const message = ctx.dump(disc.error);
        disc.error.dispose();
        return fail("工具发现失败: " + message);
      }
      disc.value.dispose();
      const listHandle = ctx.getProp(ctx.global, "__pp_result");
      const list = ctx.dump(listHandle === ctx.undefined ? ctx.newNull() : listHandle);
      if (listHandle !== ctx.undefined) listHandle.dispose();
      return sendResult(true, { value: list });
    }

    // 测试模式。
    if (toolName === "__test__") {
      const loadTest = ctx.evalCode(bundleSource, { filename: "tests/main.js" });
      if (loadTest.error) {
        const message = ctx.dump(loadTest.error);
        loadTest.error.dispose();
        return fail("测试脚本装载失败: " + message);
      }
      loadTest.value.dispose();
      const testDriver = [
        "globalThis.__pp_result_ready = false;",
        "(async function () {",
        "  var tests = (globalThis.__pp_tests || []);",
        "  var results = [];",
        "  for (var i = 0; i < tests.length; i++) {",
        "    try { await tests[i].run(); results.push({ name: tests[i].name, ok: true }); }",
        "    catch (e) { results.push({ name: tests[i].name, ok: false, error: String(e && e.message || e) }); }",
        "  }",
        "  globalThis.__pp_result = results;",
        "  globalThis.__pp_result_ready = true;",
        "})();",
      ].join("\n");
      const testResult = ctx.evalCode(testDriver, { filename: "test-driver.js" });
      if (testResult.error) {
        const message = ctx.dump(testResult.error);
        testResult.error.dispose();
        return fail("测试执行失败: " + message);
      }
      testResult.value.dispose();
      await settleAsync(ctx);
      const listHandle = ctx.getProp(ctx.global, "__pp_result");
      const list = ctx.dump(listHandle === ctx.undefined ? ctx.newNull() : listHandle);
      if (listHandle !== ctx.undefined) listHandle.dispose();
      return sendResult(true, { value: list });
    }

    // 驱动：直接同步调用 tool.run（保留中断生效）；返回 promise 时挂 then 落地。
    const inputLiteral = JSON.stringify(String(inputJson));
    const nameJson = JSON.stringify(toolName);
    const driver = [
      "globalThis.__pp_input = JSON.parse(" + inputLiteral + ");",
      "globalThis.__pp_promise_done = false;",
      "globalThis.__pp_result = undefined;",
      "globalThis.__pp_result_error = null;",
      "globalThis.__pp_tool = (globalThis.__panpilot && globalThis.__panpilot.tools || [])",
      "  .find(function (t) { return t && t.name === " + nameJson + "; });",
      "if (!globalThis.__pp_tool || typeof globalThis.__pp_tool.run !== 'function')",
      "  throw new Error('工具不存在: " + nameJson + "');",
      "(function () {",
      "  try {",
      "    var r = globalThis.__pp_tool.run(globalThis.__pp_input, globalThis.panpilot);",
      "    if (r && typeof r.then === 'function') {",
      "      r.then(function (v) { globalThis.__pp_result = v; globalThis.__pp_promise_done = true; },",
      "             function (e) { globalThis.__pp_result_error = String(e && e.message || e); globalThis.__pp_promise_done = true; });",
      "    } else {",
      "      globalThis.__pp_result = r;",
      "      globalThis.__pp_promise_done = true;",
      "    }",
      "  } catch (e) {",
      "    globalThis.__pp_result_error = String(e && e.message || e);",
      "    globalThis.__pp_promise_done = true;",
      "  }",
      "})();",
    ].join("\n");
    const runResult = ctx.evalCode(driver, { filename: "driver.js" });
    if (runResult.error) {
      const message = ctx.dump(runResult.error);
      runResult.error.dispose();
      return fail("工具执行失败: " + message);
    }
    runResult.value.dispose();
    await settleAsync(ctx);

    const errorHandle = ctx.getProp(ctx.global, "__pp_result_error");
    if (errorHandle !== ctx.undefined && ctx.dump(errorHandle) !== null) {
      const message = ctx.dump(errorHandle);
      errorHandle.dispose();
      return fail("工具执行失败: " + message);
    }
    if (errorHandle !== ctx.undefined) errorHandle.dispose();

    const valueHandle = ctx.getProp(ctx.global, "__pp_result");
    const out = serializeResult(ctx, valueHandle);
    if (valueHandle !== ctx.undefined) valueHandle.dispose();
    return out;
  } catch (error) {
    return fail(error && error.stack ? String(error.stack) : String(error));
  }
})();
