# Changelog

All notable changes to ProcMix are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-06-29

**The web UI gets a proper phone treatment.** The browser web interface is
polished for mobile: the login token field gets a show/hide eye and renders
correctly on iOS, the layout no longer clips in landscape, a burger collapses
the sidebar when the phone is sideways, the console opens from the top in
portrait, tap artifacts are gone, and the soft keyboard no longer leaves a blank
strip after login.

### Added

- **Show/hide toggle on the login token field.** An eye button reveals or masks
  the API token while typing (reusing the desktop `EyeIcon` / `EyeOffIcon`),
  mirroring the desktop password-prompt pattern.
- **Collapsible sidebar in landscape (burger).** On a phone held sideways the
  left sidebar can be collapsed/expanded via a floating burger that sits just to
  the right of the sidebar when open and slides to the screen edge when
  collapsed, freeing width for content.

### Changed

- **Console opens from the top in portrait.** On phones the console now docks to
  the top of the screen and grows downward (resize handle on its bottom edge),
  instead of sliding up from the bottom. Its toggle stays in the top bar.
- **Pinch / double-tap zoom disabled on phones** via the viewport meta, so the
  web UI behaves like a native app (no accidental zoom on inputs or gestures).

### Fixed

- **Login token dots were white-on-white on mobile.** The field now pins
  `-webkit-text-fill-color` to the theme text colour so the masked bullets are
  visible (and the base `.input` chrome is applied).
- **Content clipped in landscape.** The shell height now tracks the dynamic /
  visual viewport (`100dvh` → `--app-vh`) instead of the layout viewport, so the
  sidebar and main content no longer get cut off at the bottom.
- **Dark patch lingering after a tap.** On touch devices the synthetic `:hover`
  background no longer sticks behind buttons (gated behind `@media (hover: none)`,
  with the browser tap-highlight made transparent).
- **Blank strip left by the keyboard after login.** On iOS Safari (notably with
  "Save password" + Face ID) the leftover keyboard/accessory strip is reclaimed
  by binding the shell height to `window.visualViewport.height`.
- **Touch separation for the logout button** in the mobile top bar — a vertical
  divider and spacing keep a fat-finger tap from hitting logout by accident.

---

**Settings get a home and ProcMix learns to start with your computer.** The
Settings view is now split into four tabs (Appearance / System / Security &
data / About) instead of one long scroll, and gains an **Autostart** option to
launch ProcMix at system login (optionally minimized to the tray). The Tray
section adds a **"close to tray"** toggle so closing the window can quit the app
instead of hiding it. The Appearance tab is tidied up: the redundant section
heading is gone and the theme switcher now has a **"Theme:"** label, matching
the language switcher.

### Added

- **Settings tabs.** The Settings view is organized into four tabs — **Appearance**
  (theme + language), **System** (tray + autostart), **Security & data**
  (administrator password + export/import), and **About** (updates + version).
  Reuses the existing underline-tab pattern (`library-tabs`); the active tab's
  sections are the only ones in the DOM.
- **Autostart at login.** A new **Settings → System → Autostart** section lets
  you launch ProcMix automatically when you sign in, with an optional **"start
  minimized to tray"** mode (the app opens in the tray without a window). Backed
  by `tauri-plugin-autostart` (Windows registry / macOS LaunchAgent / Linux
  `~/.config/autostart`); the OS registration is the source of truth for
  enabled/disabled, and ProcMix stores only the `start_minimized` flag in a new
  single-row `autostart_config` table.
- **"Close to tray" toggle.** The Tray section adds a switch controlling what
  happens when you close the main window: hide to the tray (default, historical
  behaviour) or quit ProcMix. Persisted in a new single-row
  `window_behavior_config` table and cached at runtime for the
  `CloseRequested` handler.

### Changed

- **Appearance tab cleanup.** Removed the duplicate "Appearance" section heading
  above the theme switcher and gave the theme switcher a **"Theme:"** inline
  label, so it is symmetric with the **"Language:"** switcher.
- **Shortcuts section removed.** The "Shortcuts" block was removed from Settings
  (along with its now-unused i18n keys and the `ShortcutsSection` /
  `ShortcutRow` components). The global toggle shortcut continues to work; only
  the in-Settings editor UI is gone.

---

**The HTTP API server can now serve a read-only web UI.** Beyond the REST API,
the built-in server can optionally serve a browser-based, reduced ProcMix over
the same port. LAN users open it, sign in with the access token, and get
**Home** and **Library** (view + run) plus a view-only **History**, a manual
console, and a theme switch — responsive down to phone screens. The desktop HTTP
API panel is polished alongside it.

### Added

- **Web UI for the HTTP API server.** A separate Vite/React SPA (`app/web/`),
  embedded into the binary via `rust-embed` and served by the same axum server
  on routes outside the Bearer guard (but still behind the DNS-rebinding Host
  check). Gated by a new **"Enable the web interface"** (`serveWebUi`) toggle —
  on by default for fresh installs, off for upgrades. The UI is **view + run
  only** (Home / Library) and **view only** (History); only `api_enabled`
  entities are ever shown. The browser language mirrors the desktop app's
  language at server-start time.
- **New read endpoints** backing the web UI, all `api_enabled`-gated:
  `GET /api/command|workflow/{ref}` (full detail), `GET /api/history`
  (paginated, run-only, filtered to API-enabled entities),
  `GET /api/run/{executionId}` (run status + captured output, re-checks
  `api_enabled`), plus the unauthenticated `GET /api/bootstrap` (language
  snapshot) and `GET /api/whoami` (lightweight login token check). The
  command/workflow list summaries are enriched (kind, favorite, lastRunAt,
  description) so Home/Library render without an N+1 fetch.
- **Browsable address list + web-UI toggle in the desktop panel.** The HTTP API
  panel shows the `http://…/` addresses to open in a browser — loopback always,
  plus `procmix.local` and the LAN IP when detected (now shown even while the
  server is stopped) — and the `serveWebUi` toggle with an inline help tooltip.

### Changed

- **HTTP API panel polish.** The Settings block is a bordered fieldset (matching
  the schedule form), **locked while the server is running** (with a
  "(stop the server to change)" note in the legend) so settings can't trigger
  on-the-fly restarts; the port is a labelled read-only input with a pencil to
  edit; the addresses share one "Access addresses" section with aligned Copy
  buttons; and the close button is a red-filled ×.

### Fixed

- **HTTP API panel no longer closes unexpectedly.** It now closes only via the
  explicit × button — previously a drag-select of text that ended on the
  backdrop (e.g. selecting the port value) was mistaken for a backdrop click and
  dismissed the modal.

## [0.10.5] - 2026-06-29

**Three quality-of-life fixes around running things and seeing where they ran:**
the console now shows the **working directory** a command runs in, a manual
"Run now" of a **workflow** schedule finally opens the console and saves its
output to History (and is labelled "Manual run"), and the Environment **"By
file"** view lists every variable a scanned file assigns — even ones the GUI
process never inherited. All changes are backward-compatible and require no
migration; legacy History rows and event payloads stay byte-identical.

### Added

- **Console shows the working directory.** The `Started` execution event now
  carries the effective working directory the child was launched in — the
  command's resolved `workingDir`, or the user's home directory when none is set
  — and the OutputPanel renders it next to the shell in the script header
  (`(bash) /path/to/dir`). Workflow step headers show the same per-node shell +
  directory line. The field is `None` for a remote (SSH) run, where the local
  cwd does not apply, and is omitted from the wire in that case so legacy
  payloads stay byte-identical.
- **"Manual run" label in History.** A schedule fired via "Run now" now records
  as **"Manual run of …"** instead of **"Scheduled run of …"**, distinguishing it
  from automatic cron / catch-up fires. Backed by a new `manual` flag on the
  `scheduledRun` history payload (stored only in `payload_json`, no migration);
  it is omitted from the wire when `false`, so automatic fires and pre-upgrade
  rows decode identically.

### Fixed

- **Manual "Run now" of a workflow schedule produced no console and no saved
  output.** Three related bugs in one path: the console panel never opened, no
  pinnable run marker was created, and the History row had empty output
  ("Вывод не сохранён"). The manual workflow path used the fire-and-return
  streaming runner (which streams but never captures) while only the blocking
  path captured; and the frontend workflow bridge assumed every run was
  pre-registered by the UI before invoking, so a backend-initiated (scheduler)
  run no-opped every event. The manual fire now drives the workflow to
  completion via `execute_workflow_blocking` with `silent = false`, so it BOTH
  streams to the live console AND captures the aggregate log for History; and the
  bridge lazily bootstraps the in-memory run/execution for an unknown (backend)
  run id, opening the panel and creating the marker without inserting a duplicate
  history row (the Rust `scheduledRun` event remains the single source of truth).
- **Environment "By file" view under-counted variables.** The per-file grouping
  was driven by `live env × sources`, so a variable assigned in e.g. `~/.bashrc`
  but absent from the GUI process's environment never appeared under its file,
  and the per-file count disagreed with "Scanned source files". The view now
  groups by each file's full assignment scan (`EnvFileStatus.keys`): every key a
  readable file assigns is listed under it, with the runtime value shown when
  present and a muted "not set in the current environment" placeholder otherwise.
  A final "source unknown" bucket holds live env vars no scanned file mentions;
  the filter applies within each file group.

## [0.10.4] - 2026-06-26

**A new Plugins section with a full plugin delivery framework (manifest →
discovery → catalog → install/update/rollback/remove), plus a critical executor
fix that could kill the whole desktop session on cancel.** This release lands the
foundation of the plugin system: a new top-level **Plugins** view lists installed
plugins (name, version, author, source, status, declared permissions, and a
summary of what each contributes), and a versioned **catalog** lets a user install
a chosen version, update to a newer one, or roll back to an older one — all as the
single "install version" operation, with removal — without ever executing plugin
code. Nothing here runs plugin logic yet: the catalog reads from a local source
(`PROCMIX_PLUGIN_CATALOG`, defaulting to `.mocks/plugins` in dev); a network
GitHub-backed source is reserved (`CatalogLocation::Remote`) and intentionally
deferred. The release also fixes a serious Unix bug where cancelling or timing out
a run — or app shutdown — could signal ProcMix's own login/session process group
and tear down the entire desktop, hardens local SFTP recursive-delete safety, and
fixes a "HotKey already registered" race on the global shortcut under React 19.
All changes are backward-compatible and require no migration.

### Added

- **Plugins section (Phase 1).** A new top-level **Plugins** view (added to the
  navigation after Environment) lists installed plugins with name, version,
  author, source, lifecycle status (`enabled` / `disabled` / `incompatible` /
  `osIncompatible` / `error`), the declared `permissions`, and a summary of what
  the plugin contributes (parsers, presets, event handlers, node kinds, bundled
  commands/workflows). A broken plugin surfaces with an error instead of silently
  vanishing. Enable / disable / remove are wired end to end. New backend module
  `plugins::{manifest,discovery,registry}` mirrors the trait+registry isolation
  model (per-plugin error isolation, `apiVersion` major-compatibility check,
  dedup by id); new frontend `types/plugin.ts`, `services/pluginService.ts`,
  `stores/pluginStore.ts`, and `components/Plugins/`.
- **Plugin delivery framework (Phase 2).** A versioned **catalog** of installable
  plugins (`<name>/v<semver>/`), with semver-aware "latest" selection
  (`plugins::semver`), a catalog source abstraction (`plugins::catalog`,
  `LocalCatalogSource`), and an atomic installer (`plugins::install`) that writes a
  chosen version into the per-user installed directory (`<app-data>/plugins/`),
  replacing whatever was there. Install / update / rollback are one operation
  (`install_plugin_version`); per-user disabled state persists in
  `storage::plugin_state` (new `schema.sql` table). New Tauri commands
  `list_plugins`, `set_plugin_enabled`, `remove_plugin`, `list_plugin_catalog`,
  `install_plugin_version`.
- **`.env` support for local dev.** `dotenvy` loads `app/.env` (gitignored) on
  startup so overrides like `PROCMIX_PLUGIN_CATALOG` take effect; `.env.example`
  documents the available keys.

### Fixed

- **Cancel/timeout/shutdown could kill the entire desktop session (Unix).** The
  executor inferred process-group isolation solely from `getpgid(child) == pid`,
  which an inherited login/session group also satisfies when `setsid()` fails with
  `EPERM` (e.g. ProcMix launched directly from a display manager). A `killpg`
  against that group — including the elevated `sudo kill -<pgid>` path — could
  signal ProcMix's own session and tear down the whole desktop. The stored pgid is
  now accepted only when **provably isolated** from our own process group and
  session (`resolve_isolated_pgid`), and every group-kill site (cancel, timeout,
  the elevated kill, and the shutdown hook) re-checks `pgid_is_safe_target` before
  signaling. When isolation can't be proven, ProcMix falls back to a single-child
  kill and never to a group kill.
- **"HotKey already registered" race on the global shortcut.** Register/unregister
  of the palette accelerator are now serialized onto a single promise chain, so a
  React 19 mount → unmount → mount burst can no longer overlap an in-flight
  register with the next one.

### Security

- **Local SFTP recursive-delete protection broadened.** Beyond `/`, a drive root,
  and the user's home, recursive delete now also refuses the home's parent (e.g.
  `/home`, `/Users`) and a list of critical top-level system trees
  (`/etc`, `/usr`, `/var`, `/System`, `\Windows`, `\Program Files*`, …), comparing
  against a normalised, separator-collapsed path. Arbitrary user directories
  outside these trees remain deletable.
- **Plugin install copies data only.** Installing, updating, or rolling back a
  plugin downloads/copies a manifest and assets and never executes plugin code;
  `name`/`version` are validated (semver shape, no `/`/`..`) before forming any
  path. Declared `permissions` are surfaced in the UI ahead of any future
  execution phase.

### Notes

- The plugin system stops at lifecycle management: no extension point (content
  packs, presets, output parsers, integrations, custom workflow nodes) executes
  plugin code yet — those are later phases. The catalog's GitHub-backed remote
  source is reserved but not wired; a `Remote` location returns a clear error
  rather than silently doing nothing.

## [0.10.3] - 2026-06-25

**Remote execution over SSH, an SFTP file manager, a built-in HTTP API server,
Windows stabilization, and a large hardening/refactor pass.** This release
consolidates the entire 0.10.x line. Commands can now run on a remote host from
`~/.ssh/config` (one-shot or saved per-host password, kept in the OS keychain
and never crossing IPC); a dual-pane SFTP browser copies files between local and
remote; and an optional HTTP API server runs saved commands and workflows over
REST through the same headless path the scheduler uses, so API-triggered runs
land in History. On Windows, every child process ProcMix spawns now runs without
flashing a black console window, and cancel/timeout is hardened. The release also
tightens several security boundaries (SFTP path safety, HTTP Host-header
validation, a JS-parser wall-clock cap, base64 secret redaction), fixes garbled
non-UTF-8 child output on localized Windows, and ships a large
behavior-preserving refactor plus structured `tracing` diagnostics. A global UX
change makes **Escape never close a modal** (close via an explicit button or
backdrop click). All changes are backward-compatible: existing commands,
workflows, and schedules run unchanged and need no migration; Unix runtime
behavior is byte-for-byte unchanged.

