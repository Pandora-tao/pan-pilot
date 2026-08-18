import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemTools,
  FilesystemToolError,
} from "../src/tools/filesystem.js";
import type { AnyAgentTool } from "../src/tools/tool.js";

const FS_TOOL_NAMES = [
  "fs_list",
  "fs_info",
  "fs_read",
  "fs_read_base64",
  "fs_write",
  "fs_delete",
];

/** 每个用例创建、统一清理的临时目录。 */
const tempRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-fs-"));
  tempRoots.push(dir);
  return dir;
}

function toolOf(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  expect(found, `工具 ${name} 应已注册`).toBeDefined();
  return found!;
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("createFilesystemTools 注册与结构", () => {
  it("注册完整的 fs_* 工具集合", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });
    expect(tools.map((entry) => entry.name).sort()).toEqual(
      [...FS_TOOL_NAMES].sort(),
    );
  });

  it("roots 为空时 fail-closed 抛错", () => {
    expect(() => createFilesystemTools({ roots: [] })).toThrow();
  });

  it("拒绝未声明的输入字段（strict）", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });
    const target = path.join(root, "a.txt");
    expect(toolOf(tools, "fs_read").inputSchema
      .safeParse({ path: target, extra: true }).success).toBe(false);
    expect(toolOf(tools, "fs_write").inputSchema
      .safeParse({ path: target, content: "x", typo: 1 }).success).toBe(false);
  });
});

describe("fs_write / fs_read", () => {
  it("在允许根目录内写入并读回文本", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });
    const target = path.join(root, "notes.txt");

    const writeResult = await toolOf(tools, "fs_write").execute({
      path: target,
      content: "你好 PanPilot",
    });
    expect(writeResult).toMatchObject({ path: target, mode: "write" });

    const readResult = await toolOf(tools, "fs_read").execute({ path: target });
    expect(readResult).toMatchObject({
      content: "你好 PanPilot",
      bytes: Buffer.byteLength("你好 PanPilot", "utf8"),
    });
  });

  it("相对路径相对第一个允许根目录解析，并可自动创建父目录", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });

    await toolOf(tools, "fs_write").execute({
      path: "docs/notes.txt",
      content: "sub",
      createParents: true,
    });
    const readResult = await toolOf(tools, "fs_read").execute({
      path: "docs/notes.txt",
    });
    expect(readResult).toMatchObject({ content: "sub" });
    expect(await fsp.readFile(path.join(root, "docs/notes.txt"), "utf8"))
      .toBe("sub");
  });

  it("append 模式追加而非覆盖", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });
    const target = path.join(root, "log.txt");

    await toolOf(tools, "fs_write").execute({ path: target, content: "a" });
    await toolOf(tools, "fs_write").execute({
      path: target,
      content: "b",
      mode: "append",
    });
    const readResult = await toolOf(tools, "fs_read").execute({ path: target });
    expect(readResult).toMatchObject({ content: "ab" });
  });
});

describe("fs_list / fs_info", () => {
  it("列出目录子项及类型", async () => {
    const root = await makeTempDir();
    await fsp.mkdir(path.join(root, "sub"));
    await fsp.writeFile(path.join(root, "a.txt"), "1");
    const tools = createFilesystemTools({ roots: [root] });

    const result = await toolOf(tools, "fs_list").execute({ path: root });
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
    const tools = createFilesystemTools({ roots: [root] });

    const existing = await toolOf(tools, "fs_info").execute({ path: target });
    expect(existing).toMatchObject({
      path: target,
      exists: true,
      type: "file",
      size: 5,
    });

    const missing = await toolOf(tools, "fs_info").execute({
      path: path.join(root, "nope.txt"),
    });
    expect(missing).toMatchObject({ exists: false });
  });
});

describe("沙箱边界", () => {
  it("拒绝越过根目录的绝对路径", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });

    await expect(toolOf(tools, "fs_read")
      .execute({ path: "/etc/hostname" }))
      .rejects.toThrow(FilesystemToolError);
    await expect(toolOf(tools, "fs_read")
      .execute({ path: "/etc/hostname" }))
      .rejects.toThrow(/超出允许访问/);
  });

  it("拒绝 .. 穿越", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });

    await expect(toolOf(tools, "fs_read").execute({ path: "../secret" }))
      .rejects.toThrow(FilesystemToolError);
    await expect(toolOf(tools, "fs_read").execute({ path: "a/../../secret" }))
      .rejects.toThrow(FilesystemToolError);
  });

  it("拒绝通过符号链接逃逸到根目录外", async () => {
    const outside = await makeTempDir();
    const secret = path.join(outside, "secret.txt");
    await fsp.writeFile(secret, "top-secret");

    const root = await makeTempDir();
    const link = path.join(root, "link.txt");
    await fsp.symlink(secret, link);
    const tools = createFilesystemTools({ roots: [root] });

    await expect(toolOf(tools, "fs_read").execute({ path: link }))
      .rejects.toThrow(FilesystemToolError);
  });

  it("写入/追加超过上限被拒绝", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({
      roots: [root],
      maxReadBytes: 10,
      maxWriteBytes: 16,
    });
    const target = path.join(root, "big.txt");

    await expect(toolOf(tools, "fs_write")
      .execute({ path: target, content: "x".repeat(32) }))
      .rejects.toThrow(/上限/);

    // 写入大小未超写上限、但读上限更小：读被拒绝。
    await toolOf(tools, "fs_write").execute({ path: target, content: "hello world" });
    await expect(toolOf(tools, "fs_read").execute({ path: target }))
      .rejects.toThrow(/上限/);
  });
});

describe("fs_delete", () => {
  it("删除单个文件", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "a.txt");
    await fsp.writeFile(target, "x");
    const tools = createFilesystemTools({ roots: [root] });

    const result = await toolOf(tools, "fs_delete").execute({ path: target });
    expect(result).toMatchObject({ deleted: true });
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  it("非空目录必须 recursive 才能删除", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "sub");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "a.txt"), "x");
    const tools = createFilesystemTools({ roots: [root] });

    await expect(toolOf(tools, "fs_delete").execute({ path: dir }))
      .rejects.toThrow(/recursive/);

    await toolOf(tools, "fs_delete").execute({ path: dir, recursive: true });
    await expect(fsp.stat(dir)).rejects.toThrow();
  });
});

describe("中断与只读", () => {
  it("遵守已中止的 AbortSignal", async () => {
    const root = await makeTempDir();
    const tools = createFilesystemTools({ roots: [root] });
    const controller = new AbortController();
    controller.abort(new Error("停止 fs 操作"));

    await expect(toolOf(tools, "fs_read")
      .execute({ path: path.join(root, "a.txt") }, controller.signal))
      .rejects.toThrow("停止 fs 操作");
  });

  it("fs_read_base64 返回 base64 编码的字节内容", async () => {
    const root = await makeTempDir();
    const target = path.join(root, "bin.bin");
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    await fsp.writeFile(target, bytes);
    const tools = createFilesystemTools({ roots: [root] });

    const result = await toolOf(tools, "fs_read_base64").execute({ path: target });
    expect(result).toMatchObject({
      bytes: bytes.byteLength,
      base64: bytes.toString("base64"),
    });
  });
});
