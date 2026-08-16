import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";

/** 附件 ID 白名单：只允许 URL 安全字符，从根上挡住路径穿越。 */
export const MEDIA_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export type MediaKind = "image" | "audio" | "text" | "document" | "binary";

export interface StoredMediaMeta {
  /** 上传时的原始文件名（已规范化到 basename，不包含路径）。 */
  name: string;
  size: number;
  kind: MediaKind;
  /** 由内容检测（魔数/UTF-8/扩展名）得到的 MIME 类型，不信任客户端声明。 */
  mimeType: string;
  /** 规范化扩展名（如 png / jpeg / mp3 / pdf / docx / txt / bin）。 */
  extension: string;
  createdAt: string;
}

export interface StoredMedia {
  mediaId: string;
  meta: StoredMediaMeta;
  buffer: Buffer;
}

export type MediaStoreErrorCode =
  | "INVALID_MEDIA_ID"
  | "MEDIA_TOO_LARGE"
  | "UNSUPPORTED_EXTENSION"
  | "INVALID_MEDIA"
  | "MEDIA_DELETE_FAILED";

/** 媒体存储的稳定错误码，路由据此映射 HTTP 状态码。 */
export class MediaStoreError extends Error {
  readonly code: MediaStoreErrorCode;
  /** 底层原因（如 EACCES/EPERM/EIO），仅服务端日志使用，不回传 HTTP。 */
  readonly cause: Error | undefined;

  constructor(code: MediaStoreErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = "MediaStoreError";
    this.code = code;
    this.cause = cause;
  }
}

export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 魔数可识别格式的扩展名到规范化类型映射；jpg/jpeg 都归一到 jpeg。
 * 这些格式的扩展名必须与文件内容一致（防伪装/多态文件）；
 * text/binary 不在此映射内，扩展名只影响 MIME 与存储文件名。
 */
const EXTENSION_TO_TYPE: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  gif: "gif",
  mp3: "mp3",
  wav: "wav",
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
};

/** 文本类扩展名白名单：内容必须同时是合法 UTF-8 才归为 text。 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "log",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "go",
  "rs",
  "sh",
  "bash",
  "zsh",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "sql",
  "ini",
  "toml",
  "cfg",
  "conf",
  "properties",
  "env",
]);

/** 文本扩展名到 MIME 的映射；未列出的文本统一 text/plain。 */
const TEXT_MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/jsonl",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
};

/** 存储文件扩展名的安全形状：只允许小写字母数字，从根上杜绝路径穿越。 */
const SAFE_EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const BINARY_MIME = "application/octet-stream";

const KNOWN_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "text/plain",
  PDF_MIME,
  DOCX_MIME,
  PPTX_MIME,
  BINARY_MIME,
  ...Object.values(TEXT_MIME_TYPES),
]);

/**
 * 边车 JSON 的严格校验 schema。
 *
 * 文件系统上的 JSON 是可篡改输入，与 HTTP 请求体同等对待：
 * kind/mimeType/extension/size/name 全部显式校验，extension 必须是
 * 安全字母数字形状，拒绝任何含路径分隔符或目录穿越的写法。
 */
const storedMediaMetaSchema = z.object({
  name: z.string().min(1).max(512)
    .refine((name) => path.basename(name) === name, "name 必须是不含路径的文件名"),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "audio", "text", "document", "binary"]),
  mimeType: z.string().refine(
    (mimeType) => KNOWN_MIME_TYPES.has(mimeType),
    "mimeType 不在受支持集合内",
  ),
  extension: z.string().refine(
    (extension) => SAFE_EXTENSION_PATTERN.test(extension),
    "extension 不是安全文件名",
  ),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export interface MediaStoreOptions {
  maxBytes?: number;
  /** 删除文件实现（默认 node:fs/promises rm，force 模式幂等）；测试注入替身。 */
  deleteFileImpl?: (filePath: string) => Promise<void>;
  /** 列出媒体目录实现（默认 readdir）；测试注入替身。 */
  readDirImpl?: (dirPath: string) => Promise<string[]>;
}

