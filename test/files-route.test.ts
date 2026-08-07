import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { extractText } from "../src/docs/word-editor.js";
import type { ModelClient } from "../src/model/model-client.js";
import {
  createDocxFixture,
  multipartBody,
} from "./helpers/docx-fixture.js";

const BOUNDARY = "----panpilot-route-test";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const AUTH = { authorization: "Bearer test-secret" };

/*
 * 文件路由测试：走完整 HTTP 生命周期（multipart 上传 → 下载 → 聊天内编辑），
 * 存储目录指向每个用例独立的临时目录，避免污染工作区。
 */
describe("files routes", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  let previousDocsDir: string | undefined;
  let docsDir = "";

  beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "panpilot-docs-"));
    previousDocsDir = process.env.PAN_PILOT_DOCS_DIR;
    process.env.PAN_PILOT_DOCS_DIR = docsDir;
  });

  afterEach(async () => {
    if (previousDocsDir === undefined) {
      delete process.env.PAN_PILOT_DOCS_DIR;
    } else {
      process.env.PAN_PILOT_DOCS_DIR = previousDocsDir;
    }
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(docsDir, { recursive: true, force: true });
  });

  it("uploads a docx and downloads it back with the original bytes", async () => {
    const docx = await createDocxFixture(["你好"]);
    const app = buildWithToken();

    const upload = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "报告.docx", DOCX_MIME, docx, BOUNDARY),
    });

    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as {
      fileId: string;
      name: string;
      size: number;
      downloadUrl: string;
    };
    expect(uploaded).toMatchObject({
      name: "报告.docx",
      size: docx.length,
      downloadUrl: `/v1/files/${uploaded.fileId}`,
    });

    const download = await app.inject({
      method: "GET",
      url: uploaded.downloadUrl,
      headers: AUTH,
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe(DOCX_MIME);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.rawPayload.equals(docx)).toBe(true);
  });

  it("protects upload and download with the API token", async () => {
    const docx = await createDocxFixture(["x"]);
    const app = buildWithToken();

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody("file", "a.docx", DOCX_MIME, docx, BOUNDARY),
    });
    expect(unauthorized.statusCode).toBe(401);

    const download = await app.inject({
      method: "GET",
      url: "/v1/files/some-id",
    });
    expect(download.statusCode).toBe(401);
  });

  it("rejects non-docx extensions and non-docx content", async () => {
    const app = buildWithToken();

    const wrongExtension = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "note.txt", "text/plain", Buffer.from("hi"), BOUNDARY),
    });
    expect(wrongExtension.statusCode).toBe(415);

    const fakeContent = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "fake.docx", DOCX_MIME, Buffer.from("not a zip"), BOUNDARY),
    });
    expect(fakeContent.statusCode).toBe(415);
    expect(fakeContent.json()).toMatchObject({ error: "INVALID_DOCX" });
  });

  it("returns 404 for unknown file ids and 400 for unsafe ones", async () => {
    const app = buildWithToken();

    const missing = await app.inject({
      method: "GET",
      url: "/v1/files/does-not-exist",
      headers: AUTH,
    });
    expect(missing.statusCode).toBe(404);

    const traversal = await app.inject({
      method: "GET",
      url: "/v1/files/..%2Fsecret",
      headers: AUTH,
    });
    expect(traversal.statusCode).toBe(400);
  });

  it("rejects uploads larger than the size limit", async () => {
    const app = buildWithToken();

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody(
        "file",
        "big.docx",
        DOCX_MIME,
        Buffer.alloc(11 * 1024 * 1024),
        BOUNDARY,
      ),
    });

    expect(oversized.statusCode).toBe(413);
  });

  it("edits an uploaded document through the chat agent and serves the result", async () => {
    const docx = await createDocxFixture(["旧价格 100 元"]);
    const app = buildWithToken();
    const upload = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        ...AUTH,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      },
      payload: multipartBody("file", "合同.docx", DOCX_MIME, docx, BOUNDARY),
    });
    const { fileId } = upload.json() as { fileId: string };

    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call_edit",
          name: "edit_word_document",
          arguments: {
            fileId,
            edits: [{ type: "replace_text", oldText: "100", newText: "200" }],
          },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "文档已修改，下载地址见工具结果",
        toolCalls: [],
        model: "test-model",
      });
    const chatApp = buildApp({
      modelClient: { complete, completeStream: vi.fn() },
      apiToken: "test-secret",
    });
    apps.push(chatApp);

    const chat = await chatApp.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "把 100 改成 200" },
    });

    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      message: "文档已修改，下载地址见工具结果",
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_edit",
          name: "edit_word_document",
          status: "success",
        }],
      },
    });
    expect(complete).toHaveBeenCalledTimes(2);

    // 工具结果（含下载地址）只回填给模型，通过模型消息取出并验证下载。
    const toolMessages = complete.mock.calls[1]![0].messages.filter(
      (message) => message.role === "tool",
    );
    const toolResult = JSON.parse(toolMessages[0]!.content) as {
      fileId: string;
      downloadUrl: string;
      edits: Array<{ type: string; applied: boolean }>;
    };
    expect(toolResult.edits).toEqual([{ type: "replace_text", applied: true }]);

    const download = await chatApp.inject({
      method: "GET",
      url: toolResult.downloadUrl,
      headers: AUTH,
    });
    expect(download.statusCode).toBe(200);
    await expect(extractText(download.rawPayload)).resolves.toEqual({
      paragraphs: ["旧价格 200 元"],
    });
  });

  it("creates a document through the chat agent and serves the result", async () => {
    const complete = vi.fn<ModelClient["complete"]>()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{
          id: "call_create",
          name: "create_word_document",
          arguments: {
            title: "新文档",
            blocks: [{ type: "paragraph", text: "创建成功" }],
          },
        }],
        model: "test-model",
      })
      .mockResolvedValueOnce({
        content: "文档已创建",
        toolCalls: [],
        model: "test-model",
      });
    const chatApp = buildApp({
      modelClient: { complete, completeStream: vi.fn() },
      apiToken: "test-secret",
    });
    apps.push(chatApp);

    const chat = await chatApp.inject({
      method: "POST",
      url: "/v1/chat",
      headers: AUTH,
      payload: { message: "创建一份新文档" },
    });

    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      message: "文档已创建",
      execution: {
        mode: "chat",
        toolExecutions: [{
          id: "call_create",
          name: "create_word_document",
          status: "success",
        }],
      },
    });

    // 工具结果（含下载地址）只回填给模型，通过模型消息取出并验证下载。
    const toolMessages = complete.mock.calls[1]![0].messages.filter(
      (message) => message.role === "tool",
    );
    const toolResult = JSON.parse(toolMessages[0]!.content) as {
      name: string;
      downloadUrl: string;
    };
    expect(toolResult.name).toBe("新文档.docx");

    const download = await chatApp.inject({
      method: "GET",
      url: toolResult.downloadUrl,
      headers: AUTH,
    });
    expect(download.statusCode).toBe(200);
    await expect(extractText(download.rawPayload)).resolves.toEqual({
      paragraphs: ["新文档", "创建成功"],
    });
  });

  function buildWithToken() {
    const app = buildApp({ apiToken: "test-secret" });
    apps.push(app);
    return app;
  }
});
