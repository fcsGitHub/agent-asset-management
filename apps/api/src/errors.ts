// 统一错误契约（设计 21 章）：稳定错误码 + 可展示说明 + 可重试 + 请求 ID。
export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public retryable = false,
    public details?: unknown
  ) {
    super(message);
  }
}

export const ERR = {
  UNAUTHORIZED: () => new AppError("UNAUTHORIZED", 401, "未登录或会话已失效"),
  FORBIDDEN: () => new AppError("ACTION_NOT_ALLOWED", 403, "当前身份无权执行该操作"),
  NOT_FOUND: () => new AppError("NOT_FOUND", 404, "对象不存在或无权访问"),
  CONFLICT: (code: string, message: string, details?: unknown) =>
    new AppError(code, 409, message, false, details),
  INVALID: (message: string, details?: unknown) =>
    new AppError("SCHEMA_INVALID", 422, message, false, details),
  CSRF: () => new AppError("CSRF_TOKEN_INVALID", 403, "CSRF 校验失败，请刷新页面重试"),
  DEPENDENCY: (message: string) => new AppError("DEPENDENCY_UNAVAILABLE", 503, message, true),
} as const;
