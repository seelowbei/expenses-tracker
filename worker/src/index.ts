import { Hono } from "hono";
import { devRoutes } from "./dev/routes";
import type { Bindings } from "./env";

export const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/dev", devRoutes);

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
