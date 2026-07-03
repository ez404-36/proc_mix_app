import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    // Two HTML entry points ship in the bundle:
    //   - `index.html`  → the main ProcMix window (sidebar, views, …).
    //   - `prompt.html` → the small "quick-launch" prompt dialog window
    //     (v0.12.0). It is a SEPARATE webview opened on demand by the tray /
    //     shell quick-launch when a favorite command needs variable / admin
    //     input, so the main window never has to be shown. It mounts only the
    //     prompt modals, not the full App.
    // Tauri's `frontendDist` points at `../dist`, so both emitted HTML files
    // are packaged and addressable as `index.html` / `prompt.html`.
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        prompt: resolve(__dirname, "prompt.html"),
      },
      output: {
        // Split the heavy vendor libraries into their own chunks so they are
        // emitted (and browser-cached) independently of the app code. The
        // visual editor (@xyflow/react) and the date picker are lazy-loaded
        // (React.lazy in App/WorkflowView/HistoryFilterBar), so isolating them
        // here keeps them out of the startup bundle entirely.
        //
        // A function form is used (not the object map) so the shared React
        // RUNTIME gets its own chunk reliably. With the object map, the string
        // ids `"react"`/`"react-dom"` produced an EMPTY chunk (the automatic
        // JSX runtime is pulled in as `react/jsx-runtime`, which the map did
        // not match), so Rollup hoisted the JSX helper into whichever vendor
        // chunk came first — `reactflow` — and `main` then statically imported
        // that helper from the reactflow chunk, dragging all ~178 kB of
        // @xyflow/react into startup despite the lazy boundaries. Matching
        // React by node_modules path gives the runtime a home of its own so
        // reactflow/datepicker stay truly on-demand.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // React runtime + the shared store shims (zustand and its
          // `use-sync-external-store` polyfill) go in one startup chunk. These
          // are used by every store at startup, so they MUST NOT land in the
          // reactflow chunk — otherwise the startup `contextMenuGuard` chunk
          // statically imports the shim from `reactflow`, dragging all ~178 kB
          // of @xyflow/react into startup despite the lazy boundaries. Listing
          // them before reactflow claims them for the `react` chunk instead.
          if (
            /[\\/]node_modules[\\/](react|react-dom|react\/jsx-runtime|scheduler|zustand|use-sync-external-store)[\\/]/.test(
              id,
            )
          ) {
            return "react";
          }
          if (id.includes("@xyflow/react")) return "reactflow";
          if (id.includes("react-datepicker")) return "datepicker";
          if (id.includes("@arco-design/web-react")) return "arco";
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
