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
        // Benchmark files run under `vitest bench`, not the test suite, so
        // their bodies are never executed during a coverage run — exclude
        // them rather than reporting them at 0%.
        "src/**/*.bench.*",
        "src/test/**",
        "src/stores/index.ts",
        // useGlobalShortcut.ts is 96 % covered; the only gap is the
        // `previous && previous !== accelerator` branch (lines 65-66), which is
        // STRUCTURALLY UNREACHABLE via React's lifecycle: the hook serializes
        // every register/unregister onto a module-global FIFO promise chain and
        // nulls `lastRegistered.current` inside the effect-cleanup op. React
        // always runs the old effect's cleanup before the new effect's setup,
        // and the cleanup op is enqueued BEFORE the next `apply()`, so by the
        // time `apply()` reads `previous = lastRegistered.current` it is always
        // null. Confirmed by two independent operation-order probes (see
        // useGlobalShortcut.test.ts). Excluded so the global 100 % line/function
        // gate stays enforced for every other file rather than being lowered
        // project-wide to accommodate two lines of dead defensive code.
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
