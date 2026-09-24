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
      // Precache the PWA icon set (SVG + raster) for offline install/home screen.
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"],
      // The locally-bundled Monaco editor (index chunk + ts worker) exceeds
      // the 2 MiB default — precache it anyway so the PWA works offline.
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        // Never serve the cached app shell for backend routes. Without this,
        // Workbox's NavigationRoute handles EVERY browser navigation — so
        // opening /api/help would boot the SPA and fall back to chat.
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/mcp(?:\/|$)/,
          /^\/v1(?:\/|$)/,
          /^\/wb(?:\/|$)/,
        ],
      },
      manifest: {
        name: "bai",
        short_name: "bai",
        description: "One runtime, every surface, every modality.",
        // Match index.html's theme-color + the default [data-theme=dark] --bg.
        // (icon.svg paints its rounded rect #0b0e14 — the ayu-dark surface —
        // only as a pre-boot fallback; the install splash uses these tokens.)
        theme_color: "#09090b",
        background_color: "#09090b",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
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
