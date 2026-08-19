import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemTools,
  FilesystemToolError,
} from "../src/tools/filesystem.js";
import type { AnyAgentTool, ToolExecutionContext } from "../src/tools/tool.js";
import { allowContext, denyContext, spyAllowContext } from "./helpers/tool-ctx.js";

const FS_TOOL_NAMES = [
  "fs_list",
  "fs_info",
  "fs_read",
  "fs_read_base64",
  "fs_write",
  "fs_edit",
  "fs_apply_patch",
  "fs_delete",
  "fs_glob",
  "fs_grep",
];

/** 每个用例创建、统一清理的临时目录。 */
const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-fs-"));
  tempRoots.push(dir);
  return dir;
}

/** 测试用工具句柄：execute 返回 any，便于直接访问结果字段。 */
type TestTool = Omit<AnyAgentTool, "execute"> & {
  execute(input: unknown, ctx: ToolExecutionContext): Promise<any>;
};

function toolOf(tools: AnyAgentTool[], name: string): TestTool {
  const found = tools.find((candidate) => candidate.name === name);
  expect(found, `工具 ${name} 应已注册`).toBeDefined();
  return found as TestTool;
}

/** 默认：以 root 作为 hostCwd，并把它设为管理员限制根（保证沙箱语义）。 */
function makeTools(root: string, overrides: Record<string, unknown> = {}) {
  return createFilesystemTools({
    hostCwd: root,
    adminRoots: [root],
    ...overrides,
  });
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("createFilesystemTools 注册与结构", () => {
  it("注册完整的 fs_* 工具集合", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ hostCwd: root });
    expect(tools.map((entry) => entry.name).sort()).toEqual(
      [...FS_TOOL_NAMES].sort(),
    );
  });

  it("adminRoots 为空时相对路径仍基于 hostCwd 解析", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ hostCwd: root, adminRoots: [] });
    const target = path.join(root, "a.txt");
    await toolOf(tools, "fs_write").execute(
      { path: "a.txt", content: "x" },
      allowContext(),
    );
    const result = await toolOf(tools, "fs_read").execute(
      { path: "a.txt" },
      allowContext(),
    );
    expect(result).toMatchObject({ path: target, content: "x" });
  });

  it("拒绝未声明的输入字段（strict）", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);
    const target = path.join(root, "a.txt");
    expect(toolOf(tools, "fs_read").inputSchema
      .safeParse({ path: target, extra: true }).success).toBe(false);
    expect(toolOf(tools, "fs_write").inputSchema
      .safeParse({ path: target, content: "x", typo: 1 }).success).toBe(false);
  });
});

describe("fs_write / fs_read", () => {
  it("在 hostCwd 内写入并读回文本", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);
    const target = path.join(root, "notes.txt");

    const writeResult = await toolOf(tools, "fs_write").execute({
      path: target,
      content: "你好 PanPilot",
    }, allowContext());
    expect(writeResult).toMatchObject({ path: target, mode: "write" });

    const readResult = await toolOf(tools, "fs_read").execute(
      { path: target },
      allowContext(),
    );
    expect(readResult).toMatchObject({
      content: "你好 PanPilot",
      bytes: Buffer.byteLength("你好 PanPilot", "utf8"),
      hasMore: false,
    });
  });

  it("相对路径相对 hostCwd 解析，并可自动创建父目录", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);

    await toolOf(tools, "fs_write").execute({
      path: "docs/notes.txt",
      content: "sub",
      createParents: true,
    }, allowContext());
    const readResult = await toolOf(tools, "fs_read").execute({
      path: "docs/notes.txt",
    }, allowContext());
    expect(readResult).toMatchObject({ content: "sub" });
    expect(await fsp.readFile(path.join(root, "docs/notes.txt"), "utf8"))
      .toBe("sub");
  });

  it("append 模式追加而非覆盖", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);
    const target = path.join(root, "log.txt");

    await toolOf(tools, "fs_write").execute({ path: target, content: "a" }, allowContext());
    await toolOf(tools, "fs_write").execute({
      path: target,
      content: "b",
      mode: "append",
    }, allowContext());
    const readResult = await toolOf(tools, "fs_read").execute(
      { path: target },
      allowContext(),
    );
    expect(readResult).toMatchObject({ content: "ab" });
  });

  it("覆盖写入保留原有 BOM、换行风格与权限", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "crlf.txt");
    const mode = 0o754 & ~0; // 之后 chmod 覆盖
    await fsp.writeFile(target, "\uFEFFline1\r\nline2\r\n", { mode: 0o644 });
    await fsp.chmod(target, 0o754);
    const tools = makeTools(root);

    await toolOf(tools, "fs_write").execute({
      path: target,
      content: "line1\nline3",
      mode: "write",
    }, allowContext());

    const raw = await fsp.readFile(target);
    expect(raw[0]).toBe(0xef);
    expect(raw[1]).toBe(0xbb);
    expect(raw[2]).toBe(0xbf);
    const text = raw.toString("utf8");
    expect(text).toBe("\uFEFFline1\r\nline3");
    void mode;
    // 权限被保留。
    const stats = await fsp.stat(target);
    expect(stats.mode & 0o777).toBe(0o754);
  });
});

