// @taw/worker — outbox 派发 worker 入口。
// 真实至少一次投递：租约抢占 + 超时回收 + 退避重试；接收端按 eventId 幂等去重。
// 自 M49 起同时托管图投影对账器（脏团队重建 + 启动漂移对账，图库不可达诚实降级）。
import { startDispatcher } from "./dispatcher.js";
import { startGraphReconciler } from "./graph-projector.js";

export const WORKER_ID = `worker-${process.pid}`;

async function main(): Promise<void> {
  const stop = startDispatcher({}, (s) => {
    console.log(
      `[${WORKER_ID}] leased=${s.leased} delivered=${s.delivered} failed=${s.failed}` +
        (s.failed > 0 ? ` firstError=${s.events.find((e) => !e.ok)?.error ?? ""}` : "")
    );
  });
  console.log(`[${WORKER_ID}] outbox dispatcher started (poll=${process.env.OUTBOX_POLL_MS ?? 2000}ms, dispatch=${process.env.OUTBOX_DISPATCH_URL ? "configured" : "NOT configured — idling"})`);
  const graph = startGraphReconciler((msg) => console.log(`[${WORKER_ID}] ${msg}`));
  const shutdown = async (sig: string) => {
    console.log(`[${WORKER_ID}] ${sig} received, stopping…`);
    await graph.stop();
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
