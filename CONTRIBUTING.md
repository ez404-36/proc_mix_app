# Contributing to ProcMix

Thanks for your interest in improving ProcMix! This guide covers the local
development workflow.

ProcMix is a Tauri 2 app: a **Rust** backend in `src-tauri/` and a **React +
TypeScript** frontend in `src/`. Run frontend commands from the repository
root and Rust commands from `src-tauri/`.

## Getting started

```bash
npm install            # install dependencies
npm run tauri:dev      # run the full app in development
```

## npm scripts

Run all of these from the repository root.

| Script | Runs | When to use |
| --- | --- | --- |
| `npm run tauri:dev` | `tauri dev` with the dev config | **Day-to-day development.** Launches the full app (Rust + webview) with hot reload. Uses [`src-tauri/tauri.conf.dev.json`](src-tauri/tauri.conf.dev.json), which gives the dev build its own app identifier — so it keeps a **separate data folder** and installs alongside a release build instead of clobbering it. |
| `npm run tauri <cmd>` | `tauri <cmd>` | Generic [Tauri CLI](https://tauri.app/reference/cli/) passthrough — whatever you append is forwarded. Use it for `npm run tauri build` (release bundles), `npm run tauri icon`, etc. Note `npm run tauri dev` also works but uses the **release** app identifier (shares data with an installed release), so prefer `tauri:dev` for development. |
| `npm run dev` | `vite` | Frontend-only Vite dev server (no Rust/webview). Handy for pure UI work, but Tauri APIs (`invoke`) are unavailable. |
| `npm run build` | `tsc && vite build` | Type-check and build the frontend bundle. Part of the Tauri build; rarely run on its own. |
| `npm run preview` | `vite preview` | Serve the built frontend bundle locally to inspect a production build. |
| `npm run lint` | `eslint .` | Lint the codebase. Run before every PR. |
| `npm run lint:fix` | `eslint . --fix` | Lint and auto-fix what ESLint can. |
| `npm test` | `vitest run` | Run the test suite once (CI mode). Run before every PR. |
| `npm run test:watch` | `vitest` | Run tests in watch mode while developing. |
| `npm run test:coverage` | `vitest run --coverage` | Run tests with a V8 coverage report. |
| `npm run bench` | `vitest bench --run` | Run the frontend performance benchmarks (see [Benchmarks](#benchmarks)). |

There is no script for a type-check on its own — use `npx tsc --noEmit`.

Backend commands run from `src-tauri/`:

```bash
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

Before opening a PR, run the type-check + lint + tests for whichever layer you
touched (and `cargo clippy` for Rust changes).

## Benchmarks

Performance baselines exist for the two hottest paths — the output **extractor**
(`core::extractor`) and the sandboxed **JS parser** (`core::js_parser`) on the
Rust side, and the schema-editor **type-inference** helpers on the frontend.
They are **dev-only** and never linked into the shipped binary.

### Rust (criterion) — from `src-tauri/`

```bash
# Run all benchmarks (extractor + JS parser)
cargo bench

# Run just our suite (skips the empty lib/main bench targets)
cargo bench --bench extraction

# Faster, slightly noisier run for a quick check
cargo bench --bench extraction -- --warm-up-time 1 --measurement-time 3

# Run only a subset — the trailing arg is a regex over benchmark IDs
cargo bench --bench extraction -- js_parser
cargo bench --bench extraction -- 'extract/parsers/table'

# Compile the bench without running it
cargo bench --no-run
```

The benchmark source is [`src-tauri/benches/extraction.rs`](src-tauri/benches/extraction.rs).
It covers every single-step parser (`raw` / `lines` / `json` / `regex` /
`keyValue` / `table`, plus the `table` + `max_columns` variant), a
`lines → table` pipeline, and `run_js` (string transform, array reduce at
10/100/1000 elements, object map).

**How the baseline works.** The first `cargo bench` run records a baseline
under `target/criterion/`; later runs compare against it and print a
`change: [...] (improved/regressed/no change)` line. To pin a named baseline:

```bash
cargo bench --bench extraction -- --save-baseline main   # save
cargo bench --bench extraction -- --baseline main        # compare later
```

Output reads as `extract/parsers/regex  time: [519 µs 520 µs 522 µs]` — the
middle value is the estimate, the outer two are the 95% confidence interval.

### Frontend (Vitest) — from the repository root

```bash
# Run all benchmarks
npm run bench
# (equivalently: npx vitest bench --run)

# Run a single bench file
npx vitest bench --run src/utils/jsParserTemplate.bench.ts
```

Bench files are named `*.bench.ts` (e.g.
[`src/utils/jsParserTemplate.bench.ts`](src/utils/jsParserTemplate.bench.ts))
and are excluded from the normal `npm test` run. The output table reports `hz`
(operations per second — higher is better), `mean` (ms), and `rme` (relative
margin of error). Vitest prints a `Benchmarking is an experimental feature`
notice — that is expected, not an error.

### Getting trustworthy numbers

- **Compare on the same machine.** Absolute timings vary by hardware; only the
  relative profile and run-to-run deltas are meaningful. Never compare numbers
  across machines.
- **Quiet the box.** Close heavy apps, plug in laptop power, and aim for an
  `rme` (Vitest) / tight confidence interval (criterion) below ~2%.
- **First Rust run is slow.** It compiles in release mode and pulls in
  `criterion` + `boa_engine`; subsequent runs are cached.
