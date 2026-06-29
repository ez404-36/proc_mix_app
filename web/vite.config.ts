/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The web UI is a SEPARATE Vite/React build from the desktop app (app/src). It
// talks to the built-in HTTP API server over fetch + Bearer and is served by the
// Rust axum server (see core::http_server, step B5). It must NOT import the
// Tauri-coupled `app/src/services` — only shared, framework-agnostic modules
// (types, the global stylesheet, i18n locales) via the `@app` alias.
//
// `base: "./"` makes the built asset URLs RELATIVE so the bundle works when the
// server mounts it at `/` regardless of host. Output goes to `app/web/dist`,
// which the Rust build embeds (rust-embed) at compile time.
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      // Shared, transport-agnostic code reused from the desktop app: the global
      // stylesheet (`@app/styles/theme.css`), shared TS types, and i18n locales.
      "@app": fileURLToPath(new URL("../src", import.meta.url)),
      // The web app's own source.
      "@web": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
  server: {
    port: 1430,
    strictPort: true,
    // During local development the SPA runs on :1430 and the real ProcMix HTTP
    // API runs on its configured port (default 48610). Proxy `/api` so the
    // browser's fetch hits a running server without CORS. Override the target
    // with PROCMIX_API_TARGET when the server uses a non-default port.
    proxy: {
      "/api": {
        target: process.env.PROCMIX_API_TARGET || "http://127.0.0.1:48610",
        changeOrigin: true,
      },
    },
  },
});
