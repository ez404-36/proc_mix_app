import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Raised from the 10s default: a loaded CI machine can exceed it during
    // jsdom startup alone, producing spurious hook timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // `vitest bench` discovers these separately from the test `include`
    // above (which is overridden, so the default bench glob would not apply).
    benchmark: {
      include: ["src/**/*.bench.{ts,tsx}"],
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: [
        "src/utils/**/*.ts",
        "src/stores/**/*.ts",
        "src/hooks/**/*.ts",
        "src/i18n/index.ts",
      ],
      exclude: [
        "src/**/*.test.*",
        // Benchmark files run under `vitest bench`, not the test suite, so
        // their bodies are never executed during a coverage run — exclude
        // them rather than reporting them at 0%.
        "src/**/*.bench.*",
        "src/test/**",
        "src/stores/index.ts",
        // The `previous && previous !== accelerator` branch (lines 65-66) is
        // structurally unreachable via React's effect lifecycle — see
        // useGlobalShortcut.test.ts. Excluded to keep the 100% gate for
        // every other file.
        "src/hooks/useGlobalShortcut.ts",
      ],
      // Defensive SSR guards (`typeof document === "undefined"`,
      // `typeof window === "undefined"`) cannot be hit inside jsdom, so a
      // handful of statements/branches stay uncovered. Everything else is
      // 100 %.
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 96,
        branches: 87,
      },
    },
  },
});
