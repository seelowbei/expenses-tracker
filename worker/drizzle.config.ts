// drizzle-kit only generates SQL here; Wrangler applies it (`wrangler d1 migrations apply`).
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