describe("fs_list / fs_info", () => {
  it("列出目录子项及类型", async () => {
    const root = await makeTempDir();
    await fsp.mkdir(path.join(root, "sub"));
    await fsp.writeFile(path.join(root, "a.txt"), "1");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_list").execute({ path: root }, allowContext());
    expect(result).toMatchObject({
      path: root,
      truncated: false,
      entries: expect.arrayContaining([
        { name: "a.txt", type: "file" },
        { name: "sub", type: "dir" },
      ]),
    });
  });

  it("fs_info 区分已存在与缺失路径", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "hello");
    const tools = makeTools(root);

    const existing = await toolOf(tools, "fs_info").execute({ path: target }, allowContext());
    expect(existing).toMatchObject({
      path: target,
      exists: true,
      type: "file",
      size: 5,
    });

    const missing = await toolOf(tools, "fs_info").execute({
      path: path.join(root, "nope.txt"),
    }, allowContext());
    expect(missing).toMatchObject({ exists: false });
  });
});

describe("管理员根目录沙箱（PAN_PILOT_FS_ROOTS）", () => {
  it("拒绝越过根目录的绝对路径", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_read")
      .execute({ path: "/etc/hostname" }, allowContext()))
      .rejects.toThrow(FilesystemToolError);
    await expect(toolOf(tools, "fs_read")
      .execute({ path: "/etc/hostname" }, allowContext()))
      .rejects.toThrow(/超出允许访问/);
  });

  it("拒绝 .. 穿越", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_read").execute({ path: "../secret" }, allowContext()))
      .rejects.toThrow(FilesystemToolError);
    await expect(toolOf(tools, "fs_read").execute({ path: "a/../../secret" }, allowContext()))
      .rejects.toThrow(FilesystemToolError);
  });

  it("拒绝通过符号链接逃逸到根目录外", async () => {
    const outside = await makeTempDir();
    const secret = path.join(outside, "secret.txt");
    await fsp.writeFile(secret, "top-secret");

    const root = await makeTempDir();
    const link = path.join(root, "link.txt");
    await fsp.symlink(secret, link);
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_read").execute({ path: link }, allowContext()))
      .rejects.toThrow(/超出允许访问/);
  });

  it("未配置 adminRoots 时绝对路径放行（整机可访问）", async () => {
    const outside = await makeTempDir();
    const secret = path.join(outside, "secret.txt");
    await fsp.writeFile(secret, "visible");
    const root = await makeTempDir();
    const tools = createFilesystemTools({ hostCwd: root, adminRoots: [] });

    const result = await toolOf(tools, "fs_read").execute(
      { path: secret },
      allowContext(),
    );
    expect(result).toMatchObject({ content: "visible" });
  });

  it("写入/追加超过上限被拒绝", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root, {
      maxTextReadBytes: 10,
      maxWriteBytes: 16,
      maxReadBase64Bytes: 10,
    });
    const target = path.join(root, "big.txt");

    await expect(toolOf(tools, "fs_write")
      .execute({ path: target, content: "x".repeat(32) }, allowContext()))
      .rejects.toThrow(/上限/);
    await toolOf(tools, "fs_write").execute(
      { path: target, content: "hello world" },
      allowContext(),
    );
    const readResult = await toolOf(tools, "fs_read").execute(
      { path: target },
      allowContext(),
    );
    expect(readResult).toMatchObject({ hasMore: true });
  });
});

