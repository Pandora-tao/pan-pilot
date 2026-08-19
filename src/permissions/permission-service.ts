import { randomUUID } from "node:crypto";
import type { ToolPermissionAsk } from "../tools/tool.js";
import { PermissionPolicy } from "./permission-policy.js";
import {
  PermissionStore,
  type StoredPermissionRule,
} from "./permission-store.js";

/**
 * 授权服务（全局单例）：权限判定、待决请求、永久规则与「授权记忆」。
 *
 * 聊天与定时任务共用同一服务；差异只在「如何等待决定」：
 * - 聊天在工具调用处阻塞等待（gate.wait），并由 onRequestCreated 通知 SSE
 *   层把 permission_request 事件发给前端；
 * - 定时任务在需要确认时不等待（onRequestCreated 后抛 PermissionPendingError，
 *   Agent 保存检查点、调度器进入 needs_confirmation），决定后从同一待执行工具
 *   恢复——重跑命中本进程授权记忆，不重复询问、不重复副作用。
 *
 * 本服务不写服务端日志；请求摘要 / diff / 命令 / 路径永不落入日志。
 */

export type DecisionAction = "allow_once" | "allow_always" | "reject";

export type PermissionRequestStatus =
  | "pending"
  | "allowed_once"
  | "allowed_always"
  | "rejected"
  | "expired";

export interface PermissionRequest {
  id: string;
  key: string;
  toolName: string;
  op: string;
  target: string;
  summary: string;
  diff?: string;
  permanentlyAllowable: boolean;
  origin: string;
  callId?: string;
  runId?: string;
  createdAt: string;
  expiresAt: string;
  status: PermissionRequestStatus;
}

export type PermissionRequestPublic = Omit<PermissionRequest, "key">;

export class PermissionDecisionError extends Error {
  readonly code: "NOT_FOUND" | "ALREADY_DECIDED" | "EXPIRED" | "NOT_ALLOWED";

  constructor(code: PermissionDecisionError["code"], message: string) {
    super(message);
    this.name = "PermissionDecisionError";
    this.code = code;
  }
}

export interface PermissionRule {
  id: string;
  createdAt: string;
  kind: "file" | "command";
  pattern: string;
  operations: string[];
}

export interface PermissionServiceOptions {
  store: PermissionStore;
  /** 待决请求默认 15 分钟；聊天场景另有单工具超时兜底。 */
  requestTimeoutMs?: number;
  extraSensitivePatterns?: readonly string[];
  now?: () => Date;
  /** 新建待决请求时通知（聊天 SSE 发事件 / 定时任务登记挂起）。 */
  onRequestCreated?: (request: PermissionRequestPublic) => void;
  /** 一条待决请求被决定后通知（携带 runId 时用于调度器续跑任务）。 */
  onRequestDecided?: (request: PermissionRequestPublic) => void;
}

interface PendingEntry {
  request: PermissionRequest;
  resolver?: (outcome: PermissionOutcome) => void;
  settled: boolean;
  clearExpiry?: () => void;
}

/** 一次授权的结果：allowed 或 denied（决议超时、用户拒绝）。 */
export type PermissionOutcome = "allowed" | "denied";

/**
 * 授权门：要么立刻得出结果（outcome 存在），
 * 要么需要用户确认（request 存在，wait 等待决定）。
 */
export interface ApprovalGate {
  outcome?: PermissionOutcome;
  request?: PermissionRequestPublic;
  wait(signal?: AbortSignal): Promise<PermissionOutcome>;
}

export interface ApprovalScope {
  origin: string;
  callId?: string;
  runId?: string;
}

export class PermissionService {
  private readonly policy: PermissionPolicy;
  private readonly store: PermissionStore;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private readonly onRequestCreated: ((request: PermissionRequestPublic) => void) | undefined;
  private readonly onRequestDecided: ((request: PermissionRequestPublic) => void) | undefined;

