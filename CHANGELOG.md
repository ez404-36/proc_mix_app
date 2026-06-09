# Changelog

## v0.5.0

### Added
- **In-app auto-updater** — the application checks for updates on startup and
  notifies the user when a new version is available. Supports automatic
  download and installation for Windows (NSIS) and Linux (AppImage).
- **Update dialog** — modal window showing the available version, release notes,
  download progress, and error states. Accessible from the sidebar indicator
  or from Settings.
- **Settings: "Updates" section** — manual "Check for updates" button with
  inline result feedback (up-to-date / error message).
- **Sidebar update indicator** — "Update available" link below the version
  label; opens the update dialog on click.
- **Release signing** — all build artifacts are now signed with a Tauri updater
  keypair. A `latest.json` manifest is attached to each GitHub Release for
  the updater endpoint.
- **`notify-website.yml` workflow** — triggers website cache revalidation when
  a GitHub Release is published.

### Changed
- **`release.yml`** — added `TAURI_SIGNING_PRIVATE_KEY` env vars and
  `includeUpdaterJson: true` to both build jobs (Windows + Linux).
- **CSP** — expanded `connect-src` to allow `github.com` and
  `objects.githubusercontent.com` for updater requests.
- **Capabilities** — added `updater:default` and `process:default` permissions.

### Dependencies
- Added `tauri-plugin-updater` and `tauri-plugin-process` (Rust).
- Added `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` (JS).

## v0.4.0

- Working directory field and prompt in command form.
- Flag builder, flag highlighting in Script editor, and help parser improvements.
