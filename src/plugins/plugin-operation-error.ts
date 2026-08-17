/** 插件安装与运行时管理接口的稳定错误码。 */
export type PluginOperationErrorCode =
  | "PLUGIN_VALIDATION_FAILED"
  | "PLUGIN_CONFLICT"
  | "PLUGIN_EXISTS"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_SUGGESTION_NOT_FOUND"
  | "PLUGIN_APPLY_FAILED"
  | "PLUGIN_AUTO_INSTALL_DISABLED"
  | "AUTH_NOT_CONFIGURED";

export class PluginOperationError extends Error {
  readonly code: PluginOperationErrorCode;
  readonly details?: unknown;

  constructor(
    code: PluginOperationErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PluginOperationError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}