### Added

- **Remote execution target.** A command's execution target can be **local**,
  **remote** (a chosen `~/.ssh/config` host), or **prompt for host at run time**
  (`ExecutionTarget`), surfaced as a target badge in History. Remote runs spawn
  the system `ssh` with a fixed argv (never a shell); the host alias is
  allow-list validated (`is_safe_alias`).
- **SSH password authentication.** Two sources are supported: a **one-shot**
  password (transient keychain entry consumed by the `procmix-askpass` sidecar)
  and a **saved per-host** password in the OS keychain
  (`security::ssh_password`, keyed `ssh-password:<alias>`). The password value
  never crosses the IPC boundary — callers may only set, clear, or query
  existence. Inline Set / Change / Clear controls plus a "saved" indicator live
  in the command form's `TargetSelector` and the SSH connection editor. Hidden
  on Windows, where the askpass transport is unreliable on Win32-OpenSSH.
- **Dual-pane SFTP file manager.** Opened from **Environment → Connections**, a
  two-pane browser (local ↔ remote) supports navigation (click / breadcrumb /
  editable path field with folder autocomplete / show-hidden toggle), creating
  folders, renaming, and deleting. Files are copied between panes by
  drag-and-drop or copy/paste — always a copy (source kept) with a green **Copy**
  badge. A header status bar logs each transfer with a color-coded, expandable
  history, and a failed transfer surfaces the real `sftp` error instead of a
  silent 0-byte file.
- **Built-in HTTP API server.** An optional axum server runs saved commands and
  workflows over HTTP (`POST /api/command/{ref}/run`,
  `POST /api/workflow/{ref}/run`) through the same headless path the scheduler
  uses, so runs are recorded and finalised in the backend and land in History
  (`source=api`). It has a start / stop / restart lifecycle with autostart,
  **Bearer-token** auth (keychain-only token, constant-time compare, per-IP 401
  rate limit), and a per-entity opt-in (`apiEnabled` + `apiSlug`).
- **API discovery and request log.** The server advertises itself on the LAN via
  mDNS (`procmix.local`) and reports its LAN IP in status. A request log (ring
  buffer + live event + rotating file) records redacted request/response
  summaries and can be cleared.
- **HTTP server header panel.** A two-column panel (controls + a read-only log)
  with an iOS-style run switch and address block. Commands and workflows gain
  `apiEnabled` / `apiSlug` editor fields, import resolves slug conflicts, and the
  view modals show an `IdBadge`. Fully localized (en/ru).

### Changed

- **Escape no longer closes any modal.** Modals close only via an explicit close
  button or a backdrop click; the SFTP manager additionally does **not** close on
  a backdrop click. Non-modal popovers still dismiss on Escape.
- **Command form tabs reorganized.** The tab order is now **Main → Environment →
  Script → Output schema**, and the execution settings were regrouped: shell,
  where-to-run, and working directory moved to the **Environment** tab, while
  timeout and run-as-administrator moved to the **Script** tab. The Main tab now
  holds only metadata (name, description, category, tags) and the HTTP API opt-in.
- **iOS-style toggle switches replace checkboxes.** Boolean controls now use the
  shared `ToggleSwitch` instead of native checkboxes across the command form (HTTP
  API opt-in, run-as-administrator, prompt-for-working-directory), the output
  schema editor (enable), the schedule tile (enable), the schedule form's
  **Advanced** section (skip-if-running, capture-output, catch-up, use-timeout,
  retry-on-error, enabled-on-create), and the HTTP server panel (bind-to-LAN,
  log-to-console).
- **Schedule tile toggle no longer shifts position.** The enabled/disabled label
  beside the switch now occupies a fixed-width slot, so toggling a schedule keeps
  the switch in place instead of nudging it as the label text changes width.
- **HTTP API sidebar entry now has an inline run/stop toggle.** The static status
  dot in the left sidebar's HTTP API entry is replaced with a `ToggleSwitch`, so
  the server can be started/stopped without opening the settings panel (the
  toggle stops the click from bubbling to the panel). The entry's label is now
  full-contrast like the other sidebar items, and in the collapsed sidebar the
  icon is centered with the label and toggle hidden.
- **Cancelling an elevated (UAC) run on Windows is now documented.** The visible
  child is the wrapper `powershell`; the real admin-token process is created by
  the Windows AppInfo service and is not its descendant, so a non-admin
  `taskkill` cannot reach it. ProcMix kills the wrapper so the run's status
  converges to **Cancelled**; the already-launched elevated child may run to
  completion. This is a Windows security-model limitation, now spelled out in
  `docs/admin-privileges.md`.
- **Backend deduplication.** `ExecuteRequest` construction is unified behind
  `ExecuteRequest::for_command` + `RunOptions`, history-output mapping moves to
  shared helpers, and database column migrations go through one common helper.
- **Variable-prompt UI consolidated.** A prompt-registry factory plus a shared
  `PromptModal` / `usePromptResolver` replace the previously duplicated prompt
  flows.
- **Shared remote-target + repository helpers.** A shared `TargetBadge`
  component and `repositoryHelpers` null/undefined utilities replace ad-hoc
  copies; `OutputPanel` selectors are grouped via `useShallow`.
- **Large modules split into focused submodules (behavior-preserving).** The
  3220-line `core/workflow.rs` became six submodules
  (`mod`/`events`/`graph`/`eval`/`dataflow`/`runner`); the 1916-line
  `core/scheduler.rs` became five (`mod`/`cron_spec`/`run_loop`/`fire`/
  `secret_migration`); the 1380-line `commands/mod.rs` became nine per-domain
  submodules plus a thin hub (with a shared `to_ipc_err` helper). On the
  frontend, `CommandForm` (2207→1075 lines) was split into hooks plus per-tab
  subcomponents, `Settings.tsx` (533→32 lines) into per-section components, and
  `WorkflowCanvas` into dedicated hooks. No Tauri command was renamed — the IPC
  contract is preserved.
- **Diagnostics moved to structured `tracing`.** ~50 ad-hoc `eprintln!` calls
  across the executor, HTTP server, scheduler, SSH, storage, platform, and
  workflow modules were replaced with level-based `tracing` macros
  (`error!`/`warn!`/`info!`). `tracing` + `tracing-subscriber` were added and a
  subscriber is now installed once in `run()` — without it the macro swap would
  have silently muted all diagnostic output.

### Fixed

- **No console windows on Windows.** Introduced a single cross-platform spawn
  helper (`core::proc_ext::NoConsoleWindow`) that applies the Win32
  `CREATE_NO_WINDOW` (`0x08000000`) creation flag to every spawned
  console-subsystem child, and a no-op everywhere else. Applied to local shell
  runs (`cmd` / `powershell` / `bash`), the UAC wrapper `powershell`, remote
  `ssh`, the `ssh` reachability probe, `sftp`, the `<utility> --help` / `man`
  flag-hint probes, the cancel/timeout `taskkill`, and the startup HWID probes
  (`reg.exe` / `getmac.exe`). The system environment dialog
  (`SystemPropertiesAdvanced.exe`) is intentionally excluded — it is a GUI app
  meant to show a window.
- **Cancel/timeout of a local run on Windows.** `taskkill /F /T` tears down the
  whole process tree (so a shell's grandchildren — `python.exe`, `npm.exe` — do
  not survive), now without flashing its own console window. The child PID is
  read while the child is still alive, closing the PID-reuse window.
- **Non-UTF-8 child output no longer garbles or empties the console.** The
  stdout/stderr readers now read raw bytes up to each newline and decode with
  `String::from_utf8_lossy` (undecodable bytes become U+FFFD) instead of the
  strict UTF-8 line reader, which errored on the first non-UTF-8 byte and
  aborted the **whole** stream — surfacing as *empty* stdout for a perfectly
  successful command. CRLF/LF splitting and the trailing-line-without-newline
  case are byte-for-byte unchanged. Additionally, `powershell` / `pwsh` runs are
  prefixed with a prologue that forces `[Console]::OutputEncoding` to UTF-8, so
  formatted cmdlet output (`Get-Date`, `Get-ChildItem`) reaches the pipe as
  UTF-8 rather than the console OEM code page (e.g. cp866 on a Russian Windows)
  — fixing garbled output like `25 ��� 2026 �.`. Every other shell and the
  remote SSH path are untouched.
- **SFTP password auth no longer produces silent 0-byte uploads.** On the
  password path the transport omits `sftp -b` (which implies `BatchMode` and
  suppressed the `SSH_ASKPASS` prompt), forces password auth so a multi-key host
  cannot exhaust `MaxAuthTries`, feeds the batch via a regular-file stdin, and
  resolves the remote home to an absolute path via `pwd` so navigation and "go
  up" work from the login directory.
- **Backend DRY cleanup.** Unified `ExecuteRequest` construction, shared
  history-output mapping helpers, a shared DB column-migration helper, and a fix
  for an N+1 query in `load_command`.
- **Russian translation cleanup.** "Прервано" → "Отменено"; "рабочие процессы"
  → "сценарии"; exit-code wording unified to "код возврата"; and category
  plurals standardized to the CLDR `_one`/`_few`/`_many`/`_other` forms.
- **Documentation references.** Fixed a broken CHANGELOG reference and corrected
  the documented HTTP-panel location.

### Security

- **Local SFTP path-safety guards.** Local paths are rejected if they contain
  NUL or control characters, and a recursive delete that targets a filesystem
  root, the user's `HOME`, or a Windows drive root is refused outright.
- **HTTP server Host-header validation.** The built-in API server validates the
  request `Host` header, hardening it against DNS-rebinding attacks.
- **JavaScript parser wall-clock timeout.** The sandboxed `parse(data)` step now
  has a 5-second wall-clock ceiling in addition to its instruction budget, so a
  pathological script cannot wedge the extraction pipeline.
- **Base64 secret redaction (defense-in-depth).** Sensitive values are now also
  masked when they appear base64-encoded in output (standard, unpadded, and
  URL-safe variants), reusing the existing base64 dependency.

### Notes

- Remote SSH/SFTP **password** auth remains Unix-only (the `SSH_ASKPASS`
  transport is unreliable on Win32-OpenSSH). On Windows a password-only host
  fails fast with a clear `Permission denied` (key auth + `BatchMode=yes`)
  instead of hanging — and now without a console flash.

## [0.9.0] - 2026-06-22

**SSH connections in the Environment manager.** The Environment view is split
into two tabs — **System variables** (the existing read-only process-environment
inspector) and a new **Connections** tab that discovers, manages, and probes the
SSH hosts defined in `~/.ssh/config`. Single-pattern user blocks with only
modelled directives can be created, edited (incl. renamed), and deleted in place
— ProcMix rewrites the block surgically and never touches `Match`,
multi-pattern, `Include`d, or system blocks (shown "managed manually").
Wildcard/pattern blocks are listed separately as read-only "Rules & templates".
A background watcher polls the config and auto-refreshes the tab when it changes
outside ProcMix, and every add/edit/delete — including external changes — is
recorded in History. Existing commands, workflows, and schedules are unchanged.

### Added

- **Connections tab** — lists every SSH host parsed from `~/.ssh/config` with
  its hostname, user, port, and identity file, plus a reachability **Check**
  and a manual **Refresh**.
- **Create / edit / delete connections** — editable user blocks (single pattern,
  modelled directives only) are written back to `~/.ssh/config` in place; the
  block keeps its position on rename, and its attached leading comment is carried
  with it. Non-editable blocks (`Match`/multi-pattern/`Include`d/system) are
  read-only and marked "managed manually".
- **Rules & templates section** — wildcard/pattern blocks (`Host *`,
  `*.example.com`, …) are shown read-only and separated from real connections,
  with a warning when renaming a pattern (it reassigns the rule's scope).
- **Connection view modal** — shows the parsed fields plus the block's full raw
  text exactly as in the file, surfacing directives ProcMix does not model
  (`ProxyJump`, `SendEnv`, …).
- **History tracking for SSH connections** — add, edit, delete, and discovery of
  hosts are logged, including changes made **outside** ProcMix, with a per-change
  field diff and an undo for ProcMix-owned writes.
- **Multi-provider source registry** — OpenSSH config is fully implemented;
  PuTTY, WSL, and a system-config source are registered as stubs, and each
  source reports its availability/implementation status so the UI can explain
  why it contributed no hosts.

### Changed

- **Environment view restructured into System variables / Connections tabs.**
  The previous root/user environment inspector now lives under **System
  variables**; its subtitle and tab labels were updated accordingly.

## [0.8.1] - 2026-06-20

**Script multi-command flag hints, shared workflow tags, last-saved fix, and
list/palette/tray polish.** The command Script field now highlights and offers
`--help` hints for **every** command in a pipe/`;`/`&&` chain — not just the
leading one. The workflow properties form gains the command form's chip +
autocomplete **Tags** editor backed by a tag base **shared** between commands
and workflows. The workflow editor's **last-saved** indicator now shows the
real time on entering edit mode instead of a dash. Node-palette tooltips wait
a configurable beat before appearing, truncated list tiles show their full name
on hover, the per-card category chip is hidden when grouping by category, and a
**dev build** marks its system-tray menu as "ProcMix (dev)". All changes are
frontend-plus-tray only and backward-compatible — no command, workflow, or
schedule migration is needed.

### Fixed

- **Script field: flag hints for every command in a chain.** Previously only
  the leading utility (before the first `|`/`;`/`&&`/`||`/`&`) was highlighted
  and given `--help`/flag hints; the command after a separator (`grep` in
  `ls | grep foo`) was left undetected. The editor now parses every
  separator-delimited command segment on every executable line
  (`parseUtilityNamesWithRanges`), highlights each utility token independently,
  resolves help per utility (`useUtilitiesHelp`), and matches each command's
  flag tokens against **its own** utility's flag set. The leading-utility
  parse used for auto-escalation (`parseUtilityNameWithRange`) is unchanged, so
  `sudo` elevation semantics are preserved; the Rust help backend already
  validated each name independently, so this is a frontend-only fix.
- **Workflow editor: last-saved time shown on entering edit mode.** Opening an
  existing workflow showed `Last saved: —` until the first in-session save,
  because the draft hydrate hard-reset the indicator to `null`. The editor draft
  now carries the workflow's persisted `updatedAt` (`EditorDraft.lastSavedAt`)
  and seeds the indicator from it on hydrate (and preserves it across the
  Clear/Reset action — clearing the draft is not a save). A brand-new workflow
  still shows the em-dash placeholder.

### Added

- **Workflow properties: rich Tags editor with a shared suggestion base.** The
  scenario properties modal's Tags field now mirrors the command form — removable
  chips plus an inline autocomplete (ArrowUp/Down to cycle, Enter/`,` to commit,
  Backspace to remove the last chip, Escape to clear the draft). Suggestions come
  from a **single tag base shared across commands and workflows**
  (`collectTagsFrom`): a tag used by any command is offered when tagging a
  scenario and vice versa. The same shared base now feeds the command form too.
- **Node palette: tooltips with a configurable show delay.** The workflow
  editor's node-palette tooltips moved from a native `title` (whose appear delay
  is fixed by the OS) to a reusable `HoverTooltip` wrapper with a tunable
  show delay (default 700 ms), so the node-description tooltips wait a beat
  before appearing and don't flicker as the cursor sweeps the button column.
