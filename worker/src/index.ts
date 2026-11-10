import { Hono } from "hono";
import { meRoutes } from "./api/me";
import { receiptRoutes } from "./api/receipts";
import type { AppDeps, AppEnv } from "./app-env";
import { checkOrigin, requireUser } from "./auth/middleware";
import { authRoutes } from "./auth/routes";
import { getDb } from "./db/client";
import { devRoutes } from "./dev/routes";
import type { Bindings } from "./env";

const defaultDeps: AppDeps = { fetch: (input, init) => fetch(input, init) };

/** Tests pass fake deps (Google fetch); production uses the global fetch. */
export function createApp(deps: AppDeps = defaultDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("db", getDb(c.env.DB));
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.route("/api/dev", devRoutes);
  app.route("/auth", authRoutes);

  // Everything else under /api needs a session; state-changing routes also need our Origin.
  app.use("/api/*", checkOrigin, requireUser);
  app.route("/api/me", meRoutes);
  app.route("/api/receipts", receiptRoutes);
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.log(JSON.stringify({ event: "unhandled_error", name: err.name }));
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

export const app = createApp();

export interface ReceiptMessage {
  receiptId: string;
  userId: string;
}

export default {
  fetch: app.fetch,

  // M3 implements the extraction consumer. Until then, nothing produces messages.
  async queue(batch: MessageBatch<ReceiptMessage>): Promise<void> {
    for (const msg of batch.messages) msg.retry({ delaySeconds: 60 });
  },
} satisfies ExportedHandler<Bindings, ReceiptMessage>;
