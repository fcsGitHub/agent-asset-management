// @taw/api — Fastify 模块化单体入口。
// 中间件顺序：cookie 解析 → 认证加载 → 路由（各路由自查 CSRF 与权限）→ 统一错误映射。
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { loadAuth } from "./auth.js";
import { AppError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { uploadRoutes } from "./routes/uploads.js";
import { catalogRoutes } from "./routes/catalog.js";
import { messageRoutes } from "./routes/messages.js";

export async function buildServer() {
  const app = Fastify({
    logger: false,
    requestTimeout: 60000,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(multipart, { attachFieldsToBody: false });

  app.addHook("onRequest", async (req) => {
    await loadAuth(req);
  });

  app.get("/healthz", async () => ({ ok: true, service: "api" }));

  // 错误处理器必须在注册业务路由插件之前设置，否则被封装上下文绕过。
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          requestId: req.id,
          details: err.details,
        },
      });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (anyErr.statusCode === 400 || (anyErr.code ?? "").startsWith("FST_ERR")) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: anyErr.message ?? "请求格式错误", retryable: false, requestId: req.id },
      });
    }
    console.error(`unhandled [${req.method} ${req.url}]:`, anyErr.code, anyErr.message);
    if (process.env.LOG_SQL_STACK === "1") {
      console.error((err as Error).stack);
    }
    return reply.code(500).send({
      error: { code: "INTERNAL", message: "服务器内部错误", retryable: false, requestId: req.id },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: "接口不存在", retryable: false, requestId: "" },
    });
  });

  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(projectRoutes, { prefix: "/api/v1" });
  await app.register(uploadRoutes, { prefix: "/api/v1" });
  await app.register(catalogRoutes, { prefix: "/api/v1" });
  await app.register(messageRoutes, { prefix: "/api/v1" });

  return app;
}

export async function startServer(): Promise<void> {
  const port = Number(process.env.API_PORT ?? 4000);
  const app = await buildServer();
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`api listening on http://127.0.0.1:${port}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  startServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