describe("fs_read 分页与二进制拒绝", () => {
  it("offset/limit 按行分页并返回 hasMore/nextOffset", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "lines.txt");
    await fsp.writeFile(target, Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n"));
    const tools = makeTools(root);

    const first = await toolOf(tools, "fs_read").execute(
      { path: target, offset: 0, limit: 10 },
      allowContext(),
    );
    expect(first).toMatchObject({ hasMore: true, nextOffset: 10 });
    expect(first.content.split("\n")).toEqual(Array.from({ length: 10 }, (_, i) => `line-${i}`));

    const second = await toolOf(tools, "fs_read").execute(
      { path: target, offset: 10, limit: 10 },
      allowContext(),
    );
    expect(second.content.split("\n")[0]).toBe("line-10");

    const last = await toolOf(tools, "fs_read").execute(
      { path: target, offset: 20, limit: 10 },
      allowContext(),
    );
    expect(last).toMatchObject({ hasMore: false });
    expect(last.content.split("\n").length).toBe(10);
  });

  it("默认上限为 2000 行", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "many.txt");
    await fsp.writeFile(target, Array.from({ length: 3000 }, () => "x").join("\n"));
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_read").execute(
      { path: target },
      allowContext(),
    );
    expect(result.content.split("\n").length).toBe(2000);
    expect(result.hasMore).toBe(true);
  });

  it("二进制文件在 fs_read 中拒绝，fs_read_base64 返回 base64", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "bin.bin");
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    await fsp.writeFile(target, Buffer.concat([Buffer.from("PNG"), bytes]));
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_read").execute({ path: target }, allowContext()))
      .rejects.toThrow(/二进制/);

    const result = await toolOf(tools, "fs_read_base64").execute(
      { path: target },
      allowContext(),
    );
    expect(result).toMatchObject({
      bytes: 9,
      base64: Buffer.concat([Buffer.from("PNG"), bytes]).toString("base64"),
    });
  });
});

describe("fs_edit", () => {
  it("精确替换唯一匹配并返回替换数", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "one two one");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_edit").execute({
      path: target,
      oldText: "two",
      newText: "TWO",
    }, allowContext());

    expect(result).toMatchObject({ replaced: 1 });
    expect(await fsp.readFile(target, "utf8")).toBe("one TWO one");
  });

  it("replaceAll=true 替换全部匹配", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "one two one two");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_edit").execute({
      path: target,
      oldText: "two",
      newText: "TWO",
      replaceAll: true,
    }, allowContext());

    expect(result).toMatchObject({ replaced: 2 });
  });

  it("oldText 不唯一时拒绝（除非 replaceAll）", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "a a a");
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_edit").execute({
      path: target,
      oldText: "a",
      newText: "b",
    }, allowContext())).rejects.toThrow(/出现 3 次/);
  });

  it("fs_edit 保留 BOM、换行与权限", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "crlf.txt");
    await fsp.writeFile(target, "\uFEFFline1\r\nline2\r\n", { mode: 0o600 });
    const tools = makeTools(root);

    await toolOf(tools, "fs_edit").execute({
      path: target,
      oldText: "line1",
      newText: "LINE1",
    }, allowContext());

    const raw = await fsp.readFile(target);
    expect(raw[0]).toBe(0xef);
    expect(raw.toString("utf8")).toContain("\uFEFFLINE1\r\n");
    expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe("fs_apply_patch", () => {
  it("add / modify / move / delete 全流程", async () => {
    const root = await makeTempDir();
    await fsp.mkdir(path.join(root, "dir"));
    const tools = makeTools(root);

    const add = await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [
        { op: "add", path: `n.txt`, content: "hello" },
      ] },
    }, allowContext());
    expect(add).toMatchObject({ patch: { operations: [{ op: "add", status: "ok" }] } });

    await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [
        { op: "modify", path: `n.txt`, oldText: "hello", newText: "hello world" },
      ] },
    }, allowContext());

    const move = await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [
        { op: "move", from: `n.txt`, to: `moved.txt` },
      ] },
    }, allowContext());
    expect(move.patch.operations).toEqual([{ op: "move", path: path.join(root, "n.txt"), status: "ok" }]);

    await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [
        { op: "delete", path: `moved.txt` },
      ] },
    }, allowContext());

    await expect(fsp.stat(path.join(root, "moved.txt"))).rejects.toThrow();
  });

  it("先全量校验：任一操作非法则不落任何一字节", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);
    const keep = path.join(root, "keep.txt");

    await expect(toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [
        { op: "add", path: `keep.txt`, content: "should not appear" },
        { op: "modify", path: `missing.txt`, oldText: "x", newText: "y" },
      ] },
    }, allowContext())).rejects.toThrow(/modify 目标不存在/);

    await expect(fsp.stat(keep)).rejects.toThrow();
  });

  it("move 目标已存在时按 overwrite 决定", async () => {
    const root = await makeTempDir();
    await fsp.writeFile(path.join(root, "a.txt"), "a");
    await fsp.writeFile(path.join(root, "b.txt"), "b");
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [{ op: "move", from: `a.txt`, to: `b.txt` }] },
    }, allowContext())).rejects.toThrow(/move 目标已存在/);

    const result = await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [{ op: "move", from: `a.txt`, to: `b.txt`, overwrite: true }] },
    }, allowContext());
    expect(result.patch.operations[0]!.status).toBe("ok");
    expect(await fsp.readFile(path.join(root, "b.txt"), "utf8")).toBe("a");
  });

  it("delete 目录需要 recursive", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "sub");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "f.txt"), "x");
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [{ op: "delete", path: `sub` }] },
    }, allowContext())).rejects.toThrow(/recursive/);

    await toolOf(tools, "fs_apply_patch").execute({
      patch: { operations: [{ op: "delete", path: `sub`, recursive: true }] },
    }, allowContext());
    await expect(fsp.stat(dir)).rejects.toThrow();
  });
});