  private readonly pending = new Map<string, PendingEntry>();
  /** 已处理（决定/过期/中止）的请求 id，用于识别「重复决定」。 */
  private readonly settledIds = new Set<string>();
  /** 本进程会话内「同一授权键已决定」的记忆：支持任务恢复与拒绝反馈。 */
  private readonly grants = new Map<string, PermissionOutcome>();

  constructor(options: PermissionServiceOptions) {
    this.policy = new PermissionPolicy(options.extraSensitivePatterns);
    this.store = options.store;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.onRequestCreated = options.onRequestCreated;
    this.onRequestDecided = options.onRequestDecided;
    this.rehydratePersisted();
  }

  /** 判定目标路径是否敏感（供只读工具决定是否进入授权流程）。 */
  isSensitivePath(absPath: string): Promise<boolean> {
    return this.policy.isSensitivePath(absPath);
  }

  /** 终端命令分类：严格只读白名单自动放行，其余询问。 */
  classifyTerminalCommand(command: string): {
    action: "allow" | "ask";
    permanentlyAllowable: boolean;
    destructive: boolean;
  } {
    return this.policy.classifyTerminalCommand(command);
  }

  /**
   * 计算一次授权门。全部策略判定集中在这里：
   *
   * - 终端命令：严格只读白名单自动允许；其余询问且不永久放行；
   * - 文件读取：非敏感自动允许，敏感路径询问且不永久放行；
   * - 写入 / 编辑 / 补丁：命中永久规则或授权记忆则放行，否则询问；
   * - 删除：始终询问且不永久放行（敏感路径同理）。
   */
  async gate(
    ask: ToolPermissionAsk,
    scope: ApprovalScope,
  ): Promise<ApprovalGate> {
    const key = grantKey(ask.toolName, ask.op, ask.target);

    if (ask.op === "command") {
      const cls = this.policy.classifyTerminalCommand(ask.target);
      if (cls.action === "allow") return immediate("allowed");
      return this.openRequest(ask, scope, key, false);
    }

    const sensitive = await this.policy.isSensitivePath(ask.target);
    if (ask.op === "read") {
      if (!sensitive) return immediate("allowed");
      const remembered = this.grants.get(key);
      if (remembered !== undefined) return immediate(remembered);
      return this.openRequest(ask, scope, key, false);
    }

    const permanentlyAllowable = ask.permanentlyAllowable
      && !sensitive
      // 删除始终询问、不可永久放行。
      && ask.op !== "delete";
    if (permanentlyAllowable && this.matchesRule(ask)) {
      return immediate("allowed");
    }
    const remembered = this.grants.get(key);
    if (remembered !== undefined) return immediate(remembered);
    return this.openRequest(ask, scope, key, permanentlyAllowable);
  }

  /** 登记一条需要用户确认的待决请求。 */
  private openRequest(
    ask: ToolPermissionAsk,
    scope: ApprovalScope,
    key: string,
    permanentlyAllowable: boolean,
  ): ApprovalGate {
    const now = this.now();
    const request: PermissionRequest = {
      id: randomUUID(),
      key,
      toolName: ask.toolName,
      op: ask.op,
      target: ask.target,
      summary: ask.summary,
      ...(ask.diff === undefined ? {} : { diff: ask.diff }),
      permanentlyAllowable,
      origin: scope.origin,
      ...(scope.callId === undefined ? {} : { callId: scope.callId }),
      ...(scope.runId === undefined ? {} : { runId: scope.runId }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.requestTimeoutMs).toISOString(),
      status: "pending",
    };

    const entry: PendingEntry = { request, settled: false };
    this.pending.set(request.id, entry);

    // 定时任务关联的待决请求持久化，服务重启后可继续决定并续跑。
    if (scope.runId !== undefined) {
      this.store.upsertPending(toStored(request));
    }

    this.onRequestCreated?.(publicRequest(request));

    return {
      request: publicRequest(request),
      wait: (signal?: AbortSignal) => this.waitForDecision(request, entry, signal),
    };
  }