- **List tiles: full name on hover.** Command, workflow, and schedule cards now
  carry a `title` with the full name on their heading, so a name truncated in
  the compact tile layout is revealed on hover.

### Changed

- **Group-by-category hides the redundant per-card category chip.** When the
  Commands list is grouped by category, each card no longer repeats its category
  chip — the group header already names the category (`CommandCard hideCategory`).
- **Dev build marks the system tray as "ProcMix (dev)".** When running a
  development build, every tray menu label and the tray tooltip suffix the
  product name with " (dev)" (e.g. "Выйти из ProcMix" → "Выйти из ProcMix
  (dev)"), so the dev instance's tray icon is distinguishable from an installed
  release. Done locale-agnostically in `buildTrayLabels` (`import.meta.env.DEV`)
  and mirrored in the Rust `default_labels()` under `cfg!(debug_assertions)` for
  the first menu shown before the frontend pushes localized labels.

## [0.8.0] - 2026-06-20

### Added

- **Parallel (fork) and join (barrier) workflow nodes.** A new `parallel` node
  fans the run out to several concurrent branches at once, each carrying its own
  clone of the upstream variables and data flow. Branch exits use the
  `branch:<n>` handle scheme, mirrored on both the editor and the engine.
- **Optional bound join.** A `parallel` node may name a `join` node via
  `joinNodeId`: every branch then runs only up to that barrier, and traversal
  continues past the join exactly once after **all** branches have arrived. With
  no `joinNodeId` each branch runs independently to its own `end`.
- **Fail-fast cancellation.** If any branch errors (or the run is cancelled
  mid-flight), the remaining in-flight branches are cancelled and the run
  reports the failure instead of waiting for stragglers.
- **Fork validation.** The editor rejects a `parallel` node with no branches
  (`parallelNoBranches`, mirroring the engine's `ParallelNoBranches`) and a
  `joinNodeId` that points at a missing or non-`join` node.
- **Variable-source list on command nodes.** Command-bearing nodes (`command`,
  `condition`, `switch`, `try`) now render their explicitly-bound command
  variables as `$name = <source>` rows on the card, mirroring the `data` node.
- **Node palette hints.** The palette shows a "Drag a node onto the canvas or
  click" hint, and each node button's tooltip is now a short description of the
  node's behavior (`editor.nodeDesc.*`).

### Changed

- **Drop-to-connect resolves the nearest free output of any node.** Dragging a
  node from the palette now auto-wires it to the closest unused source handle
  across all nodes and all their ports — `then`/`else`, `case:*`/`default`,
  `ok`/`catch`, `body`/`done`, a fork's next `branch:<n>`, or a linear `out` —
  using measured DOM handle positions so it stays correct as nodes grow.

## [0.7.4] - 2026-06-19

**Performance improvements: regex compile cache, allocation-free extraction
pipeline, and JS timeout classifier fix.** The output-schema extraction backend
gains a process-wide **LRU regex compile cache** (32 slots) that eliminates
recompilation on repeated patterns — the live-preview keystroke path drops from
~470 µs per call to near-zero after the first compile. A new `StepConfig<'a>`
borrowed view removes the full `OutputSchemaRecord` clone each pipeline step
previously allocated per element. The `table` parser now returns rows directly
as `Vec<Value>` instead of building an intermediate map and cloning the record
slice. Named capture-group lookup in the `regex` parser is now O(1) via
`HashSet` instead of O(fields × groups). A bug where a field literally named
`rows` corrupted table output is fixed by separating row storage from column
projection. On the JS side, the Boa timeout classifier now matches exact
runtime-limit messages instead of the bare word `"limit"`, preventing
user-thrown errors such as `"rate limit reached"` from being misclassified as
`Timeout`.

### Changed

- **Regex compile cache (Rust backend).** `parse_regex` now checks a
  process-wide MRU cache before calling `Regex::new`. Regex compilation
  dominated the function's cost (~470 µs of ~525 µs for a typical pattern).
  The same compiled `Arc`-backed program is reused across keystrokes in the
  live-preview editor and across repeated workflow runs. The cache holds up to
  32 entries (LRU eviction); compile errors are never cached.
- **Allocation-free pipeline config.** Each pipeline step previously
  constructed a full `OutputSchemaRecord` clone to pass field lists, patterns,
  and delimiters to the per-parser functions. A new `StepConfig<'a>` struct
  holds borrowed slices of these fields, eliminating the clone for every
  element processed by a map step.
- **`table` parser: zero-copy row return.** `parse_table` now returns
  `Vec<Value>` directly. Previously it built a `BTreeMap` that mixed the row
  array and per-field column projections in one namespace, then the caller
  extracted the rows by key — requiring a `records.clone()` on every call.
  Column projection is now the caller's sole responsibility.
- **O(1) capture-name lookup.** The `regex` parser now collects named groups
  into a `HashSet` once per call, replacing a `capture_names().flatten().any()`
  scan that was O(fields × groups).
- **JS timeout classifier tightened.** `LIMIT_MARKERS` now contains the exact
  Boa runtime-limit substrings rather than the bare word `"limit"`, preventing
  a user script that throws `"rate limit reached"` from being reclassified as a
  `Timeout` error.

### Fixed

- **`table` field named `rows` no longer overwrites the row array.** A
  declared output field whose `.name` was literally `"rows"` used to overwrite
  the `rows` key in `parse_table`'s result map, so the step's caller received
  an empty array instead of the actual rows. The architectural fix (returning
  `Vec<Value>` and moving projection to the caller) eliminates the shared
  namespace by construction.

## [0.7.3] - 2026-06-19

**History multi-select delete, console recents management, and a compact tile
view.** The **History** section gains per-row checkboxes and a **"Delete
selected"** action. The **console recents strip** becomes manageable: a
right-click menu to **rename / pin / unpin / delete** each run, a **"Repeat"**
button that now also re-runs whole **workflows**, pinned runs that survive
"Clear" and app restarts and always stay left, and **drag-and-drop** reordering
of recent runs. Object lists (Commands, Workflows, Schedules) get a third
display mode — a **compact tile** (no description, icon-only Run/View buttons)
— that works alongside category grouping. All changes are frontend-only and
backward-compatible: no command, workflow, or schedule migration is needed.

### Added

- **History: multi-select delete.** Each history row now has a selection
  checkbox; ticking one or more rows reveals a **"Delete selected (N)"** button
  that removes exactly those entries (after a confirmation dialog). The
  selection is scoped to the visible page and resets whenever the page or
  filters change, so a checkbox can never refer to an off-screen row.
- **Console recents context menu.** Right-clicking a recent run in the console
  strip opens a menu with **Rename** (inline edit of the chip's title),
  **Pin / Unpin**, and **Delete** (clears that run's log).
- **Pinned console runs persist.** A pinned run shows a pin glyph, is never
  removed by "Clear" (terminated or all), survives an app restart (only pinned
  runs are persisted to `localStorage`; in-flight runs are never restored), and
  is always kept to the left of unpinned runs.
- **"Repeat" for workflow runs.** The console's re-run button now replays a
  whole scenario (workflow) run, not just single commands — the aggregate
  execution carries its source `workflowId` so it can be re-triggered.
- **Drag-and-drop reordering of console recents.** Recent runs can be dragged
  to reorder them within their pinned/unpinned group; a move that would place
  an unpinned run ahead of a pinned one (or vice versa) is rejected, preserving
  the "pinned stay left" invariant.
- **Compact tile view.** Object lists offer a third display mode alongside
  "Expanded tiles" and "Table": a **compact tile** that drops the description
  and renders icon-only Run/View buttons next to the favorite/enable toggle.
  Available for Commands, Workflows, and Schedules, and compatible with
  category grouping (compact + grouped tiles are valid; only Table disables
  grouping).

### Changed

- The recents strip now appears from the **first** run (previously it only
  showed once a second run existed).
- The schedule card's enable/disable toggle shows a tooltip ("Enable" /
  "Disable") in the compact tile view.

## [0.7.2] - 2026-06-17

**JavaScript output parser, ranged history clearing, and console/UX fixes.**
The output-schema pipeline gains a **`javascript`** parser step: a sandboxed
`parse(data)` function (run in the Rust backend via an embedded JS engine, so it
works for scheduled/headless runs too) that transforms the previous step's value
with arbitrary JavaScript — no access to the filesystem, network, processes, or
ProcMix internals, and bounded in time and code size. The **History** section's
"Clear" action becomes range-aware (last hour, this day, last week, older than N
days, all time), and **scheduled scenario (workflow) runs now capture their
output** so it can be viewed from History like scheduled command runs. The
sidebar shows the **ProcMix logo**, and several console/environment UX issues are
fixed. All changes are backward-compatible: existing commands, workflows, and
schedules need no migration.

### Added

- **JavaScript output parser.** A new `javascript` parser kind in the output
  schema runs a user-written `parse(data)` function over the previous pipeline
  step's value. It executes in the Rust backend through an embedded, isolated JS
  engine (`boa_engine`) — the single source of truth `core::extractor`, so the
  step applies identically for live previews, real runs, and scheduled/headless
  runs. The sandbox exposes ONLY the ECMAScript standard library: no filesystem,
  network, processes, environment, timers, or app internals. Execution is
  bounded (time/instruction budget against infinite loops) and the source size
  is capped; any failure (compile, runtime, timeout, non-serialisable result) is
  a typed extraction error that never leaks the input and never fails the run.
  The editor seeds a `parse(data)` template whose `data` type is inferred from
  the previous step's preview.
- **History: ranged "Clear" options.** The "Clear history" action now offers
  **Last hour**, **Today**, **Last week**, **Older than N days** (with a numeric
  stepper), and **All time**, instead of only wiping everything. Cutoffs are
  computed client-side and the backend deletes by `created_at`
  (`clear_history` gained an optional `before` bound; new `clear_before`
  storage function).
- **ProcMix logo in the sidebar.** The app's brand mark now appears to the left
  of the "ProcMix" wordmark and stays visible as the compact mark when the
  sidebar is collapsed.

### Fixed

- **Scheduled scenario output is now viewable in History.** A workflow run fired
  by the scheduler now captures its aggregate, per-node console log (each step
  prefixed by its command name, sensitive values redacted, byte-capped) and
  persists it on the `scheduledRun` history event, so it can be expanded from
  the History section like a scheduled command run. Previously workflow fires
  recorded only a status with no output. Manual "Run now" continues to stream
  live to the console.
- **Side-docked console restores the layout on close.** Closing the output
  console while it was docked left or right left the main content shifted by the
  console's reserved width; the `<html>` dock markers are now cleared on close so
  the content reclaims its full width immediately.
- **Side-docked console action buttons stack as a column.** When the console is
  docked left or right, the display-mode selector, **Clear**, and **Close**
  controls now stack vertically as a second column instead of crowding a single
  row.
- **Environment view-mode label corrected.** The grouped view's toggle tooltip
  read "По категориям" / "By category" but groups variables by their source
  file; it now reads "По файлам" / "By file".

---

## [0.7.1] - 2026-06-15

**Workflow editor refinements & local commands.** The visual editor gains the
ergonomics expected of a real authoring surface: separate **Save** and **Save &
Exit** actions, a persistent **last-saved** indicator, full **Undo/Redo** history
(one step per node edit, add, delete, or connection), a **command search** field
in both the node command picker and the palette, and an **unsaved-changes**
confirmation when closing. A new **local command** scope lets a command live
inside its owning workflow — hidden from the global Library, travelling with the
workflow on export/import, managed from a dedicated **Local commands** palette
section, and promotable to a global command on demand. The palette also gains a
reusable **Command** node, and the command picker marks local commands inline.
Scenario and command run output is now **persisted and viewable** from the
History section, and the command form's timeout field adopts the standard numeric
stepper. All changes are backward-compatible: existing commands and workflows
need no migration.

### Added

- **Workflow editor: Save & Exit.** The editor now has two distinct save
  actions — **Save** keeps you in the editor after persisting, while **Save &
  Exit** persists and returns to the workflow list. The header shows a persistent
  **last-saved** indicator (`Last saved: <date-time>`, or a dash when the scenario
  has never been saved) so it is always clear whether changes were stored.
- **Workflow editor: Undo/Redo.** The editor tracks an edit history and supports
  undo (Ctrl/Cmd+Z) and redo (Ctrl/Cmd+Shift+Z, Ctrl+Y). One history step
  corresponds to a single complete change — applying or closing a node modal, or
  adding, deleting, or connecting a node. The existing **Clear** action remains
  available separately.
- **Command search in the workflow editor.** The node command picker and the
  editor palette gain a search field that filters commands by the same fields as
  the Library search (`filterCommands`), so the right command is quick to find
  in a large library.
- **Command node in the palette.** The node palette gains a dedicated **Command**
  node that is added with no command pre-selected; the command (global or local)
  is then chosen inside the node from the searchable picker.
- **Local workflow commands.** A command can now be scoped **local** to a single
  workflow instead of **global**. Local commands are hidden from the global
  Library and are usable only inside their owning workflow's editor; they are
  exported and imported together with the workflow. The editor's palette has a
  dedicated **Local commands** section listing only the current workflow's local
  commands plus a **New command** action (enabled once the workflow has been saved
  once); clicking a local command opens the standard command view. A local command
  can be promoted with **Make global** — confirmed by a *"The command will become
  globally available. Continue?"* dialog (Yes / No) and renamed to
  `name (workflow)` if a global command of the same name already exists. Deleting
  a workflow cascade-deletes its local commands (restorable along with the
  workflow). The node command picker marks local commands with a `(local)` suffix
  in the option list.
- **Scenario and command run output in History.** Workflow and command run
  output is now persisted and can be viewed and expanded from the History
  section, mirroring the existing scheduled-run output (aggregate output only).

### Changed

- **Command form: timeout uses the numeric stepper.** The command form's timeout
  field now uses the shared `NumberStepper` control (with a new nullable
  `allowEmpty` mode for an empty/unset value), bringing it in line with the
  app's numeric-input convention instead of a raw number input.
- **Closing the workflow editor warns about unsaved changes.** Closing the editor
  with pending changes now prompts for confirmation before discarding them.

### Fixed

- **Scenario run output could not be viewed.** Workflow (and command) run output
  is now reliably persisted and viewable/expandable from the History section
  instead of being unavailable after the run finished.
- **Command form timeout input was off-convention.** The timeout field no longer
  uses a raw number input; it now matches the rest of the app's numeric controls.

---

## [0.7.0] - 2026-06-14

**Advanced Workflow.** The visual workflow editor graduates from a linear
command chain into a full control-flow orchestrator. New node kinds — **Switch**
(multi-way branching), **Loop** (bounded iteration), **Try** (retry + catch),
and **Data** (variable transformation) — execute in the Rust engine and can be
built, configured, and run from the canvas. **Conditions** can now branch on a
variable value or stdout content (not just exit code), and the **Data** node can
pull a value from its predecessor (raw output, exit code, output-schema fields
or the whole schema result, plus kind-specific sources). The editor gains
drag-and-drop + insert-on-edge for every node kind, selected-node highlighting,
localized canvas controls with a fullscreen mode, and numerous UX refinements.
This release also incorporates all changes from the 0.6.1 milestone: variable
default-value fixes (pre-fill + two-way script sync), Linux keyboard freeze fix,
console dock position selector, re-run with saved variable values, tag
autocomplete in the command form, type accent borders and badges on Home/Library/
Scheduler cards, and favorite workflow display in Home. All changes are
backward-compatible: existing workflows run unchanged and need no storage migration.

### Added

- **Switch node.** Runs its referenced command as a test, then takes the first
  `case` whose predicate matches (in declaration order), or the always-present
  `default` branch. Each case is a `{ subject, op, value }` predicate over the
  test command's exit code, a named output-schema field, or its stdout. Edge
  labels are `case:<id>` / `default`. (`NodeKind::Switch`,
  `select_switch_branch`, `SwitchCaseRecord`.)
- **Loop node.** Repeats a `body` sub-graph a bounded number of times — either a
  fixed `count` or a `while` predicate — then exits via the `done` branch. A
  hard `maxIterations` cap (`WorkflowError::LoopLimit`) guarantees termination on
  top of the global step ceiling. Emits a `loopIteration` event per pass for
  live progress. (`NodeKind::Loop`, `loop_should_continue`, `LoopConfigRecord`.)
- **Try node.** Runs its command with retries: up to `retries` additional
  attempts with an optional `backoffMs` pause, exiting via `ok` on success or
  `catch` once retries are exhausted. The backoff is cancellation-aware. Emits a
  `nodeRetry` event before each attempt. (`NodeKind::Try`, `RetryConfigRecord`,
  `cancellable_backoff`.)
- **Data node — value sources.** A `data` node assignment can now pull its value
  from the previous node instead of only a manual literal. A source selector
  offers, depending on the predecessor's kind: **manual entry**, **raw output**,
  **exit code**, the command's **output schema** (the whole extracted result as
  JSON) and each **individual field**, plus kind-specific sources — **retry
  count** (after a Try), **condition result** (`true`/`false`, after a
  Condition), **matched case** (after a Switch), and **iteration count** (after a
  Loop). When the predecessor is ambiguous (zero/converging edges) the universal
  sources are offered; the runtime always resolves the real previous node.
  (`DataSourceRecord`, `resolve_data_source`, `dataSourceOptions`,
  `findSinglePredecessor`.)
- **Condition predicates.** A `condition` node can carry a `{ subject, op, value
  }` predicate over exit code, a variable, or stdout, with operators `eq` / `ne`
  / `contains` / `regex` / `gt` / `lt`. When set it drives the `then`/`else`
  branch instead of the exit code; when absent the node behaves exactly as
  before (exit 0 → `then`). The condition node card shows да/нет labels and a
  short predicate summary (e.g. `> 80`, `содержит "example"`) next to them.
  (`core/workflow_condition`, `select_condition_branch`, `conditionSummary`.)
- **Drag-and-drop + insert-on-edge for all node kinds.** Every node-kind palette
  button (Switch / Loop / Try / Data / Condition / End) is now draggable onto
  the canvas, and an already-placed but unconnected node can be dragged onto a
  connection to splice it into the chain — with the same "вставить сюда" hint and
  neighbour-shift layout as a palette drop. Inserted branching nodes continue the
  chain on their primary exit (`then` / `default` / `done` / `ok`).
- **Selected-node highlighting.** Clicking a node on the canvas highlights it
  (primary border + glow) so it's clear which node the inspector is editing.
- **Localized canvas controls + fullscreen.** The reactflow controls bar is
  fully Russified (zoom in/out, fit to view, lock/unlock the canvas) and gains a
  **fullscreen** toggle that expands the editor (palette + canvas) to fill the
  window.
- **bounded stdout tail on workflow nodes.** Workflow command nodes now retain a
  size-capped, sensitive-redacted `stdout_tail` (`MAX_STDOUT_TAIL_BYTES`) so the
  engine can evaluate stdout-subject conditions and the Data node's raw-output
  source without buffering unbounded output. Non-workflow runs are unaffected.
- **Three-column node editor modal.** Editing a node now opens a centered modal
  with the node type in the header (✓ apply, 🗑 delete, × close), the node's
  configuration form in the middle, and **example input** / **example result**
  preview columns on either side. The input/result panes fill from the last run
  and can also be edited by hand. Raw and **output-schema** views toggle via a
  console-style tab strip; the input's schema view is derived live from the raw
  text through the authoritative extractor and is read-only, while the raw view
  stays editable even after a run. (`NodeInspector`, `nodePreviewData`,
  `useDerivedExtraction`.)
- **Parser node.** A new non-command node that re-parses the previous node's raw
  output through its own output-schema pipeline (the same `core::extractor` a
  command uses), replacing the data-flow with the extracted fields. Configured
  with the existing output-schema editor; the modal's input column doubles as
  the preview sample. (`NodeKind::Parser`, `apply_parser_node`.)
- **Text node.** A new non-command node that composes a template string,
  expanding `${var}` references to earlier variables, and makes the result its
  output. Right-click offers **Insert variable** (any variable guaranteed to run
  before this node) and **Incoming data** → raw output (`${raw_input}`) / schema
  (`${schema_input}`); references are highlighted in blue like the Script field.
  (`NodeKind::Text`, `apply_text_node`, `TextNodeEditor`.)
- **Run a single node.** The node modal gains a ▶ action that runs that node and
  every node downstream of it, seeding the node's input from its example-input
  column (a prior run's capture, a manual sample, or empty). Downstream nodes
  recompute their previews from the streamed events; upstream nodes are not
  re-run. (`run_workflow_from_node`, `execute_workflow_from`, `TraverseStart`.)
- **Per-node command variable sources.** When a command-bearing node's command
  declares variables, each variable gets a source selector — enter manually,
  prompt at run time, the previous node's output (raw / schema / field / exit
  code / kind-specific specials), or a variable from an upstream **Data** node
  that is guaranteed to run before this node (dominator analysis). The engine
  resolves each binding at run time. (`variableSources`, `resolve_variable_values`,
  `dominatingDataNodeVariableNames`.)
- **Data-node variables are run-wide.** Variables set by a **Data** node now
  persist for the whole run instead of only until the next command node, so any
  later node can read them by name. (`vars` map in the engine traversal.)
- **Console: configurable dock position.** The output panel can now be docked
  to the **bottom** (default), **right**, or **left** side of the window. A
  `Dropdown` selector in the panel's action bar switches between positions.
  The dock position and panel width are stored in `executionStore`
  (`consolePosition`, `panelWidth`, `setPanelWidth`, `setConsolePosition`).
  For left/right docks the resize handle switches to an east-west cursor and
  the `app-shell` receives a compensating padding via a CSS custom property
  (`--console-side-width`) set on `<html>`, so the main content area is never
  obscured by the fixed panel.
- **`Execution.variableValuesRaw` field.** Raw (unmasked) resolved variable
  values are now stored in-memory on each execution. `commandRunner.ts` captures
  the full resolved map at pre-registration time; it is never rendered in the UI
  and is not persisted to the history database.
- **`VariableSpec.promptAtRuntime` field.** A new explicit field on both the
  TypeScript interface and the Rust struct. When `true`, the runner always opens
  the variable-prompt modal before execution even when a `defaultValue` is set
  — the default is pre-filled into the modal as a suggestion the user can accept
  or override on every run. When absent or `false`, the legacy convention
  applies (`defaultValue === undefined` ⇒ implicit prompt). Wire payloads with
  `promptAtRuntime: false` stay identical to pre-0.6.1 records; only the new
  combination (default value **and** prompt) adds the field.
- **Round-trip guarantee for "default + prompt" variables.** A variable row
  with both a `defaultValue` and `promptAtRuntime: true` now survives a
  save/reload cycle with both fields intact.
- **Tag autocomplete suggestions in the command form.** The Tags field now
  shows a filtered suggestion list as the user types. Suggestions are derived
  from tags already used across the library (`collectTags`), filtered by the
  current draft, and exclude tags already added to the command. Keyboard
  navigation: ArrowDown/ArrowUp highlight suggestions, Enter or comma commit the
  highlighted suggestion (or the raw text when none is highlighted), Escape
  clears the draft. Clicking a suggestion with the mouse also commits it.
  Free-text entry (Enter/comma/Backspace) is unchanged.
- **Type accent on Home cards.** Command and workflow cards on the Home screen
  are now visually distinguished: commands get a blue left border
  (`--color-primary`) and a `КОМАНДА` / `COMMAND` pill badge; workflows get a
  green left border (`--app-color-run`) and a `СЦЕНАРИЙ` / `WORKFLOW` badge.
  The badge is localized (EN + RU).
- **Type accent in Library tiles.** The same left-border color coding
  (`list-tile--command` / `list-tile--workflow`) is applied to all cards in the
  Library's Commands and Workflows tabs.
- **Schedule card accent.** Schedule cards in the Scheduler tab receive a yellow
  left border (`--app-color-edit`, `#f59e0b`) via `list-tile--schedule`.

### Changed

- **Editor header & toolbar.** The header title is now dynamic — "Новый
  сценарий" for a new draft, "Редактирование сценария" when editing — and the
  form-level **Save** and **Close** actions live in the header, while
  **Properties** (now a primary/blue button) sits on the canvas toolbar beside
  the scenario name. The "Delete" button was removed from the editor (deletion
  remains available from the Library).
- **Numeric fields use the `NumberStepper` control.** The Loop and Try numeric
  inputs (count, max iterations, retries, backoff) now use the app's standard
  stepper component instead of raw number inputs, per the UI conventions.
- **`run_command_bearing_node` reports its attempt count** so a Try node can
  expose the number of attempts as its retry-count data source.
- **Console stays visible in fullscreen.** Running a scenario while the editor is
  fullscreen now lifts the docked output console above the editor so the run's
  output is visible without leaving fullscreen.
- **Data node card lists its variables.** The Data node on the canvas now shows
  each assignment as `$name = <source>` instead of an assignment count.
- **Data node has no output of its own.** The Data node's result column is a
  read-only `key = value` block of the variables it records (a Data node returns
  nothing — it only stores variables), with values resolved against the node's
  input where possible.
- **Console: "Повторить" and "Отмена" buttons moved into the title row.**
  Both buttons now appear inline with the command name / status / exit-code
  metadata (immediately to the right of the exit code), rather than in the
  separate right-hand action bar. They are styled with a compact
  `.output-panel__inline-action` class that matches the console color scheme.
- **Workflow engine: new control-flow node types (scaffolding).** The workflow
  runner and canvas now support `loop` (bounded repeat + while-guard),
  `switch` (multi-branch on command output), `try` (retry-with-catch), and
  `data` (pure variable assignment without spawning a process) nodes.
  Canvas node components and inspector panels for these types are wired
  in and exercise the executor; full palette/toolbar surface is coming in
  the next release.
- **Workflow condition evaluation (`workflow_condition.rs`).** A pure, fully
  unit-tested condition evaluator drives branch selection in `condition`,
  `switch`, and `loop` nodes. Conditions can compare exit code, a named
  extracted variable, or a bounded `stdout` tail using `eq`, `ne`, `gt`, `lt`,
  `matches` (regex), and `contains` operators. The evaluator never logs a
  runtime value, so `sensitive` variables can appear in conditions without
  leaking through error messages.
- **`NodeOutcome::stdout_tail`.** Workflow-mode executor runs now capture a
  bounded (64 KiB) redacted stdout tail for condition evaluation. Non-workflow
  and pipeline-mode runs are unaffected (no extra buffer is allocated).
- **Workflow card in Library no longer shows node count.** The `shell-badge`
  displaying the node count has been removed from the workflow tile's meta row;
  the card now shows description + tags only, matching the command card layout.
- **`assembleScript` and flag helpers extracted to `flagBuilderUtils.ts`.**
  The utility function and its helpers (`FlagRow`, `ArgRow`, `shortFlag`,
  `longFlag`, `primaryFlag`, `resolveAlias`, `shellQuote`) were moved from
  `FlagBuilder.tsx` into a dedicated `flagBuilderUtils.ts` module. This
  satisfies Vite's Fast Refresh constraint (a component file may only export
  the component and its props type) and makes the helpers directly importable
  for testing without importing the React component.
- **`VariableSpec` Rust struct derives `Default`.** Existing struct literals
  that did not use the spread syntax remain unchanged; `Default` is available
  for future callsites.

### Fixed

- **Ambiguous branch edges are now rejected.** A node with two outgoing edges on
  the same branch (e.g. two `out` edges) previously routed nondeterministically
  by storage order; the engine now fails with a typed `AmbiguousBranch` error
  instead of silently picking one.
- **Editor no longer clips on short windows.** The editor area grows and scrolls
  (rather than being cut off) when the application window is shorter than the
  editor's minimum height.
- **Predicate editor input styling.** The condition predicate's value input used
  a non-conforming class that rendered white-on-white; it now uses the standard
  `.input` styling.
- **Node previews fill after a run.** Per-node input/result examples now populate
  after running a scenario — node output (stdout + structured result) is captured
  per node (`workflowRunStore.nodeOutputs`) instead of being folded into the
  single aggregate console entry.
- **`schemaOutput` offered for fieldless schemas.** The variable / data source
  selector now offers "output schema" whenever the predecessor command declares
  a schema (e.g. `raw` / `keyValue` / `table` parsers), not only when it declares
  named fields.
- **`${raw_input}` composes inline.** The Text node's `${raw_input}` now strips a
  command's trailing newline(s) so the inserted output no longer pushes following
  text onto a new line; leading and internal content is preserved, and the
  byte-exact `rawOutput` data source elsewhere is unchanged.
- **Re-run skips the variable prompt when previous values are available.**
  Clicking "Повторить" on a finished execution now passes
  `active.variableValuesRaw` to `triggerCommandRun` instead of an empty map,
  so all previously entered values (including those that were prompted at
  runtime) are replayed without re-opening the variable prompt modal.
- **Favorite workflows not shown in the Home section.** The "Favorites" section
  on the Home view only listed favorited commands; favorited workflows were
  silently omitted. The `favorites` memo now merges both collections into a
  discriminated-union array and renders `WorkflowRow` for workflow entries,
  mirroring the existing "Recent" section.
- **Variable default value was silently dropped on save.** When a variable had
  `promptAtRuntime: true` and a non-empty `defaultValue`, `rowsToVariableSpecs`
  dropped the default (the old code used `promptAtRuntime` as the sole signal
  to omit the field). The default is now preserved and the pre-fill is passed
  to the prompt modal at run time.
- **`promptAtRuntime` was lost on reload.** The old `specsToVariableRows`
  derived `promptAtRuntime` purely from `defaultValue === undefined`, so a spec
  that had both fields set would reload with `promptAtRuntime: false`. The
  loader now reads the explicit field first and falls back to the legacy
  convention only when the field is absent.
- **Variable default value not synced into the script field.** Inserting a
  variable via the Script tab's context menu now emits `${name:default}` when
  the variable has a default value, instead of always emitting `${name}`.
- **Two-way sync between script field and variable rows.** Typing `${FOO:bar}`
  in the script editor now updates the `FOO` row's default-value input, and
  changing the default in the variable row rewrites all `${FOO}` / `${FOO:old}`
  occurrences in the script.
- **Clearing the default value now sets `promptAtRuntime: true` automatically.**
  Both the variable-row input and the script-sync path enforce the rule:
  empty default ⇒ prompt flag. Typing a non-empty value leaves the flag at
  whatever the user set explicitly.
- **`syncScriptDefaultsToRows` Bug 1: empty inline default skipped the prompt
  correction.** The previous early-return on `inlineDefault === row.defaultValue`
  skipped the `promptAtRuntime` correction when both were already empty — a row
  with `defaultValue: ''` and `promptAtRuntime: false` remained incorrect.
- **Keyboard freeze on Linux (GTK / IBus input queue saturation).** On every
  keystroke in the script editor, `syncScriptDefaultsToRows` allocated a new
  array via `.map()` even when no row changed. This busted the `useMemo` for
  `scriptVariableSpecs` → `ScriptEditor`'s `knownNames` → `segments`
  (heavy tokenisation + highlight overlay repaint) on every keypress. On Linux
  the accumulated event processing saturated the GTK / IBus input queue until
  events were dropped, freezing keyboard input in all inputs. Both sync
  functions now return the original reference when nothing actually changed.

---

## [0.6.0] - 2026-06-12

Linux Process Capture and a process-tree–scoped Recorder. The "command
recorder" now works on Linux (via the kernel netlink proc connector,
`cn_proc`), and on every platform you can scope a recording to one or more
chosen apps — capturing only the command lines that app and its child
processes launch, instead of the whole-system firehose. Capture is filtered by
the process tree (not an image-name blacklist), shell-pipeline noise is
collapsed, and ProcMix's own subtree is always excluded for privacy. No
breaking changes — the capture scope is an optional parameter that defaults to
the previous "all processes" behaviour.

