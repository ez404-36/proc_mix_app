# `tauri.bundle-askpass.conf.json`

Bundle-time-only config overlay that ships the `procmix-askpass` SSH helper as a
bundled resource.

- Applied via `--config` **only** when bundling (`npm run tauri:build:unix`), **not**
  auto-merged like `tauri.<platform>.conf.json`. If it were auto-merged, `tauri-build`
  would validate the resource path on every `cargo build` / `cargo test` and fail,
  because the release helper isn't built yet at that point.
- The npm script builds the release helper first (`build:askpass:release`).
- The helper is Unix-only, so this overlay is used only for Linux/macOS bundles.

> Keep this file as **strict JSON** — do not add `_comment`/`$comment` or any property
> outside the Tauri config schema. `tauri-action` validates the overlay and rejects
> unknown properties (`Additional properties are not allowed`). Put explanations here
> in this README instead.