  /** 用户对一条待决请求提交决定。 */
  decide(requestId: string, action: DecisionAction): PermissionRequestPublic {
    const entry = this.pending.get(requestId);
    if (entry === undefined) {
      if (this.settledIds.has(requestId)) {
        throw new PermissionDecisionError("ALREADY_DECIDED", "该授权请求已处理");
      }
      throw new PermissionDecisionError("NOT_FOUND", "授权请求不存在或已过期");
    }
    if (entry.settled) {
      throw new PermissionDecisionError("ALREADY_DECIDED", "该授权请求已处理");
    }
    const request = entry.request;
    if (new Date(request.expiresAt).getTime() <= this.now().getTime()) {
      this.discard(request, entry);
      throw new PermissionDecisionError("EXPIRED", "授权请求已过期，请重新发起");
    }

    if (action === "reject") {
      request.status = "rejected";
      this.resolve(request, entry, "denied");
      return publicRequest(request);
    }

    if (action === "allow_always" && !request.permanentlyAllowable) {
      throw new PermissionDecisionError(
        "NOT_ALLOWED",
        "该操作不允许永久放行（敏感路径或破坏性操作）",
      );
    }
    request.status = action === "allow_always" ? "allowed_always" : "allowed_once";
    if (action === "allow_always") this.persistRule(request);
    this.resolve(request, entry, "allowed");
    return publicRequest(request);
  }

  listPending(): PermissionRequestPublic[] {
    const now = Date.now();
    return [...this.pending.values()]
      .filter((entry) => !entry.settled
        && new Date(entry.request.expiresAt).getTime() > now)
      .map((entry) => publicRequest(entry.request));
  }

  getPending(requestId: string): PermissionRequestPublic | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.settled) return undefined;
    return publicRequest(entry.request);
  }

  listRules(): PermissionRule[] {
    return this.store.loadRules().map((rule) => ({
      id: rule.id,
      createdAt: rule.createdAt,
      kind: rule.kind,
      pattern: rule.pattern,
      operations: [...rule.operations],
    }));
  }

  revokeRule(id: string): boolean {
    return this.store.deleteRule(id);
  }

  private async waitForDecision(
    request: PermissionRequest,
    entry: PendingEntry,
    signal?: AbortSignal,
  ): Promise<PermissionOutcome> {
    // 已被决定（如先 decide 后 wait，或重跑同一授权键）→ 直接返回记忆结果。
    const remembered = this.grants.get(request.key);
    if (remembered !== undefined) return remembered;

    if (signal?.aborted) {
      this.discard(request, entry);
      signal.throwIfAborted();
    }

    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<PermissionOutcome>((resolve) => {
      const remaining = new Date(request.expiresAt).getTime() - Date.now();
      expiryTimer = setTimeout(
        () => resolve(this.expire(request, entry)),
        Math.max(0, remaining),
      );
      expiryTimer.unref?.();
    });
    entry.clearExpiry = () => {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    };

    const decided = new Promise<PermissionOutcome>((resolve) => {
      entry.resolver = (outcome) => {
        entry.clearExpiry?.();
        resolve(outcome);
      };
    });

    try {
      if (signal === undefined) {
        return await Promise.race([decided, expiry]);
      }
      return await Promise.race([
        decided,
        expiry,
        abortRejection(signal, () => this.discard(request, entry)),
      ]);
    } finally {
      entry.clearExpiry?.();
    }
  }

  /** 决定完成：写入记忆、清理待决并通知续跑。 */
  private resolve(
    request: PermissionRequest,
    entry: PendingEntry,
    outcome: PermissionOutcome,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolver?.(outcome);
    entry.clearExpiry?.();
    this.grants.set(request.key, outcome);
    this.settledIds.add(request.id);
    this.pending.delete(request.id);
    if (request.runId !== undefined) this.store.removePending(request.id);
    this.onRequestDecided?.(publicRequest(request));
  }

  /** 请求过期：解为 denied，不写记忆（下次单独询问）。 */
  private expire(
    request: PermissionRequest,
    entry: PendingEntry,
  ): PermissionOutcome {
    if (entry.settled) return "denied";
    entry.settled = true;
    entry.clearExpiry?.();
    request.status = "expired";
    this.settledIds.add(request.id);
    this.pending.delete(request.id);
    if (request.runId !== undefined) this.store.removePending(request.id);
    return "denied";
  }

  /** 客户端中止 / 确认续跑前清理：不写记忆、不通知。 */
  private discard(request: PermissionRequest, entry: PendingEntry): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.clearExpiry?.();
    this.settledIds.add(request.id);
    this.pending.delete(request.id);
    if (request.runId !== undefined) this.store.removePending(request.id);
  }

  private matchesRule(ask: ToolPermissionAsk): boolean {
    if (!ask.permanentlyAllowable) return false;
    return this.store.loadRules().some((rule) =>
      rule.operations.includes(ask.op)
        && ((rule.kind === "file" && ask.op !== "command" && rule.pattern === ask.target)
          || (rule.kind === "command" && ask.op === "command"
            && rule.pattern === ask.target.trim())));
  }

  private persistRule(request: PermissionRequest): void {
    const rule: StoredPermissionRule = {
      id: randomUUID(),
      createdAt: request.createdAt,
      kind: request.op === "command" ? "command" : "file",
      pattern: request.op === "command" ? request.target.trim() : request.target,
      operations: [request.op],
    };
    this.store.appendRule(rule);
  }

  /** 启动时恢复持久化的定时任务待决请求，供决定并写入记忆。 */
  private rehydratePersisted(): void {
    for (const stored of this.store.loadPending()) {
      if (this.pending.has(stored.id)) continue;
      const entry: PendingEntry = { request: fromStored(stored), settled: false };
      this.pending.set(stored.id, entry);
    }
  }
}

