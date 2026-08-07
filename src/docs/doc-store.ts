import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 文件 ID 白名单：只允许 URL 安全字符，从根上挡住路径穿越。 */
export const FILE_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export interface StoredFileMeta {
  /** 下载时展示的原始文件名（不含路径）。 */
  name: string;
  size: number;
  kind: "upload" | "edited" | "created";
  /** 编辑产物的来源文件 ID；上传文件没有该字段。 */
  sourceFileId?: string;
  createdAt: string;
}

export interface StoredFile {
  fileId: string;
  meta: StoredFileMeta;
  buffer: Buffer;
}

/**
 * 服务器端 docx 文件存储：上传原件不可变，编辑结果另存新文件。
 *
 * 布局：<root>/files/<fileId>.docx + <fileId>.json（元数据边车文件）。
 */
export class DocStore {
  constructor(private readonly rootDir: string) {}

  async saveUpload(buffer: Buffer, originalName: string) {
    const fileId = randomUUID();
    const meta: StoredFileMeta = {
      name: originalName,
      size: buffer.length,
      kind: "upload",
      createdAt: new Date().toISOString(),
    };
    await this.write(fileId, buffer, meta);
    return { fileId, ...meta };
  }

  /** 保存从零生成的文档（如 create_word_document 的产物）。 */
  async saveCreated(buffer: Buffer, name: string) {
    const fileId = randomUUID();
    const meta: StoredFileMeta = {
      name,
      size: buffer.length,
      kind: "created",
      createdAt: new Date().toISOString(),
    };
    await this.write(fileId, buffer, meta);
    return { fileId, ...meta };
  }

  /** 保存编辑产物：文件名继承来源文件，并标记来源 ID。 */
  async saveEdited(buffer: Buffer, sourceFileId: string) {
    const source = await this.read(sourceFileId);
    if (!source) {
      throw new Error(`源文件 ${sourceFileId} 不存在`);
    }
    const fileId = randomUUID();
    const base = source.meta.name.replace(/\.docx$/i, "");
    const meta: StoredFileMeta = {
      name: `${base}（已修改）.docx`,
      size: buffer.length,
      kind: "edited",
      sourceFileId,
      createdAt: new Date().toISOString(),
    };
    await this.write(fileId, buffer, meta);
    return { fileId, ...meta };
  }

  async read(fileId: string): Promise<StoredFile | undefined> {
    if (!FILE_ID_PATTERN.test(fileId)) return undefined;
    const filesDir = this.filesDir();
    const filePath = path.join(filesDir, `${fileId}.docx`);
    const metaPath = path.join(filesDir, `${fileId}.json`);
    try {
      const [buffer, metaRaw] = await Promise.all([
        readFile(filePath),
        readFile(metaPath, "utf8"),
      ]);
      return {
        fileId,
        meta: JSON.parse(metaRaw) as StoredFileMeta,
        buffer,
      };
    } catch {
      return undefined;
    }
  }

  private filesDir(): string {
    const dir = path.join(path.resolve(this.rootDir), "files");
    // 二次防御：即使 fileId 合法，也确认解析后的路径仍在根目录内。
    if (!dir.startsWith(path.resolve(this.rootDir) + path.sep)) {
      throw new Error(`文档目录越界: ${dir}`);
    }
    return dir;
  }

  private async write(
    fileId: string,
    buffer: Buffer,
    meta: StoredFileMeta,
  ): Promise<void> {
    if (!FILE_ID_PATTERN.test(fileId)) {
      throw new Error(`非法文件 ID: ${fileId}`);
    }
    const filesDir = this.filesDir();
    await mkdir(filesDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(filesDir, `${fileId}.docx`), buffer),
      writeFile(path.join(filesDir, `${fileId}.json`), JSON.stringify(meta)),
    ]);
  }
}
