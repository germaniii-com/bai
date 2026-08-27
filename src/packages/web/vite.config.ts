import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies API + MCP to a running bai server (default loopback :9640).
// The built dist/ is served by @bai/api with SPA fallback in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BAI_DEV_URL ?? "http://127.0.0.1:9640",
        changeOrigin: true,
      },
      "/mcp": {
        target: process.env.BAI_DEV_URL ?? "http://127.0.0.1:9640",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
