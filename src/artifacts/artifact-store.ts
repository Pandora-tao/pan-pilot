import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ARTIFACT_ID_PATTERN = /^[a-zA-Z0-9-]+$/;
export const MAX_ARTIFACT_BYTES = 512 * 1024;
// JSON 会把控制字符转义为 \uXXXX，最坏约为原始 UTF-8 字节数的 6 倍。
const MAX_ARTIFACT_STATE_BYTES = MAX_ARTIFACT_BYTES * 7;

export const artifactFormatSchema = z.enum([
  "html",
  "css",
  "javascript",
  "typescript",
  "json",
  "markdown",
  "text",
]);

export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

const FORMAT_INFO: Record<ArtifactFormat, { extension: string; mimeType: string }> = {
  html: { extension: "html", mimeType: "text/html; charset=utf-8" },
  css: { extension: "css", mimeType: "text/css; charset=utf-8" },
  javascript: { extension: "js", mimeType: "text/javascript; charset=utf-8" },
  typescript: { extension: "ts", mimeType: "text/plain; charset=utf-8" },
  json: { extension: "json", mimeType: "application/json; charset=utf-8" },
  markdown: { extension: "md", mimeType: "text/markdown; charset=utf-8" },
  text: { extension: "txt", mimeType: "text/plain; charset=utf-8" },
};

const storedArtifactSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(ARTIFACT_ID_PATTERN),
  name: z.string().min(1).max(120)
    .refine((name) => path.basename(name) === name, "name 不能包含路径"),
  format: artifactFormatSchema,
  content: z.string().min(1).max(200_000),
  sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((artifact, context) => {
  if (Buffer.byteLength(artifact.content, "utf8") !== artifact.sizeBytes) {
    context.addIssue({
      code: "custom",
      path: ["sizeBytes"],
      message: "sizeBytes 与 UTF-8 内容大小不一致",
    });
  }
  const expectedExtension = `.${artifactExtension(artifact.format)}`;
  if (!artifact.name.toLowerCase().endsWith(expectedExtension)) {
    context.addIssue({
      code: "custom",
      path: ["name"],
      message: `name 必须以 ${expectedExtension} 结尾`,
    });
  }
});

export type StoredArtifact = z.infer<typeof storedArtifactSchema>;

export interface SaveArtifactInput {
  name: string;
  format: ArtifactFormat;
  content: string;
}

/** 单文件 UTF-8 代码产物存储；每个产物一个严格校验、原子写入的版本化 JSON。 */
export class ArtifactStore {
  private readonly resolvedDir: string;

  constructor(rootDir: string) {
    this.resolvedDir = path.resolve(rootDir);
  }

  async save(input: SaveArtifactInput): Promise<StoredArtifact> {
    const content = input.content;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (path.basename(input.name) !== input.name || /[\\/]/.test(input.name)) {
      throw new Error("代码产物名称不能包含路径");
    }
    if (content.length === 0 || content.length > 200_000 || sizeBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`代码产物必须为 1–200000 个字符且不超过 ${MAX_ARTIFACT_BYTES} 字节`);
    }
    const id = randomUUID();
    const artifact = storedArtifactSchema.parse({
      version: 1,
      id,
      name: artifactFileName(input.name, input.format),
      format: input.format,
      content,
      sizeBytes,
      createdAt: new Date().toISOString(),
    });
    const serialized = `${JSON.stringify(artifact)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ARTIFACT_STATE_BYTES) {
      throw new Error("代码产物状态文件过大");
    }
    await mkdir(this.resolvedDir, { recursive: true, mode: 0o700 });
    await chmod(this.resolvedDir, 0o700);
    const tempPath = path.join(this.resolvedDir, `.${id}-${randomUUID()}.tmp`);
    const finalPath = this.pathFor(id);
    try {
      await writeFile(tempPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(tempPath, finalPath);
      return artifact;
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async read(id: string): Promise<StoredArtifact | undefined> {
    if (!ARTIFACT_ID_PATTERN.test(id)) return undefined;
    const filePath = this.pathFor(id);
    const fileStat = await stat(filePath).catch(() => undefined);
    if (fileStat === undefined || !fileStat.isFile() || fileStat.size > MAX_ARTIFACT_STATE_BYTES) {
      return undefined;
    }
    const raw = await readFile(filePath, "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      return storedArtifactSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private pathFor(id: string): string {
    return path.join(this.resolvedDir, `${id}.json`);
  }
}

export function artifactContentType(format: ArtifactFormat): string {
  return FORMAT_INFO[format].mimeType;
}

export function artifactExtension(format: ArtifactFormat): string {
  return FORMAT_INFO[format].extension;
}

function artifactFileName(rawName: string, format: ArtifactFormat): string {
  const extension = artifactExtension(format);
  const withoutMatchingExtension = rawName.trim().replace(
    new RegExp(`\\.${extension}$`, "i"),
    "",
  );
  const safeBase = withoutMatchingExtension
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safeBase || "code-artifact"}.${extension}`;
}
