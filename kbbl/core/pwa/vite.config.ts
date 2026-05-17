import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Follow KBBL_PORT so running the server on a non-default port doesn't break
// dev-mode API routing. Matches the env var the gate script reads.
const backendTarget = `http://localhost:${process.env.KBBL_PORT ?? "8788"}`;

// Dev: Vite on :5173 with proxy for server endpoints.
// Build: emits to pwa/dist, Hono serves statically from the same process.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Top-level API routes used by the session list + inbox + CRUD.
      "/sessions": { target: backendTarget, changeOrigin: true },
      "/inbox": { target: backendTarget, changeOrigin: true },
      "/config": { target: backendTarget, changeOrigin: true },
      // Safir proxy + artifact SSE stream.
      "/safir": { target: backendTarget, changeOrigin: true },
      "/artifact-stream": { target: backendTarget, changeOrigin: true },
      "/webhooks": { target: backendTarget, changeOrigin: true },
      // Task-tracker CRUD (plans, cohorts, briefs) + review primitive.
      "/plans": { target: backendTarget, changeOrigin: true },
      "/briefs": { target: backendTarget, changeOrigin: true },
      "/cohorts": { target: backendTarget, changeOrigin: true },
      "/cohort-dependencies": { target: backendTarget, changeOrigin: true },
      "/threads": { target: backendTarget, changeOrigin: true },
      "/atoms": { target: backendTarget, changeOrigin: true },
      "/review": { target: backendTarget, changeOrigin: true },
      // Per-sid routes. Keyed by regex so any sid prefix gets proxied.
      // Must start with ^ for vite to treat the key as a RegExp.
      "^/[^/]+/(stream|events|input|approval|yolo)(\\?.*)?$": {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