interface DetectedMedia {
  kind: MediaKind;
  mimeType: string;
  extension: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const MP3_ID3_MAGIC = Buffer.from([0x49, 0x44, 0x33]);

/**
 * 受控附件存储：上传内容先通过内容检测（魔数/UTF-8）与扩展名校验，
 * 工具只能通过 mediaId 访问，绝不接受文件路径或远程 URL。
 *
 * 类型规则：
 * - image/audio/document（pdf/docx/pptx）：由魔数与 OOXML 包结构判定，
 *   扩展名必须与内容一致；
 * - text：内容为合法 UTF-8（扩展名为空或属于文本白名单）；
 * - 其余一律 binary（application/octet-stream），只提供元信息。
 *
 * 布局：<root>/media/<mediaId>.<extension> + <mediaId>.meta.json（元数据边车）。
 * 边车名带点号，与任何内容扩展名（纯字母数字）都不可能冲突，
 * 因此 JSON 附件（扩展名 json）也不会覆盖自己的边车。
 */
export class MediaStore {
  private readonly maxBytes: number;
  private readonly deleteFileImpl: (filePath: string) => Promise<void>;
  private readonly readDirImpl: (dirPath: string) => Promise<string[]>;

  constructor(
    private readonly rootDir: string,
    options: MediaStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
    this.deleteFileImpl = options.deleteFileImpl
      ?? ((filePath) => rm(filePath, { force: true }));
    this.readDirImpl = options.readDirImpl ?? readdir;
  }

  /** 校验并落盘；文件名只取 basename，扩展名必须与魔数检测结果一致。 */
  async save(buffer: Buffer, originalName: string) {
    if (buffer.length === 0) {
      throw new MediaStoreError("INVALID_MEDIA", "附件内容为空");
    }
    if (buffer.length > this.maxBytes) {
      throw new MediaStoreError(
        "MEDIA_TOO_LARGE",
        `附件不能超过 ${this.maxBytes} 字节`,
      );
    }

    // 文件名里即使带路径也只保留 basename，且扩展名必须与内容一致。
    const name = path.basename(originalName);
    const extension = fileExtension(name);
    const detected = detectAttachment(buffer, extension);
    if (detected === undefined) {
      throw new MediaStoreError(
        "INVALID_MEDIA",
        "附件内容无法识别",
      );
    }
    // 魔数可识别格式：扩展名必须与内容一致（防止伪装/多态文件）。
    if (
      detected.kind !== "text"
      && detected.kind !== "binary"
      && EXTENSION_TO_TYPE[extension] !== detected.extension
    ) {
      throw new MediaStoreError(
        "UNSUPPORTED_EXTENSION",
        `扩展名 .${extension === "" ? "(无)" : extension} 与文件内容`
        + `（${detected.extension}）不一致或不受支持`,
      );
    }
    // OOXML 魔数只证明是 zip 容器；结构必须包含对应格式的必需包条目。
    if (detected.kind === "document" && detected.extension === "docx") {
      try {
        await assertDocxStructure(buffer);
      } catch {
        throw new MediaStoreError("INVALID_MEDIA", "文件内容不是有效的 docx");
      }
    }
    if (detected.kind === "document" && detected.extension === "pptx") {
      try {
        await assertPptxStructure(buffer);
      } catch {
        throw new MediaStoreError("INVALID_MEDIA", "文件内容不是有效的 pptx");
      }
    }

    const mediaId = randomUUID();
    const meta: StoredMediaMeta = {
      name,
      size: buffer.length,
      kind: detected.kind,
      mimeType: detected.mimeType,
      extension: detected.extension,
      createdAt: new Date().toISOString(),
    };
    await this.write(mediaId, buffer, meta);
    return { mediaId, ...meta };
  }

  /** 边车文件名：带点号，与任何内容扩展名（纯字母数字）互斥。 */
  private sidecarName(mediaId: string): string {
    return `${mediaId}.meta.json`;
  }

