import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Worker serves web/dist (wrangler dev on :8787). There is no Vite dev server:
// the API checks Origin against APP_ORIGIN, so the SPA must be served from the Worker's origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // heic-to (libheif wasm, ~3 MB) is a lazy chunk fetched only when a HEIC file is picked.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 3500 },
});
