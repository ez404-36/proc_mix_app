import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
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