  /**
   * 读取受控媒体。
   *
   * 边车 JSON 必须先通过严格 schema 校验，篡改（含改写 extension 以穿越
   * 目录）一律视为不存在返回 undefined；媒体文件名只由白名单 extension
   * 参与拼接，因此不可能逃逸 media 目录。
   */
  async read(mediaId: string): Promise<StoredMedia | undefined> {
    if (!MEDIA_ID_PATTERN.test(mediaId)) return undefined;
    const mediaDir = this.mediaDir();

    const metaRaw = await readFile(
      path.join(mediaDir, this.sidecarName(mediaId)),
      "utf8",
    ).catch(async () => {
      // 兼容旧布局 <mediaId>.json（当时只有图片/音频，不会与内容冲突）。
      return readFile(path.join(mediaDir, `${mediaId}.json`), "utf8")
        .catch(() => undefined);
    });
    if (metaRaw === undefined) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(metaRaw);
    } catch {
      return undefined;
    }
    const metaResult = storedMediaMetaSchema.safeParse(parsed);
    if (!metaResult.success) return undefined;
    const meta = metaResult.data as StoredMediaMeta;

    const buffer = await readFile(
      path.join(mediaDir, `${mediaId}.${meta.extension}`),
    ).catch(() => undefined);
    if (buffer === undefined) return undefined;

    // 二次内容校验：边车元数据即使通过 schema，也可能被整体替换成与真实内容
    // 不一致的 kind/mimeType/extension；内容不一致的一律视为不存在。
    // 用 meta.extension 作为扩展名提示，保证与保存时的分类规则一致。
    const detected = detectAttachment(buffer, meta.extension);
    if (
      detected === undefined
      || detected.kind !== meta.kind
      || detected.extension !== meta.extension
      || detected.mimeType !== meta.mimeType
    ) {
      return undefined;
    }
    if (meta.kind === "document" && meta.extension === "docx") {
      try {
        await assertDocxStructure(buffer);
      } catch {
        return undefined;
      }
    }
    if (meta.kind === "document" && meta.extension === "pptx") {
      try {
        await assertPptxStructure(buffer);
      } catch {
        return undefined;
      }
    }

    return { mediaId, meta, buffer };
  }

  /**
   * 删除受控媒体（媒体文件 + 元数据边车），供 DELETE /v1/media/:mediaId 与
   * 外部调用方清理副本使用。
   *
   * - mediaId 必须先通过白名单（路径穿越被双重防御）；
   * - 边车缺失/损坏或媒体文件缺失（部分文件状态）时，尽力删除所有存在部分；
   * - 不存在任何相关文件时返回 false，其余情况返回 true。
   */
  async delete(mediaId: string): Promise<boolean> {
    if (!MEDIA_ID_PATTERN.test(mediaId)) return false;
    const mediaDir = this.mediaDir();
    let entries: string[];
    try {
      entries = await this.readDirImpl(mediaDir);
    } catch (error) {
      // 目录不存在（ENOENT）视为无可删内容，幂等返回 false；
      // 其他读取失败（EACCES/EPERM/EIO 等）是真实故障，必须抛出而不是谎报成功。
      if (!isMissingError(error)) {
        throw new MediaStoreError(
          "MEDIA_DELETE_FAILED",
          "媒体删除失败",
          error instanceof Error ? error : undefined,
        );
      }
      return false;
    }

    const prefix = `${mediaId}.`;
    const targets: string[] = [];
    for (const entry of entries) {
      if (
        entry === this.sidecarName(mediaId)
        || entry === `${mediaId}.json`
      ) {
        targets.push(entry);
        continue;
      }
      // 只匹配「白名单 mediaId + 安全扩展名」的文件，无法逃逸 media 目录。
      const extension = entry.startsWith(prefix)
        ? entry.slice(prefix.length)
        : "";
      if (SAFE_EXTENSION_PATTERN.test(extension)) {
        targets.push(entry);
      }
    }
    if (targets.length === 0) return false;

    try {
      // 默认实现 force: true 已把「文件已不存在」视为成功（幂等）；
      // EACCES/EPERM/EIO 等真实删除失败必须向上抛出，绝不吞掉。
      await Promise.all(
        targets.map((entry) =>
          this.deleteFileImpl(path.join(mediaDir, entry)),
        ),
      );
    } catch (error) {
      throw new MediaStoreError(
        "MEDIA_DELETE_FAILED",
        "媒体删除失败",
        error instanceof Error ? error : undefined,
      );
    }
    return true;
  }