### Added

- **Linux Process Capture (Recorder).** The background command recorder now
  runs on Linux, subscribing to the kernel proc connector (`cn_proc`) over a
  raw netlink socket and reading `/proc/<pid>` for each `exec` to reconstruct
  the command line. The Recorder is no longer Windows-only; the UI shows the
  controls on Windows and Linux.
- **Scoped recording (record a specific app).** A "What to record" selector in
  the Recorder lets you pick one or more running applications; capture is then
  limited to those processes and their descendants (by the PID/PPID tree). The
  default — an empty selection — records all processes as before. Already-running
  child processes of a chosen app are picked up via a `/proc` tree snapshot
  taken when recording starts.
- **Multi-select target picker with chips.** The scope selector is a
  multi-select dropdown: chosen apps appear as removable chips (matching the
  command-form tag style), the process list is searchable, and a loading
  indicator is shown while the list is fetched.
- **`list_capture_targets` command.** Enumerates the processes you can scope
  to (`{ pid, name }`). On Linux the name is resolved from the executable
  (`/proc/<pid>/exe`), then argv[0] (`/proc/<pid>/cmdline`, world-readable for
  other users' processes), then `/proc/<pid>/comm` — so long names aren't
  truncated to the kernel's 15-char `comm` limit.
- **`Dropdown`: multi-select + loading.** The shared dropdown gained an
  optional `multiple` mode (toggleable options, removable chips, the popup
  stays open across picks) and a `loading` state with a spinner row, plus an
  `onOpenChange` hook for lazy option loading. Single-select behaviour is
  unchanged.

### Changed

- **Capture noise filtering is now process-tree–based.** The capture filter
  scopes by the process tree first (all / a chosen app's subtree /
  everything-except-a-subtree), then applies the existing self / system-noise /
  browser-helper / dedup rules. Shell wrappers are collapsed: a `sh -c <cmd>`
  invocation is surfaced once and its per-stage pipeline `exec`s (`sed`, `tr`,
  the re-exec'd tool) are suppressed by PPID, so a single piped command no
  longer floods the list with one row per stage.
- **ProcMix's own subtree is always excluded from capture.** Even in
  "all processes" mode, the recorder never records ProcMix or its launcher
  (terminal / IDE / agent) subtree — recording the launcher's commands is a
  privacy leak.
- **Process exits are tracked.** The watcher now consumes process-exit events
  (Windows ProcessEnd opcode 2 / Linux `PROC_EVENT_EXIT`) to prune the scope
  tree, bounding PID-reuse races.
- **Recorder copy clarifies what is captured.** The Recorder header now
  explains that it records launched processes (command lines) — not mouse
  clicks or keystrokes — and carries an "(experimental)" tag.
- **`start_process_capture` takes an optional `scope`.** When omitted it
  defaults to "all processes", preserving the previous behaviour.

### Dependencies

- Added `libc` (Linux-only target dependency) for the netlink proc-connector
  socket. `ferrisetw` is now scoped to the Windows target instead of being
  built on every platform.

---

## [0.5.2] - 2026-06-12

Security hardening: sensitive variable values no longer touch the local
database in plaintext. Scheduled secrets move to the OS keychain, secret
defaults are stripped from stored commands and action history, and a one-time
migration purges any pre-upgrade plaintext (including the freed disk pages).

### Security

- **Scheduled sensitive values stored in the OS keychain.** A scheduled
  command's `sensitive` variable values were previously persisted as plaintext
  in the `schedules.variable_values` SQLite column. They now live in the OS
  keychain (keyed per schedule + variable); the database keeps only a non-secret
  reference sentinel. The value is resolved from the keychain at fire time,
  cleared when the schedule is deleted, and never displayed in the UI.
- **Sensitive variable defaults are no longer written to disk.** A variable
  marked `sensitive` no longer persists its default value into the `commands`
  table — the spec (name, description, the `sensitive` flag) is kept, but a
  baked-in secret default is dropped at the storage boundary.
- **Action-history snapshots are scrubbed of sensitive defaults.** Old
  `command*` history events that embedded a `sensitive` variable's default value
  in their snapshot are rewritten to remove it.
- **One-time migration of existing data.** On first launch after upgrading, any
  pre-existing plaintext secret (scheduled values + history snapshots) is moved
  to the keychain / stripped, and the database file is `VACUUM`-ed so the old
  plaintext bytes are physically reclaimed (not just marked free). The migration
  is idempotent and best-effort (a keychain failure is logged, never fatal).

### Changed

- **Schedule form masks sensitive variables.** Sensitive scheduled variables now
  render as masked inputs with a "secret stored — leave blank to keep" hint;
  leaving the field blank preserves the existing keychain secret, and a new
  value replaces it. A hint notes the value is stored in the OS keychain rather
  than the app database.
- **Command form warns about redaction limits.** Marking a variable `sensitive`
  now shows a hint that output redaction masks only verbatim occurrences — a
  command that transforms the secret before printing it may still leak it.

---

## [0.5.1] - 2026-06-11

Windows executor and recorder hardening: full command-line capture via ETW,
correct default shell, child-process tree teardown on cancel/timeout, and a
`parser` default fix for pipeline commands.

### Fixed

- **Windows: full command lines captured in the Recorder (Process Capture).**
  Capture was switched from the snapshot provider to the kernel ETW process
  provider, so arguments are now included alongside the executable path. Device
  paths (`\Device\HarddiskVolumeN\…`) are resolved to normal Win32 paths
  (`C:\…`).
- **Windows: Recorder filters out Chromium/Electron child processes.**
  Renderer, GPU-process, and utility worker processes spawned by Chromium-based
  apps — including ProcMix's own WebView2 host — are now suppressed and never
  appear in the capture list.
- **Windows: Recorder shows a clear error when started without admin rights.**
  The ETW kernel provider requires elevation; instead of a cryptic OS error the
  UI now surfaces a human-readable message explaining that administrator
  privileges are required.
- **Windows: default shell changed from `pwsh` to `powershell`.**
  `pwsh` (PowerShell Core) is not installed by default on Windows; the executor
  now falls back to `powershell` (Windows PowerShell, always available) so
  commands run out of the box without requiring a manual shell override.
- **Windows: cancel / timeout kills the full child-process tree.**
  On cancel or timeout the executor now calls `taskkill /F /T` to terminate the
  entire process tree, preventing orphaned child processes (e.g. `python`,
  `npm`, `node`) from continuing to run after the parent is killed.
- **`output_schema.parser` defaults to `"raw"` when omitted.**
  Commands whose `output_schema` omits the `parser` field (common in pipeline
  mode) previously failed to deserialize or loaded incorrectly. The field now
  defaults to `"raw"`, making pipeline-mode schemas round-trip correctly.

### Changed

- **Windows seed templates use `powershell`.** All built-in Windows command
  templates that previously referenced `pwsh` are updated to use `powershell`.

---

## [0.5.0] - 2026-06-09

In-app auto-updater with signed releases: the application checks for updates on
startup and lets the user download and install new versions without leaving the
app.

### Added

- **In-app auto-updater.** The application checks for updates on startup (5 s
  delay) and notifies the user when a new version is available. Supports
  automatic download and installation for Windows (NSIS) and Linux (AppImage).
- **Update dialog.** Modal window showing the available version, release notes,
  download progress bar, and error states. Accessible from the sidebar indicator
  or from Settings.
- **Settings: "Updates" section.** Manual "Check for updates" button with inline
  result feedback (up-to-date confirmation or error message).
- **Sidebar update indicator.** "Update available" / "Доступно обновление" link
  below the version label; opens the update dialog on click.
- **Release signing.** All build artifacts are now signed with a Tauri updater
  keypair. A `latest.json` manifest is attached to each GitHub Release for the
  updater endpoint.
- **`notify-website.yml` workflow.** Triggers website cache revalidation when a
  GitHub Release is published, so the download page picks up new assets within
  seconds.

### Changed

- **`release.yml`** — added `TAURI_SIGNING_PRIVATE_KEY` env vars and
  `includeUpdaterJson: true` to both build jobs (Windows + Linux).
- **CSP** — expanded `connect-src` to allow `github.com` and
  `objects.githubusercontent.com` for updater requests.
- **Capabilities** — added `updater:default` and `process:default` permissions.

### Dependencies

- Added `tauri-plugin-updater` and `tauri-plugin-process` (Rust).
- Added `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` (JS).

---

## [0.4.1] - 2026-06-09

Per-command working directory and variable default-value improvements in the
command form.

### Added

- **Working directory field.** A new "Working directory" text input in the
  Script tab (between the script editor and the Variables section) lets users
  pin a specific directory for a command. Leaving it empty falls back to the
  default behaviour (home directory). The value is stored as `Command.workingDir`
  and forwarded to the Rust executor on every run.
- **"Prompt for working directory at runtime" flag.** A checkbox below the
  working-directory input mirrors the variable `promptAtRuntime` semantics: when
  checked, the runner opens a `WorkingDirPrompt` modal before each run,
  pre-filling the stored path. The user can edit or confirm it; leaving it empty
  reverts to the home directory. Cancelling aborts the run — same contract as the
  variable and admin-password prompts.
- **`WorkingDirPrompt` modal** (`src/components/WorkingDirPrompt/`). Singleton
  modal mounted at the App root, opened imperatively via `promptForWorkingDir()`
  from `commandRunner.ts`. Follows the same StrictMode-safe handler-registration
  pattern as `VariablePrompt` and `AdminPasswordPrompt`.
- **`workingDirPrompt.ts` utility** (`src/utils/`). Imperative singleton for the
  working-directory prompt handler, mirroring `variablePrompt.ts`.

### Changed

- **Variable `defaultValue` input always visible.** The default-value field in
  the Variables section of the Script tab is now shown regardless of the
  "Prompt at runtime" checkbox state. Previously it was hidden when the checkbox
  was checked, making it impossible to set a suggestion value that is shown
  pre-filled in the prompt.
- **Working-directory input width** in the command form set to 336 px (twice the
  previous collapsed width of 168 px caused by an unstyled wrapper div).

---

## [0.4.0] - 2026-06-09

Flag builder and script-editor flag highlighting: the Script tab of the command
form can now parse a utility's `--help` output into a structured flag picker,
and every recognized (or unrecognized) flag token typed directly in the script
field is colored green/red with a hover tooltip showing the full description.

### Added

- **Flag builder ("Составить команду").** A new collapsible section appears in
  the Script tab when the leading utility is recognized. Clicking **"Собрать из
  флагов → (experimental)"** calls `parse_utility_flags` and renders:
  - **Positional arguments** — named fields pre-populated from the current
    script when the parser extracted them; a free-text fallback field for
    utilities whose help text doesn't declare explicit positional args.
  - **Flags list** — each added flag row shows its resolved alias, a
    `HelpTooltip` with the full description, an optional value input (for
    flags that take a value), and a **"краткий вариант"** checkbox to switch
    between short (`-v`) and long (`--verbose`) form.
  - **Flag dropdown with search** — a searchable `Dropdown` lists all parsed
    flags with their full description as a subtitle. Typing in the search
    field filters by flag name and description in real time.
  - Every change immediately assembles the command and writes it back into
    the Script field (live write-through, no separate Apply step).
  - Combined short flags (`-czf`) are emitted as a single grouped token when
    all are boolean and in short form.
  - When the leading utility changes while the builder is open, flags that no
    longer exist in the new utility's set are dropped; matching flags are
    retained with their current values.
  - Closing the builder (×) keeps `ParsedCli` in memory so flag highlighting
    in the editor continues to work without re-fetching.

- **Flag token highlighting in the Script editor.** Once a utility's flags
  are fetched (proactively as soon as `--help` resolves, without requiring the
  builder to be opened), every flag token in the script overlay is colored:
  - **Green** (`--app-color-run`) — token matched a known alias.
  - **Red** (`--color-danger`) — token starts with `-` but doesn't match any
    known flag (unknown/typo).
  - Combined short flags (`-hP`) are split into per-character spans so each
    character gets its own color and tooltip independently.
  - Hovering a recognized flag token shows a popover with the flag's aliases
    (monospace amber) and full description text. Only one popover (utility
    or flag) is shown at a time.

- **`parse_utility_flags` Tauri command** (`src-tauri/src/core/flag_parser.rs`).
  Heuristic parser for `--help` output, producing `ParsedCli`
  (`positionalArgs: ParsedArg[]`, `flags: ParsedFlag[]`). Handles:
  - GNU-style `--flag VALUE` / `-f VALUE` / `--flag=VALUE` / `--flag[=VALUE]`
  - Pipe-separated aliases: `-v|--verbose`
  - Bracket-wrapped options: `[--prefix[=DIR]]`
  - Combined short flags in combined-token context
  - `usage:` / `use:` / `use ` prefixes for positional arg extraction
  - Leading ASCII control characters before `-` (btrfs-select-super style)
  - Generic placeholders (`[OPTION]`, `[OPTIONS]`, `[FLAG]`, `[ARG]`, …)
    filtered out of positional args

- **`Dropdown`: `searchable` prop.** When `searchable={true}`, a sticky search
  input is rendered at the top of the popup. Options are filtered in real time
  against both `label` and `description` (case-insensitive). Focus moves to the
  input automatically when the popup opens; Arrow keys navigate the filtered
  list; Enter commits; Escape closes.

- **`Dropdown`: `description` subtitle.** Each `DropdownOption` may carry an
  optional `description` string rendered as a muted subtitle below the label
  in the popup.

### Changed

- **`parse_utility_flags` called proactively.** As soon as the leading utility
  resolves to `status: "found"`, `ParsedCli` is fetched in the background and
  stored. Flag highlighting in the script editor therefore works immediately
  without the user needing to open the flag builder. The builder reuses the
  already-fetched data — no second IPC call.
- **`LANG=C` / `LC_ALL=C` set on all `--help` and `man` probes** so GNU
  utilities always return English help text regardless of the system locale.
  Previously, on non-English systems, `usage:` detection and flag parsing
  produced empty results.
- **`[OPTION]` and similar meta-placeholders excluded from positional args.**
  Usage lines like `cp [OPTION]... SOURCE DEST` no longer produce a spurious
  `OPTION` positional-arg field. A blocklist covers `option`, `options`,
  `flag`, `flags`, `arg`, `args`, `argument`, `arguments`, `param`, `params`,
  `parameter`, `parameters`, `switch`, `switches`.
- **"(experimental)" label** moved to a separate `<span>` rendered *before*
  the "Собрать из флагов →" button, colored amber (`--app-color-edit`).

### Fixed

- **`[OPTION]` appearing as a positional arg in the flag builder for `cp`.**
  Generic option-placeholder tokens in usage lines are now filtered by
  `is_option_metaword`.
- **Flag highlighting disappearing after closing the builder.** `onDismiss` was
  calling `setFlagBuilderData(null)`, clearing the data used for the overlay
  highlights. The dismiss handler now only clears the `open` state.
- **Flag highlighting not working until the builder was opened.** `parsedFlags`
  was only set from `flagBuilderData`, which required opening the builder.
  `ParsedCli` is now fetched proactively when the utility resolves to `found`.
- **`-h` not highlighted in `df -h`.** The `useEffect` tracking the utility
  name included `flagBuilderOpen` in its dep array, causing the effect to re-run
  (and skip the fetch due to a stale `prevUtilityNameRef`) when builder state
  changed. `flagBuilderOpen` is now tracked via a ref and excluded from deps.
- **Tooltip missing for second flag in combined groups (`df -hP`).** Combined
  short-flag tokens were emitted as a single `FlagHighlight` for the whole
  token. Each character is now its own span with its own `ParsedFlag`, so
  `-h` and `-P` get independent tooltips.
- **Free-text "Аргументы" field appearing for `df` even though `FILE` was
  already shown as a named arg.** The free-text fallback is now hidden when the
  parser already extracted named positional args, avoiding double display.
- **Flag builder locale hardcoded to Russian.** All builder strings
  (`positionalArgsSection`, `positionalArgsPlaceholder`, `dismissBuilder`,
  `useShortFlag`, `flagSearchPlaceholder`) were using `defaultValue` fallbacks
  in Russian. Keys are now added to both `en` and `ru` locale files.

---

## [0.3.4] - 2026-06-08

Per-command environment variable overrides are now fully wired end-to-end: live
runs from the command form use the form's env rows, the override hint changed
from a floating icon to an inline warning text with a colored key border, and
the output panel (both embedded and global console) shows an **Environment**
block listing the active overrides alongside the script and variables.

### Added

- **Env overrides applied on live-run.** The command form's "Environment" tab rows (`CUDA_HOME=kek`, etc.) are now forwarded to the Rust executor on every live-run (embedded panel and global console). Previously the rows were persisted to the saved command but ignored during form test-runs; the child process now inherits the declared overrides.
- **Env block in the embedded live-run panel.** `LiveRunOutput` accepts a new optional `envVars` prop and renders a compact `KEY=value` strip at the top of the expanded output body (amber key color, muted `=`, normal text value, separated from the log lines by a border) when at least one override is active.
- **"Environment" block in the global output panel.** `OutputPanel` renders a new `<dl>` section (same structure as the existing Variables block, amber key color via `.output-panel__env-key`) when the active execution carries `env` overrides. `Execution.env` is populated at pre-registration time in `commandRunner.ts` from `cmd.env`.
- **`Execution.env` field.** Added `env?: Record<string, string>` to the `Execution` interface so the output panel can display the overrides that were active for a given run.

### Changed

- **Override warning: icon → inline text.** The `⚠` badge that appeared on env rows shadowing a system variable is replaced by a `<p className="command-form__env-override-hint">` text line rendered below the key/value inputs, colored with `--app-color-edit` (amber). The text reads "Overrides system variable. Current value: …".
- **Override warning: key field border.** The key `<input>` for a row that shadows a system variable now also receives `input--warning` (amber border + focus ring matching `input--error`'s structure), making the conflict visible even when the hint text is off-screen.
- **`envRowsToRecord` moved to `src/utils/commandFormState.ts`.** The function was local to `CommandForm/formState.ts`; it is now in the shared utils layer so `useCommandLiveRun` can import it without a hook→component dependency. `formState.ts` re-exports the symbol for backward compatibility.
- **`startExecution` store action** now accepts an optional `env` argument (position 7, after `variables`). The implementation follows the same idempotent `existing.env ?? env` merge pattern used for `variables` so out-of-order started events never clobber a pre-registered env map.

### Fixed

- **Live-run hung at "running…" after env changes.** Adding `form.envRows` (an unstable array reference) to the `handleRun` `useCallback` dep array caused the callback to be recreated on every render. Under certain re-render sequences this disrupted the in-flight event subscription. Fixed by mirroring `form.envRows` into a stable `envRowsRef` (same pattern as `runStatusRef`) and reading `envRowsRef.current` inside the callbacks without listing the array in deps.

---

## [0.3.3] - 2026-06-07

UI/UX overhaul: consistent button styles, deletion guards, workflow editor navigation, History view improvements, and a themed date-picker.

### Added

- **Deletion guard** — attempting to delete a command or workflow that is referenced by other objects (workflows, schedules) now shows a `BlockedDeleteDialog` listing all dependents instead of proceeding silently (`src/components/BlockedDeleteDialog/`, `src/utils/usageCheck.ts`).
- **Trash icon in view modals** — `CommandView`, `WorkflowView`, and `ScheduleView` each gain a `btn--danger` icon button in the top-right corner of their header; clicking it triggers the deletion flow directly from the modal.
- **History: "Errors" filter chip** — a new `failedOnly` filter surfaces only run events that finished with an error (`status = 'failed'` for command/workflow runs, `status = 'error'` for scheduled runs). Backed by a new SQL clause in `src-tauri/src/storage/history.rs`.
- **History: grouped kind chips** — the 11 individual kind checkboxes are consolidated into 6 semantic groups (Created, Edited, Deleted, Run, Restored, Reverted), eliminating the three duplicate "Run" and two duplicate "Created"/"Edited" chips.
- **Date picker** — native `<input type="date">` in the History filter bar replaced with `react-datepicker` themed to the design system (CSS-variable tokens, dark-mode aware). Russian locale registered: Cyrillic month names, week starts on Monday. Date constraints: both fields cap at today; "From" is capped by the "To" value when set; "To" is floored by the "From" value when set.
- **Workflow editor: post-save navigation** — clicking "Save" (or confirming the name in the Properties modal on first save) now navigates back to the Workflows library tab.
- **Scheduler: Basic plan** — Basic-tier users can now create one schedule (removed the PRO-only gate that showed an upgrade notice instead of the management UI).
- **Scheduler: header** — the Scheduler section now has a `view-title` / `view-subtitle` header matching the Library section.

### Changed

- **Library: create buttons promoted** — "+ Command" / "+ Workflow" buttons moved from inside the filter toolbar to a `library-tabs-row` flex container at the same level as the tab strip. Button labels restored (were icon-only).
- **Scheduler: "+ Schedule" button promoted** — moved from inside the search toolbar to a `scheduler-hint-row` alongside the "runs while app is open" hint. Label restored.
- **Scheduler form: "Save" button** — now uses `SaveIcon` + `t("common.save")` matching the CommandForm convention; the "Delete" button removed (deletion goes through the view modal).
- **Workflow editor toolbar buttons** now follow the UI canon: Run = outlined green (`command-form__action--run` + `RunIcon`), Cancel/Clear = outlined red (`command-form__action--cancel` + `CancelIcon`), Save = filled blue (`btn--primary` + `SaveIcon`). Button order: Run → Cancel → Save.
- **Workflow Properties modal** — button renamed "Свойства…" → "Свойства"; modal width halved (480 px); footer buttons changed to Cancel (outlined red) + Apply (filled green + `CheckIcon`).
- **Node inspector** — title changed from the node kind label ("Команда") to the generic "Узел"; "Delete node" button now includes `TrashIcon` and shorter label "Удалить"; new "Apply" button (`btn--run` + `CheckIcon`) added to the right of Delete.
- **History: date always rightmost** — timestamp moved to the trailing position in `.history-row__meta` so action buttons (Undo, Restore) always appear to its left.
- **History: command event labels** — all six command event strings now explicitly name the entity: "Создана команда «…»" instead of "Создана «…»", matching the workflow event style.
- **History filter bar alignment** — `align-items: center` → `align-items: flex-end` so the search input bottom-aligns with the date-picker fields.
- **Schedule view** — "Close" button added to the footer action row.
- **i18n** — `editor.cancel` ("Отменить" → "Отмена"), `editor.details` ("Свойства…" → "Свойства"), `editor.clear` kept; new keys: `common.apply`, `editor.inspector.title`, `deleteBlocked.*`, `history.filterFailedOnly`, `library.newCommandLabel`, `workflow.newLabel`, `scheduler.newLabel`; scheduler subtitle de-cron-ified; custom cron preset renamed "Пользовательское cron-выражение".

### Fixed

- **`ConfirmDialog` shown after confirm** — view modals (`CommandView`, `WorkflowView`, `ScheduleView`) were wrapping `onDelete` in their own internal `ConfirmDialog`, so confirming deletion would show the caller's blocked-delete or confirm dialog *after* already confirming once. The internal dialogs are removed; the trash button now calls `onDelete` directly.

## [0.3.2] - 2026-06-07

Infrastructure-only release. No behavior, IPC, or public-type changes.

### Fixed

- **ESLint: unnecessary escape characters** in `OutputSchemaEditor.test.tsx` —
  regex literal `/\"alice\"/` corrected to `/"alice"/`.
- **ESLint: unused import** in `CommandForm/formState.ts` — redundant local
  `import { rowsToVariableSpecs }` removed; the symbol is already re-exported
  directly from its source module on the same line.
- **Vitest forks crash under Node 24** — `jsdom@29` pulls in
  `webidl-conversions@8`, which accesses `SharedArrayBuffer.prototype.growable`
  at module-load time inside jsdom virtual environments; this throws in vitest
  fork workers on Node 24. Downgraded `jsdom` to `^26.1.0` (`webidl-conversions@7`,
  no `SharedArrayBuffer` dependency). All 840 tests pass on both Node 20 and
  Node 24.

### Changed

- **Node.js upgraded to 24 LTS** across the project:
  - Added `.nvmrc` pinned to `24`.
  - `release.yml` — all three `Setup Node` steps (check, build-windows,
    build-linux) updated from `'22'` to `'24'`.
  - `windows-build.yml` — `Setup Node` step updated from `'22'` to `'24'`.
- **`website/` excluded from ESLint** — added `'website'` to the `ignores`
  array in `eslint.config.js` so website lint errors never block app CI.
- **Version numbers synchronized** — `Cargo.toml` (`0.3.0`) and
  `tauri.conf.json` (`0.2.4`) brought in line with `package.json` (`0.3.1` →
  `0.3.2`).

---

## [0.3.1] - 2026-06-06

Internal refactoring release that resolves all 17 dependency-cruiser errors
flagged in `docs/plans/dependency-cruiser-violations-fix-plan.md`. **No behavior,
IPC, or public-type changes** — every existing test stays green.

### Changed

- **`utils/runCommand.ts` → `services/commandRunner.ts`** — `triggerCommandRun`
  and `resolveVariableValues` are not pure utilities: they orchestrate store reads,
  IPC calls, and side-effectful flows. Moved to `src/services/` where
  store dependencies are architecturally permitted. All callers updated;
  old test file relocated to `services/commandRunner.test.ts` with updated mock
  paths.
- **`utils/triggerWorkflowRun.ts` → `services/workflowRunner.ts`** — same
  rationale: workflow-run orchestration belongs in `services/`, not `utils/`.
  Old test file relocated to `services/workflowRunner.test.ts`.
- **`FormState`, `RunResult`, `RunStatus`, `VariableRow` extracted to
  `src/types/commandForm.ts`** — these shared types were embedded in
  `components/CommandForm/formState.ts`, causing `hooks/useCommandLiveRun.ts` and
  `hooks/useAdminEscalation.ts` to import from `components/`, violating the
  `hooks-not-from-components` rule. Types now live in `src/types/`.
- **`CANCEL_GRACE_MS`, `CANCEL_FALLBACK_MS`, `INITIAL_RUN_RESULT`,
  `parseTimeoutSeconds`, `rowsToVariableSpecs` extracted to
  `src/utils/commandFormState.ts`** — pure constants and functions extracted
  alongside the type move. `formState.ts` re-exports all symbols for backward
  compatibility of existing component imports.
- **`hooks/useCommandLiveRun.ts` and `hooks/useAdminEscalation.ts`** — updated to
  import from `src/types/commandForm` and `src/utils/commandFormState` directly,
  eliminating the `hooks-not-from-components` violation.
- **`.dependency-cruiser.cjs` config tightened** — `no-orphans` now excludes
  `vite-env.d.ts`, `types/capture.ts`, and `types/commandForm.ts` (referenced
  only via re-exports, so the graph never shows an incoming edge);
  `services-not-from-stores` gains a `pathNot` exception for `*Actions.ts` and
  `*Runner.ts` (and their test files) — these are intentional thin orchestrators
  that call `store.getState()` as a facade over the store's mutation methods.

---

## [0.3.0] - 2026-06-06

Parser pipeline: output schemas now support chaining multiple parsers. A
single-step schema is fully backward-compatible with all existing records —
legacy `parser`/`fields` top-level fields are migrated to a one-step pipeline
on the fly at read time, without any database migration.

### Added

- **Parser pipeline for output schemas.** A command's output schema now consists
  of an ordered list of parser steps (`pipeline: OutputPipelineStep[]`). Each
  step receives the output of the previous step as its input. When a step
  receives an array, it is applied to every element (map semantics), producing
  a flat array of results. This replaces the previous single-parser model which
  is now fully subsumed by a one-step pipeline.
- **`lines → table` pipeline** — the primary motivating use-case: split `ls -lh`
  output into individual lines, then parse each line as a whitespace-delimited
  table row. The result is a flat array of row objects (`[{col0, col4, col8, …}]`).
- **`table` step field projection.** When a `table` step declares fields with
  column locators, each row object is projected to only those declared fields
  before being passed to the next step (or returned as the final value). Without
  declared fields all columns are kept.
- **Column projection from array results via `returnField`.** When the final
  pipeline value is an array of objects, each unique key across all elements is
  collected as an array of its values. Selecting `returnField = "size"` from a
  table-parsed `ls -lh` output returns `["1,1G", "538M", …]`.
- **`ArrowDownIcon`** — new 16×16 SVG icon (`src/components/icons/`) used in
  the pipeline flow visualisation.
- **`useWheelPassthrough` hook** (`src/hooks/`) — forwards wheel events from
  non-scrollable textarea elements to the nearest scrollable ancestor.

### Changed

- **`OutputSchema` type simplified.** The top-level legacy fields (`parser`,
  `pattern`, `delimiter`, `hasHeader`, `fields`) are removed from the TS
  interface. `OutputSchema` now contains only `pipeline`, `returnField`,
  `source`, and `sample`. All existing code that read root-level parser fields
  now reads from `pipeline[0]`.
- **`extract()` (Rust) always runs through `run_pipeline`.** Legacy records
  stored without a `pipeline` array are promoted to a one-step pipeline
  on the fly. The `PipelineTooShort` error variant is removed — a pipeline
  of any length ≥ 1 is valid.
- **Output Schema Editor redesigned as a vertical pipeline flow.** The previous
  two-column layout (config left, preview right) is replaced by a single-column
  flow: sample textarea → connector arrow → parser step card(s) → return value
  node. Moving between single-parser and multi-parser configurations no longer
  requires a mode toggle — adding a second step converts automatically.
- **Sample textarea max height doubled** (from 9 rows to 18 rows) with vertical
  scroll enabled beyond that limit.
- **Sample textarea collapse toggle** added to the section header.
- **Intermediate value display.** Between pipeline steps, the connector now shows
  the actual output of the previous step as a read-only textarea (green border on
  success, red on error), with a label "Промежуточное значение / Intermediate
  value". This lets users inspect data flowing between parsers.
- **"Вывод консоли / Console output" label** added above the arrow to the first
  parser step so the flow origin is explicit.
- **Connector arrows** are now rendered using `ArrowDownIcon` (SVG) and colored
  with `--app-color-run` (green), with increased vertical padding.
- **Return value textarea** min-height doubled; border is green on success, red
  on error.
- **Return value dropdown** no longer lists `rows`, `lines`, or `result` as
  implicit options — the dropdown is now built solely from declared step fields
  and keys present in the preview result (minus the internal `result` sentinel).
- **`run_pipeline` (Rust)** drops the `>= 2` steps requirement; one-step
  pipelines are fully valid.
- **Array field map in `run_pipeline`**: when the final pipeline value is an
  array of objects, per-key projections are built into `fields` so `returnField`
  can select a column by name.

### Fixed

- **`returnField = "size"` / `"path"` no longer errors** with "return field not
  present" when the last pipeline step produces an array of projected row objects.
- **Intermediate value display** showed raw `rows` object from the legacy
  single-parser path; now correctly shows the pipeline step output.

---

## [0.2.4] - 2026-06-05 (3)

### Added

- **dependency-cruiser** added as a dev dependency (`^17.4.3`). Static dependency
  graph analysis tool that enforces architectural layer boundaries at the module
  level.
- **`.dependency-cruiser.cjs`** — project-specific rule set covering: circular
  dependency detection (`error`), layer isolation (`components` must not import
  `stores` directly; `services` / `stores` / `utils` / `types` must not import
  `components`; `hooks` must not import `components`), Tauri IPC boundary
  enforcement (raw `invoke` calls are forbidden outside `src/services/`), and
  orphan-module detection.
- **`docs/plans/dependency-cruiser-violations-fix-plan.md`** — detailed remediation
  plan for the 17 errors and 72 warnings found on the first run: root-cause
  analysis per violation, 5 ordered phases (config false-positives → orphans →
  `formState` extraction → `runCommand`/`triggerWorkflowRun` relocation to
  `services/` → gradual `components-not-from-stores` migration).

---

## [0.2.4] - 2026-06-05 (2)

### Changed

- **Output schema preview: split into separate Fields / Return value sections.**
  The preview pane in the Output tab of the command form previously displayed
  `fields` and `returnValue` as a single combined JSON block. They are now shown
  as two distinct labeled sections so each value is easy to read and copy
  independently.
- **Return value excluded from the Fields section.** When a return field is
  selected, its key is filtered out of the Fields display and appears only in
  the Return value section, eliminating the duplication.
- **Copy button added to Return value section.** A "Copy" button now appears in
  the header of the Return value section, mirroring the one on Fields.
- **Fields and Return value sections are individually collapsible.** Each
  section header now carries a toggle button (▴/▾) so either pane can be
  collapsed independently, reducing visual clutter when only one value is of
  interest.
- **Copy button for Fields moved to the Fields section header.** Previously the
  only Copy button sat in the top-level "Preview" header; it now lives in the
  Fields section header alongside its collapse toggle, consistent with the
  Return value layout.

---

## [0.2.4] - 2026-06-05

History overhaul: the action history reads at a glance with colored icons,
scheduled runs now capture and display their console output, and the schedule
view gains a dedicated run-history tab. **No breaking changes** — every new
DB column and history field is additive (idempotent migrations + back-fill;
optional fields omitted when empty), so existing databases and legacy payloads
stay compatible. New regression tests cover the migrations, the wire format,
and the capture path.

### Added

- **Per-schedule output capture.** A new "Save run output to history" checkbox
  on the schedule form (on by default) controls whether a scheduled command
  run persists its console output, exit code, duration, and — when the command
  declares an output schema — its extracted result, into the run's history
  event. Capture happens entirely in the backend, so it works for background
  (cron) fires, not just manual runs. Commands only in this version; scheduled
  workflow runs still record the minimal event.
- **Schedule view "История" tab.** The schedule card modal is now split into
  **Параметры** (the existing details) and **История** tabs. The History tab
  lists that schedule's runs (newest first, scrollable); each run is a
  click-to-expand row revealing the captured console output and, when present,
  the extracted result.
- **Tabbed Output / Result for captured runs.** When a run captured both
  console output and a structured result, the expanded detail shows them as
  **Вывод** / **Результат** tabs, mirroring the live console's output panel; a
  run with only one shows that pane, and a run with neither shows a muted
  "Вывод не сохранён" note.
- **Captured run output in the global History view.** Scheduled-run rows in the
  main History list are now click-to-expand too, showing the same captured
  output / result via a shared renderer so the two surfaces never diverge.

### Changed

- **History actions are icons, not text.** Each history row now shows a colored
  glyph for its action instead of a localized verb — a blue plus for create, an
  orange pencil for edit, a red trash for delete, a green arrow for run, and an
  undo/restore arrow for restore / undo-edit — with the localized verb kept as
  the accessible label.
- **History action labels normalized.** The remaining textual labels (filter
  dropdown, tooltips) now use a single nominative noun per action — `Создание`,
  `Редактирование`, `Удаление`, `Запуск`, `Восстановление` — removing the
  gender-inflected duplicates; the confusing `Откачена` becomes
  `Отмена редактирования`.
- **Planned (cron) runs no longer stream to the live console.** A scheduled
  fire on its cron schedule runs silently — its output is recorded in history
  rather than appearing in the live output panel — while a manual "Run now"
  still streams as before.

### Fixed

- **Schedule run history showed "not run yet" despite existing runs.** A
  pre-existing database upgraded to the new denormalized `schedule_id` history
  column left old `scheduledRun` rows `NULL`, so the schedule's History tab
  matched none of them. The migration now back-fills `schedule_id` from each
  event's stored payload, and its index is created after the column exists
  (creating it in `schema.sql` panicked at startup on existing databases with
  "no such column: schedule_id").

## [0.2.3] - 2026-06-04

Bug-fix release for command execution: cancellation now reliably stops a run
(including elevated `sudo` trees), scheduled runs behave like manual runs
(elevation auto-detect and variable display), and run history no longer gets
stuck on "running". **No breaking changes** — the only wire change is an
additive, optional `variables` field on the `Started` execution-event, omitted
when empty so legacy payloads stay byte-identical. Every existing test stays
green; new regression tests are added throughout.

### Fixed

- **Cancel now stops the command immediately.** A deliberate user cancel sent
  the same graceful `SIGTERM` → 250 ms grace → `SIGKILL` used for timeouts, so a
  command that traps/ignores `SIGTERM` (or finished its work within the grace)
  ran to completion and only *then* flipped to "Cancelled". User cancel now
  `SIGKILL`s the whole process group at once (`kill_child_tree`'s new
  `immediate` flag); timeouts keep the graceful sequence so the process can
  clean up.
- **Cancel now stops elevated (`sudo`) commands.** The elevated kill re-elevated
  `sudo kill -<pgid>` against the captured *outer* sudo's process group, but
  modern `sudo` runs the command in a new session/process-group, so root-owned
  descendants (`sh`/`find`/`xargs`) survived and reparented to PID 1. The
  elevated path now sweeps the whole descendant tree by pid (walked from
  `/proc` ppid links, readable without root) and re-elevates a single
  `sudo kill <pid…>`, with the captured-group killpg kept as belt-and-braces.
- **Scheduled/workflow runs of `sudo …` commands no longer fail with "a
  terminal is required to read the password".** The UI resolves elevation as
  `runAsAdmin || detectAdminEscalation(script)`, but the Rust scheduler and
  workflow runner used `run_as_admin` alone, so a leading-`sudo` script with the
  flag off ran on the non-elevated (null-stdin, no-TTY) path. Both now mirror
  the UI via a new `core::utility_help::detect_admin_escalation`, routing such
  scripts through the backend's `sudo -S` path (keychain password); an empty
  keychain records a failed run instead of the confusing TTY error.
- **Scheduled runs now show their variable values in the console.** A manual run
  captures resolved variables on the frontend before invoking; a
  backend-initiated run (scheduler/workflow) only learns of the execution via
  the `Started` event, which did not carry them. The `Started` event now
  includes the resolved, **sensitive-masked** (`***`) variables, so scheduled
  and workflow runs display them exactly like a manual run.
- **History no longer leaves completed commands stuck on "Running".** A fast
  command (`ls -la ~`) emitted its `finished` event before the post-invoke
  history insert committed, so the status update found no row and the entry was
  stuck on "running" forever. The run is now registered (store execution +
  history row, client-generated id) *before* invoking, and the in-memory
  history snapshot is patched on completion so a visible row updates without a
  reload.
- **Editing a command and re-running no longer runs the saved script.** The
  OutputPanel "Repeat" (Повторить) re-resolved the command from the persisted
  store, ignoring unsaved edits open in the full-screen editor. It now replays
  the live edited script for the command currently being edited.
- **"Repeat" (Повторить) reuses the current terminal.** Re-running previously
  spawned a separate log entry; it now clears and reuses the current terminal
  slot (a fresh execution id keeps each history row unique).

### Added

- **Selectable import dialog.** Importing a file now opens a selection dialog
  (mirroring the export one) where you pick exactly which commands and
  workflows to bring in. Selecting a workflow force-includes (and locks) the
  commands its nodes reference, so an import is always self-consistent. The
  checkbox tree is shared with the export dialog via a new `SelectionTree`
  component (`SelectionTree` + `SelectionGroup`), with the per-dialog selection
  logic kept in pure, tested helpers (`exportSelection`, `importSelection`).
- **Duplicate detection on import.** A command being imported that collides
  with one already in your library is flagged once its row is checked:
  - same **name** → a "Keep with a new name" / "Skip" choice. Keeping it
    imports a copy under a fresh, unique name ("Deploy" → "Deploy (2)"), so the
    existing command — and any workflow bound to it — is never touched.
  - same **script** but a different name → an informational warning only; the
    command imports as a new copy. Matching is case-insensitive and trimmed.
- **Sorting + table view for the Commands, Workflows, and Schedules lists.** A
  shared toolbar control now lets each list be sorted and displayed two ways,
  with the chosen sort, view mode, page size, and (commands-only) grouping
  persisted per list in `uiStore` across restarts.
  - **Combined sort dropdown** — field and direction are one choice ("Newest
    first", "Name (A-Z)", etc.); the same selection drives both views (column
    headers are not separately sortable). Names sort locale-aware (Cyrillic
    А-Я); dates by `createdAt`; schedules additionally by total runs.
  - **Table view with client-side pagination** (10 / 25 per page) as an
    alternative to the existing tile/card layout. In the table the run action is
    a compact leading icon and the whole row is clickable to open the read-only
    view; pagination is shown only in table mode.
  - **Group commands by category** — an accordion that buckets commands under
    collapsible category headers, with commands lacking a category collected
    under "Uncategorized". Grouping renders as tiles and is mutually exclusive
    with the table/tiles toggle.
  - New pure, tested helpers `sortLists` (`sortCommands` / `sortWorkflows` /
    `sortSchedules`) and `paginate`, plus reusable `ListControls` and
    `Pagination` components.

### Changed

- **Import / Export results show as an inline status plaque** (green on
  success, red on error) in the Settings data section, replacing the previous
  transient toast so the outcome — including how many duplicates were kept
  under a new name and how many commands had "Run as administrator" demoted —
  stays visible until your next action.
- **Importing never overwrites an existing command.** Every imported command
  is created with a fresh id; the only collision resolutions are "keep with a
  new name" or "skip", so a shared file can't clobber a command a workflow
  depends on.
- **The import duplicate-action control uses the app's themed dropdown**
  (`Dropdown`) instead of a native `<select>`, so its popup and selected option
  are readable in both light and dark themes and sized to the compact row.

## [0.2.2] - 2026-06-03

UI consistency / styling-canon release. Centralizes all SVG icons, fixes a
button-icon sizing bug, completes several missing CSS rules left behind by
earlier work, declares previously-undeclared theme tokens, and replaces static
inline styles in Settings with classes. **No behavior, IPC, or public-type
changes** — existing tests stay green. The reusable styling conventions are
captured in [`docs/ui-conventions.md`](docs/ui-conventions.md).

### Fixed

- **Button icons no longer shrink.** Icons inside `.btn` are flex items and
  inherited the default `flex-shrink: 1`, so a long label squeezed the leading
  glyph (e.g. the "Run now" schedule button rendered its 16×16 play icon at
  ~12.8px wide). A global `.btn > svg, .btn > span > svg { flex-shrink: 0 }`
  pins every button glyph to its declared size.
- **Active history/scheduler filter chip border now renders.** The
  `.history-filter-bar__chip--active` rule referenced an undeclared
  `--color-accent` with no fallback, making the rule invalid at
  computed-value time (the border never drew). The token is now declared.
- **Scheduler status badges are now colored.** The
  `.history-row__status--scheduled-*` modifiers (`success`, `error`,
  `cancelled`, `missingVariable`, `skipped`) had no CSS, so scheduler run
  badges fell back to the neutral base. They now carry the status palette.
- **Invalid-input styling now applies.** `.input--error` (used with
  `aria-invalid` on the custom-cron and required-variable fields) had no rule;
  it now gives a danger border and danger focus ring.

### Changed

- **All SVG icons centralized in `src/components/icons/`.** Removed locally
  declared, duplicated glyphs from `CommandView`, `WorkflowView`,
  `AdminPasswordPrompt`, `HelpTooltip`, and the two `StatusIcon` components.
  Added shared `EyeIcon`, `EyeOffIcon`, `InfoIcon`, `SpinnerIcon`,
  `StatusCheckIcon`, and `StatusCrossIcon`; the preview-modal footers now reuse
  the canonical `CancelIcon` / `RunIcon`.
- **Declared previously-undeclared theme tokens** (`--color-accent`,
  `--color-accent-subtle`, `--color-success`, `--color-bg-subtle`,
  `--color-surface-hover`, `--font-mono`) in both light and dark themes and
  removed the inline `var(x, fallback)` defaults that masked their absence.
  Accent / success surfaces now follow the active theme instead of a fixed
  fallback color.
- **Added the missing `.form-hint` field-hint class** (and the
  `.scheduler-runs-hint` layout modifier) so scheduler form hints render with
  the intended muted style.
- **Settings inline styles replaced with classes.** Removed all static inline
  styles from `Settings.tsx` and `LicenseSection.tsx` in favour of a small
  `settings-*` utility family (`settings-info`, `settings-caption`,
  `settings-group` modifiers, `settings-inline-label`, `license-key-input`).

## [0.2.1] - 2026-06-03

Internal refactoring release. Decomposes two God-objects and three smaller
Single-Responsibility-Principle violations into focused modules and hooks, with
**no change to behavior, the IPC contract, or public types** — every existing
test stays green (new tests are added only for extracted pure functions).

### Changed

- **De-duplicated form icons (FE-3).** Removed the inline `TrashIcon`,
  `PlayIcon`, `CancelIcon`, and `SaveIcon` from `CommandForm.tsx`. The form now
  reuses the shared `RunIcon`/`CancelIcon`/`TrashIcon` from
  `src/components/icons/`; the only missing glyph, `SaveIcon`, was added there
  following the existing icon convention.
- **Decomposed `CommandForm.tsx` (FE-1, 2755 → 1481 lines).**
  - Extracted pure form helpers and types (`isShell`, `defaultShellForPlatform`,
    `pickCreateModeShell`, `buildShellOptions`, `computeVariableErrors`,
    `rowsToVariableSpecs`, `specsToVariableRows`, `parseTimeoutSeconds`,
    `makeRowId`, `buildInitialState`, `fingerprintForm`, plus `FormState`,
    `FormTab`, `RunResult`, `RunStatus`) into `CommandForm/formState.ts`, with a
    co-located `formState.test.ts` covering previously-untested functions.
  - Extracted the presentational `LiveRunOutput` and `StatusIcon` sub-components
    into their own files.
  - Extracted the live-run lifecycle (embedded + global-console paths) into a
    `useCommandLiveRun` hook (`src/hooks/`), preserving the critical side-effect
    ordering of `handleRun` (pin ref → mark transient → subscribe → invoke) and
    the admin-password sentinel retry flow.
  - Extracted admin-password escalation into a `useAdminEscalation` hook.
- **Decomposed `WorkflowCanvas.tsx` (FE-2, 773 → 527 lines).**
  - Extracted persistence (`buildDraftWorkflow`, `persist`, `handleSave`,
    `handleRun`, `handleMetaSave`, `activeRunId`) into a
    `useWorkflowCanvasPersistence` hook — `handleRun` keeps reading the live
    draft store so a just-added end-node is included.
  - Extracted palette drag-and-drop into a `useWorkflowCanvasDnD` hook.
- **Moved DB command resolution out of `commands/mod.rs` (BE-2).** Added
  `storage::commands::resolve_map`, which encapsulates `list_all` plus the
  `HashMap` assembly; `execute_workflow` now calls it and is a thin adapter
  again.
- **Decomposed `executor.rs` (BE-1).** Split the ~700-line
  `spawn_execution_with_completion` into a `core/executor/` module tree:
  - `types.rs` — DTOs, events, and constants (`ExecuteRequest` with its manual
    secret-redacting `Debug`, `ExecutorError`, `ExecutionEvent`,
    `TerminalStatus`, `NodeOutcome`, `RunningEntry`, `ExecutorState`), re-exported
    so callers keep their imports.
  - `privilege.rs` — Unix admin-password resolution, preserving the exact
    sentinel error strings the frontend compares by equality.
  - `command_build.rs` — shell invocation and `Command` assembly (elevated
    Unix/Windows/unsupported and non-elevated paths).
  - `streaming.rs` — the stdout/stderr reader tasks, keeping secret redaction and
    the extraction-buffer cap.
  - `waiter.rs` — the `tokio::select!` cancel/timeout/wait task, extraction, and
    terminal-event emission, preserving the `biased` select order and Unix signal
    handling.
  - `mod.rs` — a thin orchestrator (~≤90 lines) plus `cancel_execution`.

## [0.2.0] - 2026-06-03

### Added

- **Scheduler (cron).** A new top-level "Scheduler" view (sidebar) runs saved
  commands and workflows automatically on a cron schedule. The engine is a
  single in-process Tokio loop (using the `cron` crate for parsing only) — fully
  cross-platform, no OS scheduler. Schedules fire only while ProcMix is running
  (including minimized to the tray); occurrences missed while the app was closed
  are skipped by default (the next run is recomputed from now on startup). Cron
  expressions are 5-field Unix syntax, evaluated in **local time** (weekday
  numbering is shifted to the `cron` crate's Quartz convention at the boundary).
  - Structured recurrence editor: every-N-minutes, every-N-hours, daily, weekly
    (multi-day), monthly, or a custom expression; an existing cron is parsed
    back into the matching structured type (else opens as custom).
  - **Catch-up policy** for missed runs: skip (default), run once, or run every
    missed occurrence (capped) — replayed on startup.
  - Optional per-run **timeout override** and **retry-on-error** count for
    command targets.
  - **Manual "Run now"** fires the target out of band (honouring timeout /
    retries / stored variables) without shifting the cron timing or the
    schedule's stats.
  - Variable values are captured at creation (background runs cannot prompt);
    required (no-default) variables block Save and each can carry a help
    tooltip. A command needing a no-default variable with no stored value
    records a `missingVariable` run in History rather than failing silently.
  - Read-only **schedule preview modal** and card actions (Run / View) matching
    the commands & workflows pattern.
  - Every fire is recorded in History as a `scheduledRun` event — the source of
    truth for background runs.
  - PRO-gated with a Basic quota of 1 schedule, enforced at the storage boundary
    (`upsert_schedule`); editing / toggling / firing an existing schedule is
    never gated. Schedules are local to a machine and are **not**
    exported/imported.
  - See [`docs/scheduler.md`](docs/scheduler.md) for the full contract.
- Reusable `NumberStepper` and `HelpTooltip` UI components, shared `PlusIcon` /
  `TrashIcon` / `CheckIcon` icons, and a shared required-field label treatment.

## [0.1.2] - 2026-06-03

UI/UX polish release. Brings the terminal and dialog action buttons in line with
the command-view convention, makes the docked terminal resizable, and fixes a
sidebar shortcut hint.

### Added

- **Resizable global terminal.** The docked output panel can be dragged from its
  top edge to grow or shrink (pointer + keyboard Arrow Up/Down on the handle).
  The height is stored in `executionStore` and clamped to
  `[220px, viewport − 80]`, persisting while the app is open.

### Changed

- **Consistent action-button styling.** The "Provide variables" prompt and the
  terminal toolbar now follow the command-view button convention: a filled run
  action, outlined Cancel/Rerun in their accent hue (icon color matching the
  border), and a neutral-grey Close matching the "View" button on command cards.
  Every action button carries a leading icon.
- **Variable prompt dialog refinements.** Footer buttons are spaced and
  right-aligned with a top divider, and the dialog width is halved (~480px) since
  it is a single-column form.
- **Sidebar shortcut hint.** `Ctrl/Cmd + K` is now described as "command search"
  (matching the panel it opens), and the hint no longer wraps awkwardly under the
  key combo.

### Added (icons)

- New shared `CancelIcon`, `ClearIcon`, and `RerunIcon` SVG components, drawn with
  `currentColor` per the existing icon convention.

## [0.1.1] - 2026-06-03

Security hardening release. Implements the post-audit remediation work; the
per-fix changes and their rationale are summarized in the `[0.1.1]` section
below.

### Security

- **License client now requires HTTPS.** The production default base URL is
  `https://license.procmix.app`; `PROCMIX_LICENSE_URL` is scheme-validated and
  plain `http://` is rejected except for `127.0.0.1`/`localhost` under debug
  builds. Prevents the activation key from travelling in cleartext or being
  redirected to a hostile server. (H1)
- **Admin password redacted from diagnostics.** The one-shot sudo password on the
  executor request can no longer leak through `Debug`/serialized-to-log output;
  the wire value is unchanged. (H2)
- **`sensitive` variable values are honored.** Resolved values of variables marked
  `sensitive` are redacted in streamed `stdout`/`stderr` events and in persisted
  history snapshots, matching the documented contract. (M1)
- **Import treated as untrusted input.** Imported commands no longer arrive
  pre-armed for elevated execution — `runAsAdmin` is forced off on import, and the
  user re-enables it per command after review. (M2)
- **Working directory validated before spawn.** A non-existent `workingDir` now
  fails fast with a typed error instead of an opaque spawn failure; the `$HOME`
  fallback for the absent case is made explicit. (M3)
- **Tightened Content Security Policy.** Dropped `style-src 'unsafe-inline'`;
  added `https://license.procmix.app` to `connect-src` for the HTTPS license
  endpoint. (M4)
- **License-server response is size-bounded.** Responses are read with a hard
  64 KiB cap (declared `Content-Length` rejected up front, then chunk-streamed
  with abort past the cap), preventing an unbounded-body memory-exhaustion DoS
  from a malicious or compromised server. (R1)
- **Lease length is capped before decode.** A lease string over 8 KiB is rejected
  before any base64/JSON work, regardless of source (network, keychain, future
  import). (R2)
- **Clock-rollback marker retained on deactivate.** `deactivate_license` no longer
  clears the signed-clock marker, so a deactivate→reactivate cycle cannot wind the
  local rollback guard backwards. (L2)
- Documented residual-risk decisions: shared all-empty HWID fingerprint (L1) and
  the Windows WebView2 `downloadBootstrapper` install mode (L6).

## [0.1.0] - 2026-05-30

First MVP release. Establishes the Tauri 2.0 + Rust backend and React 18 +
TypeScript 5 frontend, the command engine, the command library, quick-launch
surfaces, the visual workflow editor and runner, and the Basic/PRO/trial
licensing client.

### Added

#### Command engine
- Asynchronous shell command executor streaming `stdout`/`stderr` to the
  frontend over the `execution-event` channel, with cancellation that kills the
  whole process tree (group-wide on Unix).
- Native multi-shell support: `bash`, `zsh`, `sh`, `fish`, `pwsh`, `powershell`,
  `cmd`, with host shell-availability detection.
- Variable substitution: `${name}`, `${name:default}`, and `$$` escapes, resolved
  before spawn, with a `VariablePrompt` flow for variables without defaults.
- Per-command execution timeout, surfaced distinctly from normal exit/cancel in
  history and the output panel.
- Output schemas: declarative extraction of `stdout` into named fields
  (`raw`, `lines`, `json`, `regex`, `keyValue`, `table`) with a live preview
  editor and return values usable as workflow data-flow.

#### Command library
- SQLite-backed CRUD for commands with a full-screen command editor, tabs, and a
  two-column output-schema editor with auto-preview.
- Categories (inline, free-text with suggestions) and tag chips with ANY-match
  filtering and card badges.
- Favorites, full-text search with filters, and a read-only view modal for
  commands and workflows.
- Action history (create/edit/delete/run) with undo/restore from snapshots.
- Import/Export of commands and workflows as a versioned JSON envelope via native
  file dialogs.

#### Visual editor & workflows
- React Flow node canvas with `start` / `command` / `condition` / `end` nodes,
  directional handles, drag/click to add, auto-linking to neighbors, edge
  insertion with downstream shift, node/edge deletion with re-linking, a node
  inspector, and a draft that survives navigation.
- Workflow MVP: linear command chains plus branching on exit code
  (`then` / `else`), executed entirely in the Rust backend by reusing the command
  executor and running in the background (including from the tray).
- Workflow CRUD + `execute_workflow` / `cancel_workflow` IPC, a `workflow-event`
  progress channel, a dedicated `workflows` SQLite table, per-node variable
  overrides, and workflow history events.
- Commands / Workflows tabs in the Library with workflow cards (Run / Edit /
  Delete / Favorite).

#### Quick launch
- Command palette with fuzzy search, configurable global hotkeys, system tray
  access, and a Home screen showing recently-run commands and workflows.

#### Licensing (Basic / PRO / trial)
- Client-side activation, one-click device-bound 30-day trial, and lease refresh
  against the license server, with offline Ed25519 lease verification against an
  embedded public key.
- Device binding via a salted composite HWID hash (raw identifiers never leave
  the device), a signed-clock rollback guard, and OS-keychain lease storage.
- Authoritative Basic-tier creation quotas (≤10 commands, ≤1 workflow) enforced
  at the storage boundary; editing and running existing entities is unlimited.
- About screen showing license status; cosmetic PRO gating in the UI.

#### Run as administrator
- Elevated execution via `sudo -S` (Linux/macOS, password stored in the OS
  keychain) and `Start-Process -Verb RunAs` / UAC (Windows), with a one-shot
  "Continue without saving" password flow and inline-escalation detection.

#### Process capture (recorder)
- Windows process-birth capture over ETW emitting `capture-event`s the user can
  turn into commands; shown as a stub on non-Windows platforms.

#### Editor ergonomics
- In-field utility flag hints: the leading utility in the Script field is
  highlighted in place, with a hover popover of `--help` / `-h` / `man` output;
  supports bare names and absolute/relative executable paths.
- Multi-language syntax highlighting in the script editor.

#### Platform & packaging
- System tray with close-to-tray, single-instance enforcement, and window-state
  restoration.
- Windows NSIS and Linux `deb` / AppImage installers with a release CI pipeline.
- Internationalization (English / Russian).

### Security
- All shell execution flows through the executor; app-controlled subprocesses are
  spawned with fixed argument arrays, never via a shell.
- Utility flag hints validate the leading-utility token against an allow-list on
  both the TypeScript and Rust sides before spawning.
- Secrets (sudo password, license lease, clock marker) are stored only in the OS
  keychain, never in SQLite or JSON config.
- Parameterized SQL throughout; a restrictive Content Security Policy for the
  webview.

[0.10.4]: https://github.com/procmix/proc_mix/releases/tag/v0.10.4
[0.10.1]: https://github.com/procmix/proc_mix/releases/tag/v0.10.1
[0.10.0]: https://github.com/procmix/proc_mix/releases/tag/v0.10.0
[0.4.0]: https://github.com/procmix/proc_mix/releases/tag/v0.4.0
[0.3.4]: https://github.com/procmix/proc_mix/releases/tag/v0.3.4
[0.3.1]: https://github.com/procmix/proc_mix/releases/tag/v0.3.1
[0.2.3]: https://github.com/procmix/proc_mix/releases/tag/v0.2.3
[0.2.2]: https://github.com/procmix/proc_mix/releases/tag/v0.2.2
[0.2.1]: https://github.com/procmix/proc_mix/releases/tag/v0.2.1
[0.2.0]: https://github.com/procmix/proc_mix/releases/tag/v0.2.0
[0.1.1]: https://github.com/procmix/proc_mix/releases/tag/v0.1.1
[0.1.0]: https://github.com/procmix/proc_mix/releases/tag/v0.1.0
