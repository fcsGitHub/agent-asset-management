// @taw/contracts — API / 事件 / 工具 schema（zod）。随里程碑逐步充实。
export const API_PREFIX = "/api/v1";

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  details?: unknown;
}