describe("fs_delete", () => {
  it("删除单个文件", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "x");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_delete").execute({ path: target }, allowContext());
    expect(result).toMatchObject({ deleted: true });
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  it("非空目录必须 recursive 才能删除", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "sub");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "a.txt"), "x");
    const tools = makeTools(root);

    await expect(toolOf(tools, "fs_delete").execute({ path: dir }, allowContext()))
      .rejects.toThrow(/recursive/);

    await toolOf(tools, "fs_delete").execute({ path: dir, recursive: true }, allowContext());
    await expect(fsp.stat(dir)).rejects.toThrow();
  });
});

describe("fs_glob / fs_grep", () => {
  it("glob 递归匹配并支持 limit 截断", async () => {
    const root = await makeTempDir();
    await fsp.mkdir(path.join(root, "sub"), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await fsp.writeFile(path.join(root, `f${i}.txt`), "x");
    }
    await fsp.writeFile(path.join(root, "sub", "nested.ts"), "x");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_glob").execute({
      pattern: "**/*.txt",
      limit: 3,
    }, allowContext());

    expect(result.matches.length).toBe(3);
    expect(result.truncated).toBe(true);
    const all = await toolOf(tools, "fs_glob").execute({
      pattern: "**/*.ts",
    }, allowContext());
    expect(all.matches).toContain(path.join(root, "sub", "nested.ts"));
  });

  it("grep 返回行号并跳过二进制", async () => {
    const root = await makeTempDir();
    await fsp.writeFile(path.join(root, "a.txt"), "hello\nworld\nhello again");
    await fsp.writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_grep").execute({
      pattern: "hello",
    }, allowContext());

    expect(result.matches.map((m: { path: string; lineNumber: number; line: string }) => ({
      lineNumber: m.lineNumber,
      line: m.line,
    }))).toEqual([
      { lineNumber: 1, line: "hello" },
      { lineNumber: 3, line: "hello again" },
    ]);
    expect(result.matches.every((m: { path: string }) => !m.path.endsWith("bin.dat"))).toBe(true);
  });

  it("grep 结果上限截断并标记 truncated", async () => {
    const root = await makeTempDir();
    await fsp.writeFile(path.join(root, "big.txt"), Array.from({ length: 150 }, (_, i) => `hit ${i}`).join("\n"));
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_grep").execute({
      pattern: "hit",
      limit: 100,
    }, allowContext());
    expect(result.matches.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("授权闭环", () => {
  it("写入请求携带目标路径与 diff 预览", async () => {
    const root = await makeTempDir();
    await fsp.writeFile(path.join(root, "a.txt"), "old");
    const tools = makeTools(root);
    const { ctx, asks } = spyAllowContext();

    const result = await toolOf(tools, "fs_write").execute({
      path: path.join(root, "a.txt"),
      content: "new",
    }, ctx);

    expect(result).toMatchObject({ mode: "write" });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      op: "write",
      target: path.join(root, "a.txt"),
    });
    expect(asks[0]!.diff).toContain("-old");
    expect(asks[0]!.diff).toContain("+new");
  });

  it("授权被拒绝时不落盘并返回 PERMISSION_DENIED 结果", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_write").execute({
      path: target,
      content: "x",
    }, denyContext());

    expect(result).toMatchObject({ error: "PERMISSION_DENIED" });
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  it("读取被拒绝时返回 PERMISSION_DENIED 结果", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "secret");
    const tools = makeTools(root);

    const result = await toolOf(tools, "fs_read").execute(
      { path: target },
      denyContext(),
    );
    expect(result).toMatchObject({ error: "PERMISSION_DENIED" });
  });

  it("删除被拒绝时不删除", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "x");
    const tools = makeTools(root);

    await toolOf(tools, "fs_delete").execute({ path: target }, denyContext());
    expect((await fsp.stat(target)).isFile()).toBe(true);
  });
});

describe("中断与原子写", () => {
  it("遵守已中止的 AbortSignal", async () => {
    const root = await makeTempDir();
    const tools = makeTools(root);
    const controller = new AbortController();
    controller.abort(new Error("停止 fs 操作"));

    await expect(toolOf(tools, "fs_read").execute(
      { path: path.join(root, "a.txt") },
      allowContext(controller.signal),
    )).rejects.toThrow("停止 fs 操作");
  });

  it("原子写入不留下临时文件", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    const tools = makeTools(root);

    await toolOf(tools, "fs_write").execute({ path: target, content: "x" }, allowContext());
    const entries = await fsp.readdir(root);
    expect(entries).toEqual(["a.txt"]);
  });
});
