import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTerminalTool,
  sanitizeTerminalEnv,
} from "../src/tools/terminal.js";
import { allowContext, denyContext } from "./helpers/tool-ctx.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pan-pilot-terminal-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("terminal 工具", () => {
  it("执行命令并返回 stdout 与退出码", async () => {
    const tool = createTerminalTool();
    const result = await tool.execute({ command: "printf 'hello world'" }, allowContext());

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      signal: null,
      stdout: "hello world",
      stderr: "",
      truncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("返回非零退出码，stderr 独立收集", async () => {
    const tool = createTerminalTool();
    const result = await tool.execute({
      command: "printf 'oops' >&2 && exit 3",
    }, allowContext());

    expect(result).toMatchObject({
      exitCode: 3,
      stdout: "",
      stderr: "oops",
    });
  });

  it("支持 shell 管道", async () => {
    const tool = createTerminalTool();
    const result = await tool.execute(
      { command: "printf 'a\\nb\\n' | grep b" },
      allowContext(),
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: "b\n" });
  });

  it("在指定的 cwd 下执行", async () => {
    const dir = await tempDir();
    const tool = createTerminalTool({ defaultCwd: dir });

    const result = await tool.execute({ command: "pwd" }, allowContext());
    expect(result.stdout.trim()).toBe(await realpath(dir));
    expect(result.cwd).toBe(path.resolve(dir));
  });

  it("默认 cwd 可被调用方覆盖", async () => {
    const fallback = await tempDir();
    const override = await tempDir();
    const tool = createTerminalTool({ defaultCwd: fallback });

    const result = await tool.execute(
      { command: "pwd", cwd: override },
      allowContext(),
    );
    expect(result.stdout.trim()).toBe(await realpath(override));
  });

  it("超过最大输出字节数时保留尾部并标记 truncated", async () => {
    const tool = createTerminalTool({ maxOutputBytes: 16 });
    const command = "printf 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'";

    const result = await tool.execute({ command }, allowContext());

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(16);
    // 保留尾部而非头部。
    expect(result.stdout.endsWith("XYZ")).toBe(true);
  });

  it("超时后按进程组终止并标记 timedOut", async () => {
    const tool = createTerminalTool();
    const result = await tool.execute(
      { command: "sleep 30 & sleep 30", timeoutMs: 250 },
      allowContext(),
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it("遵守已中止的 AbortSignal 并终止子进程", async () => {
    const tool = createTerminalTool();
    const controller = new AbortController();
    controller.abort(new Error("停止 terminal 操作"));

    await expect(tool.execute({ command: "sleep 5" }, allowContext(controller.signal)))
      .rejects.toThrow("停止 terminal 操作");
  });

  it("授权被拒绝时不执行命令并返回 PERMISSION_DENIED 结果", async () => {
    const dir = await tempDir();
    const tool = createTerminalTool({ defaultCwd: dir });

    const result = await tool.execute(
      { command: "touch should_not_exist.txt" },
      denyContext(),
    );

    expect(result.error).toBe("PERMISSION_DENIED");
    await expect(rm(path.join(dir, "should_not_exist.txt"), { force: false }))
      .rejects.toThrow();
  });

  it("拒绝未声明的输入字段与空命令（strict）", () => {
    const tool = createTerminalTool();
    expect(tool.inputSchema.safeParse({ command: "ls", extra: true }).success)
      .toBe(false);
    expect(tool.inputSchema.safeParse({ command: "" }).success).toBe(false);
  });
});

describe("sanitizeTerminalEnv", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/pan",
    SHELL: "/bin/zsh",
    LANG: "zh_CN.UTF-8",
    DEEPSEEK_API_KEY: "secret-deepseek",
    VOLCENGINE_API_KEY: "secret-volc",
    PAN_PILOT_API_TOKEN: "secret-token",
    MY_APP_TOKEN: "secret-mine",
    MY_APP_DEBUG: "true",
  };

  it("只继承基础白名单变量，不继承任何 PanPilot/厂商密钥", () => {
    const result = sanitizeTerminalEnv(env, ["MY_APP_DEBUG"]);

    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/pan");
    expect(result.SHELL).toBe("/bin/zsh");
    expect(result.LANG).toBe("zh_CN.UTF-8");
    expect(result.DEEPSEEK_API_KEY).toBeUndefined();
    expect(result.VOLCENGINE_API_KEY).toBeUndefined();
    expect(result.PAN_PILOT_API_TOKEN).toBeUndefined();
    expect(result.MY_APP_TOKEN).toBeUndefined();
    expect(result.MY_APP_DEBUG).toBe("true");
  });

  it("已知密钥变量即使被加入白名单也被忽略（fail-safe）", () => {
    const result = sanitizeTerminalEnv(env, [
      "DEEPSEEK_API_KEY",
      "PAN_PILOT_API_TOKEN",
      "VOLCENGINE_API_KEY",
      "MY_APP_DEBUG",
    ]);
    expect(result.DEEPSEEK_API_KEY).toBeUndefined();
    expect(result.PAN_PILOT_API_TOKEN).toBeUndefined();
    expect(result.VOLCENGINE_API_KEY).toBeUndefined();
    // 普通变量仍按白名单放行。
    expect(result.MY_APP_DEBUG).toBe("true");
  });

  it("白名单放行的普通变量被继承，未列入的普通变量被丢弃", () => {
    const result = sanitizeTerminalEnv(env, ["MY_APP_DEBUG"]);
    expect(result.MY_APP_DEBUG).toBe("true");
    // MY_APP_TOKEN 未列入白名单 → 不继承（非密钥，但默认拒绝）。
    expect(result.MY_APP_TOKEN).toBeUndefined();
  });

  it("实际执行时不把密钥传给子进程", async () => {
    const tool = createTerminalTool({
      envSource: env,
      extraEnv: ["MY_APP_DEBUG"],
    });
    const result = await tool.execute(
      { command: "env | sort" },
      allowContext(),
    );

    expect(result.stdout).not.toContain("deepseek");
    expect(result.stdout).toContain("MY_APP_DEBUG=true");
    expect(result.stdout).toContain("PATH=/usr/bin");
  });
});

describe("terminal 授权分类", () => {
  it("组合 / 修改命令在授权放行后可执行", async () => {
    const dir = await tempDir();
    const tool = createTerminalTool({ defaultCwd: dir });
    const result = await tool.execute(
      { command: "printf 'x' > out.txt" },
      allowContext(),
    );
    expect(result.exitCode).toBe(0);
    await expect(rm(path.join(dir, "out.txt"), { force: false })).resolves.toBeUndefined();
  });
});
