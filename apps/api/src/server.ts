// @taw/api — Fastify 模块化单体入口。路由随里程碑注册。
import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({ logger: false, requestTimeout: 30000 });
  app.get("/healthz", async () => ({ ok: true, service: "api" }));
  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const port = Number(process.env.API_PORT ?? 4000);
  buildServer()
    .listen({ port, host: "127.0.0.1" })
    .then(() => console.log(`api listening on ${port}`))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
