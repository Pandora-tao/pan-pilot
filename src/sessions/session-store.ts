import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MEDIA_ID_PATTERN } from "../media/media-store.js";

/** 会话 ID 白名单：只允许 URL 安全字符，从根上挡住路径穿越。 */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/** 附件引用只记录受控媒体元信息，不保存媒体字节。 */
const sessionAttachmentSchema = z.object({
  mediaId: z.string().regex(MEDIA_ID_PATTERN),
  name: z.string().min(1).max(512)
    .refine((name) => path.basename(name) === name, "name 必须是不含路径的文件名"),
  kind: z.enum(["image", "audio", "text", "document", "binary"]),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(128),
}).strict();

export const sessionMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(100_000),
  attachments: z.array(sessionAttachmentSchema).max(10).optional(),
}).strict();

export type SessionMessage = z.infer<typeof sessionMessageSchema>;

/** 会话文件的严格校验 schema：磁盘 JSON 视为可篡改输入。 */
const sessionSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(SESSION_ID_PATTERN),
  title: z.string().min(1).max(80),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  messages: z.array(sessionMessageSchema).max(500),
}).strict();

export type ChatSession = z.infer<typeof sessionSchema>;

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

const MAX_TITLE_CHARS = 40;

/**
 * 会话历史存储：每个会话一个 JSON 文件，原子写入（临时文件 + rename）。
 *
 * 布局：<root>/sessions/<sessionId>.json；损坏/篡改文件在读取时视为不存在，
 * 列表跳过坏文件，绝不把磁盘内容直接回传。
 */
export class SessionStore {
  private readonly resolvedRootDir: string;

  constructor(private readonly rootDir: string) {
    this.resolvedRootDir = path.resolve(rootDir);
  }

  /** 新建一个空的本地会话对象（尚未落盘）。 */
  newSession(): ChatSession {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: randomUUID(),
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  /** 按更新时间倒序返回会话摘要；损坏文件跳过。 */
  async list(): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionsDir());
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const session = await this.read(id);
      if (session !== undefined) {
        summaries.push({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
        });
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async read(id: string): Promise<ChatSession | undefined> {
    if (!SESSION_ID_PATTERN.test(id)) return undefined;
    const raw = await readFile(
      path.join(this.sessionsDir(), `${id}.json`),
      "utf8",
    ).catch(() => undefined);
    if (raw === undefined) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = sessionSchema.safeParse(parsed);
    if (!result.success) return undefined;
    return result.data;
  }

  /** 原子落盘；写入前先经过严格 schema 校验。 */
  async save(session: ChatSession): Promise<void> {
    const parsed = sessionSchema.safeParse(session);
    if (!parsed.success) {
      throw new Error("会话数据校验失败");
    }
    const dir = this.sessionsDir();
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.${session.id}-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(tempPath, path.join(dir, `${session.id}.json`));
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!SESSION_ID_PATTERN.test(id)) return false;
    if (await this.read(id) === undefined) return false;
    await rm(path.join(this.sessionsDir(), `${id}.json`), { force: true });
    return true;
  }

  private sessionsDir(): string {
    return path.join(this.resolvedRootDir, "sessions");
  }
}

/** 从第一条 user 消息推导标题；没有用户消息时用默认名。 */
export function deriveSessionTitle(messages: readonly SessionMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const raw = firstUser?.content.trim().replace(/\s+/g, " ") ?? "";
  if (raw === "") return "新会话";
  if (raw.length <= MAX_TITLE_CHARS) return raw;
  return `${raw.slice(0, MAX_TITLE_CHARS)}…`;
}
