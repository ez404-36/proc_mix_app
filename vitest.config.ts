import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // jsdom startup and module transform can take tens of seconds on a
    // loaded / slow CI machine (observed environment setup > 60s). The
    // default 10s test/hook timeout then trips an unrelated `afterEach`
    // (fake-timer cleanup) with "Hook timed out in 10000ms" even though
    // the assertions themselves pass. Raise both ceilings so a slow host
    // does not produce spurious timeout failures.
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
        "src/test/**",
        "src/stores/index.ts",
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
