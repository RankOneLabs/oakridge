import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev workflow: `bun run dev` (Hono on :8765) and
// `bun run dev:pwa` (Vite on :5173) in two terminals. Vite proxies
// /api/* to the Hono backend; SSE works through the proxy.
//
// Prod workflow: `bun run build:pwa` then `bun run start` — Hono
// serves the built bundle from pwa/dist directly.
const backendTarget = `http://localhost:${process.env.LBC_DASHBOARD_PORT ?? "8765"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