function grantKey(toolName: string, op: string, target: string): string {
  return `${toolName}\u0000${op}\u0000${target}`;
}

function publicRequest(
  request: PermissionRequest,
): PermissionRequestPublic {
  const { key: _key, ...rest } = request;
  return rest;
}

function immediate(outcome: PermissionOutcome): ApprovalGate {
  return {
    outcome,
    wait: () => Promise.resolve(outcome),
  };
}

function abortRejection(
  signal: AbortSignal,
  onAbort: () => void,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      onAbort();
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => {
      onAbort();
      reject(signal.reason);
    }, { once: true });
  });
}

/** 授权请求的持久化形态（与 PermissionStore 的 StoredPendingRequest 同构）。 */
export interface PersistedRequest {
  id: string;
  key: string;
  toolName: string;
  op: string;
  target: string;
  summary: string;
  diff?: string;
  permanentlyAllowable: boolean;
  scope: { origin: string; callId?: string; runId?: string };
  createdAt: string;
  expiresAt: string;
}

/** PermissionRequest -> 持久化形态。 */
function toStored(request: PermissionRequest): PersistedRequest {
  return {
    id: request.id,
    key: request.key,
    toolName: request.toolName,
    op: request.op,
    target: request.target,
    summary: request.summary,
    ...(request.diff === undefined ? {} : { diff: request.diff }),
    permanentlyAllowable: request.permanentlyAllowable,
    scope: {
      origin: request.origin,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.runId === undefined ? {} : { runId: request.runId }),
    },
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

/** 持久化形态 -> PermissionRequest。 */
function fromStored(stored: PersistedRequest): PermissionRequest {
  return {
    id: stored.id,
    key: stored.key,
    toolName: stored.toolName,
    op: stored.op,
    target: stored.target,
    summary: stored.summary,
    ...(stored.diff === undefined ? {} : { diff: stored.diff }),
    permanentlyAllowable: stored.permanentlyAllowable,
    origin: stored.scope.origin,
    ...(stored.scope.callId === undefined ? {} : { callId: stored.scope.callId }),
    ...(stored.scope.runId === undefined ? {} : { runId: stored.scope.runId }),
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    status: "pending",
  };
}
