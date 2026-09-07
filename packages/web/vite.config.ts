import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Dev server proxies API + MCP to a running bai server (default loopback :9640).
// The built dist/ is served by @bai/api with SPA fallback in production.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      // The locally-bundled Monaco editor (index chunk + ts worker) exceeds
      // the 2 MiB default — precache it anyway so the PWA works offline.
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
      manifest: {
        name: "bai",
        short_name: "bai",
        description: "One runtime, every surface, every modality.",
        theme_color: "#0b0e14",
        background_color: "#0b0e14",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
    }),
  ],
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
