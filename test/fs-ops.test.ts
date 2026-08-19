import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomicWriteText,
  appendText,
  FsOpsError,
  readTextWithProfile,
  serializeWithProfile,
  withPathLock,
} from "../src/tools/fs-ops.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pan-pilot-fsops-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("readTextWithProfile / serializeWithProfile", () => {
  it("探测 BOM 与 CRLF 并能在写回时保留", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await fsp.writeFile(target, "\uFEFFx\r\ny\r\n");

    const read = await readTextWithProfile(target);
    expect(read).toMatchObject({
      // 保留原始换行（编辑/补丁按此快照做精确替换）。
      content: "x\r\ny\r\n",
      profile: { hadBom: true, lineEnding: "\r\n" },
    });

    // 按快照序列化可无损还原字节。
    const serialized = serializeWithProfile(read!.content, read!.profile);
    expect(serialized.toString("utf8")).toBe("\uFEFFx\r\ny\r\n");
  });

  it("缺少文件时返回 undefined", async () => {
    const dir = await tempDir();
    expect(await readTextWithProfile(path.join(dir, "nope"))).toBeUndefined();
  });
});

describe("atomicWriteText 并发修改检测与原子性", () => {
  it("expectedExisting 与磁盘现状一致时成功写入", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await fsp.writeFile(target, "old");
    const read = await readTextWithProfile(target);

    await atomicWriteText(target, "new", {
      profile: read!.profile,
      expectedExisting: { content: read!.content, profile: read!.profile },
    });
    expect(await fsp.readFile(target, "utf8")).toBe("new");
    expect((await fsp.readdir(dir))).toEqual(["a.txt"]); // 无残留临时文件
  });

  it("expectedExisting 不一致（并发修改）时中止写入", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "a.txt");
    await fsp.writeFile(target, "snapshot");
    const read = await readTextWithProfile(target);
    // 外部并发修改。
    await fsp.writeFile(target, "someone else");

    await expect(atomicWriteText(target, "new", {
      profile: read!.profile,
      expectedExisting: { content: read!.content, profile: read!.profile },
    })).rejects.toThrow(FsOpsError);

    // 并发修改未被覆盖。
    expect(await fsp.readFile(target, "utf8")).toBe("someone else");
  });

  it("新文件原子写入自动创建父目录", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "nested", "deep", "b.txt");
    await atomicWriteText(target, "hi");
    expect(await fsp.readFile(target, "utf8")).toBe("hi");
  });
});

describe("withPathLock 串行化同一路径写入", () => {
  it("并发写同一文件不会交错（原子 rename 兜底）", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "c.txt");
    await fsp.mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      withPathLock(target, async () => {
        await atomicWriteText(target, `content-${i}`);
      })));
    const final = await fsp.readFile(target, "utf8");
    expect(final).toMatch(/^content-[0-4]$/);
  });
});

describe("appendText", () => {
  it("append 追加并创建缺失文件", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "log.txt");
    await appendText(target, "a");
    await appendText(target, "b");
    expect(await fsp.readFile(target, "utf8")).toBe("ab");
  });
});
