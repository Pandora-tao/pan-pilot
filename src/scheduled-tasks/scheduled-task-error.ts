export type ScheduledTaskErrorCode =
  | "AUTH_NOT_CONFIGURED"
  | "SCHEDULE_STORE_UNAVAILABLE"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_ACTIVE"
  | "TASK_RUN_NOT_FOUND"
  | "TASK_RUN_NOT_PAUSABLE"
  | "TASK_RUN_NOT_RESUMABLE"
  | "TASK_RUN_CONFIRMATION_REQUIRED"
  | "TASK_SCHEDULE_PAST"
  | "TASK_SCHEDULE_INVALID"
  | "TASK_MODEL_UNSUPPORTED"
  | "TASK_MODEL_UNAVAILABLE";

export class ScheduledTaskError extends Error {
  constructor(
    readonly code: ScheduledTaskErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}