  private mediaDir(): string {
    const resolvedRoot = path.resolve(this.rootDir);
    const dir = path.join(resolvedRoot, "media");
    // 二次防御：即使 mediaId 合法，也确认解析后的路径仍在根目录内。
    if (!dir.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`媒体目录越界: ${dir}`);
    }
    return dir;
  }

  private async write(
    mediaId: string,
    buffer: Buffer,
    meta: StoredMediaMeta,
  ): Promise<void> {
    if (!MEDIA_ID_PATTERN.test(mediaId)) {
      throw new MediaStoreError("INVALID_MEDIA_ID", `非法媒体 ID: ${mediaId}`);
    }
    const mediaDir = this.mediaDir();
    await mkdir(mediaDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(mediaDir, `${mediaId}.${meta.extension}`), buffer),
      writeFile(
        path.join(mediaDir, this.sidecarName(mediaId)),
        JSON.stringify(meta),
      ),
    ]);
  }
}

/** 判断 fs 错误是否为「文件/目录不存在」（幂等可接受情形）。 */
function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * 内容检测：魔数优先；其次合法 UTF-8 文本；其余一律二进制。
 * extension 只作为文本/二进制的辅助提示（魔数格式的扩展名在 save() 单独校验）。
 */
function detectAttachment(
  buffer: Buffer,
  extension: string,
): DetectedMedia | undefined {
  if (buffer.length === 0) return undefined;
  if (
    buffer.length >= PNG_MAGIC.length
    && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
  ) {
    return { kind: "image", mimeType: "image/png", extension: "png" };
  }
  if (
    buffer.length >= JPEG_MAGIC.length
    && buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)
  ) {
    return { kind: "image", mimeType: "image/jpeg", extension: "jpeg" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "image", mimeType: "image/webp", extension: "webp" };
  }
  const gifHeader = buffer.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { kind: "image", mimeType: "image/gif", extension: "gif" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return { kind: "audio", mimeType: "audio/wav", extension: "wav" };
  }
  if (
    buffer.length >= MP3_ID3_MAGIC.length
    && buffer.subarray(0, MP3_ID3_MAGIC.length).equals(MP3_ID3_MAGIC)
  ) {
    return { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" };
  }
  // 无 ID3 标签的 MP3：MPEG 音频帧同步为 11 个置位位（0xFF Ex）。
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) {
    return { kind: "audio", mimeType: "audio/mpeg", extension: "mp3" };
  }
  if (
    buffer.length >= 5
    && buffer.subarray(0, 5).toString("latin1") === "%PDF-"
  ) {
    return { kind: "document", mimeType: PDF_MIME, extension: "pdf" };
  }
  if (isZipMagic(buffer)) {
    return extension === "pptx"
      ? { kind: "document", mimeType: PPTX_MIME, extension: "pptx" }
      : { kind: "document", mimeType: DOCX_MIME, extension: "docx" };
  }
  if (isValidUtf8(buffer) && (extension === "" || TEXT_EXTENSIONS.has(extension))) {
    const safeExtension = TEXT_EXTENSIONS.has(extension) ? extension : "txt";
    return {
      kind: "text",
      mimeType: TEXT_MIME_TYPES[safeExtension] ?? "text/plain",
      extension: safeExtension,
    };
  }
  return {
    kind: "binary",
    mimeType: BINARY_MIME,
    extension: SAFE_EXTENSION_PATTERN.test(extension) ? extension : "bin",
  };
}

function isZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    && buffer[3] === 0x04;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 校验 PowerPoint OOXML 包的核心结构，避免把任意 ZIP 当作 PPTX。 */
async function assertPptxStructure(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  if (
    !zip.file("[Content_Types].xml")
    || !zip.file("ppt/presentation.xml")
    || !Object.keys(zip.files).some((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
  ) {
    throw new Error("不是有效的 pptx：缺少必需的包条目");
  }
}

/** 校验 Word OOXML 包的核心结构，上传层只负责格式真实性，不解析正文。 */
async function assertDocxStructure(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  const contentTypes = zip.file("[Content_Types].xml");
  if (
    contentTypes === null
    || !zip.file("word/document.xml")
    || !(await contentTypes.async("string")).includes("wordprocessingml.document")
  ) {
    throw new Error("不是有效的 docx：缺少必需的包条目");
  }
}

/** 严格 UTF-8 解码：任何非法字节序列都判定为非文本内容。 */
function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}
