/**
 * 审批协议的错误码与错误类型。
 *
 * 错误码是稳定的对外契约（HTTP 响应 `error` 字段），
 * 路由层负责把错误码映射为状态码，模型工具层直接把 message 回填给模型修正输入。
 */
export type PluginApprovalErrorCode =
  | "PLUGIN_VALIDATION_FAILED"
  | "PLUGIN_CONFLICT"
  | "PLUGIN_EXISTS"
  | "PLUGIN_NOT_FOUND"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_NOT_APPROVED"
  | "APPROVAL_ALREADY_USED"
  | "APPROVAL_HASH_MISMATCH"
  | "APPROVAL_CONCURRENT"
  | "PLUGIN_APPLY_FAILED"
  | "PLUGIN_DIR_CHANGED"
  | "AUTH_NOT_CONFIGURED";

export class PluginApprovalError extends Error {
  readonly code: PluginApprovalErrorCode;
  readonly details?: unknown;

  constructor(
    code: PluginApprovalErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PluginApprovalError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}
