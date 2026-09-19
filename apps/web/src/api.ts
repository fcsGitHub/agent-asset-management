// API 客户端：自动携带会话 Cookie 与 CSRF 头；统一错误展开。
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)taw_csrf=([a-f0-9]+)/);
  return m ? m[1]! : "";
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<T> {
  const method = opts.method ?? "GET";
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = csrf();
  const res = await fetch(url.toString(), {
    method,
    headers,
    credentials: "same-origin",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(err?.code ?? "HTTP_ERROR", err?.message ?? `HTTP ${res.status}`, res.status, err?.details);
  }
  return data as T;
}

export async function uploadFile(
  teamId: string,
  file: File
): Promise<{ uploadId: string; digest: string; size: number; mediaType: string; originalName: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/v1/uploads?teamId=${encodeURIComponent(teamId)}`, {
    method: "POST",
    headers: { "x-csrf-token": csrf() },
    credentials: "same-origin",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(err?.code ?? "HTTP_ERROR", err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return data;
}
