<div align="center">

<img src="src-tauri/icons/icon.png" width="96" height="96" alt="ProcMix logo" />

<h1>ProcMix</h1>

<p>Cross-platform automation tool — build and run workflows from the desktop,<br/>without cloud dependencies or subscriptions.</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-black?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-black?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

</div>

---

## Features

<table>
<tr>
<td width="50%" valign="top">

**Visual workflow editor**<br/>
Drag-and-drop interface inspired by Apple Shortcuts. Chain commands into multi-step workflows without writing glue code.

</td>
<td width="50%" valign="top">

**Rust execution engine**<br/>
Commands run in a native Rust executor — fast, low overhead, no Node.js subprocess chains.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Fully local**<br/>
All data stays on your device. No account required, no telemetry, no sync to external servers.

</td>
<td width="50%" valign="top">

**Plugin system**<br/>
Extend with built-in or community plugins. Each plugin exposes typed command blocks reusable in any workflow.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Command palette & hotkeys**<br/>
Global hotkeys and a keyboard-first command palette to trigger any workflow without leaving your current app.

</td>
<td width="50%" valign="top">

**Cross-platform**<br/>
Runs on Windows, macOS, and Linux from a single codebase via Tauri 2.0.

</td>
</tr>
</table>

---

## Installation

### Download a release

Pre-built installers are available on the [Releases](../../releases) page:

| Platform | Installer |
|----------|-----------|
| macOS | `.dmg` |
| Windows | `.msi` / `.exe` |
| Linux | `.AppImage` / `.deb` |

### Build from source

**Prerequisites**

- [Node.js](https://nodejs.org) 24+
- [Rust](https://rustup.rs) (stable toolchain)
- Tauri system dependencies for your platform → [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

**Setup**

```bash
git clone https://github.com/ez404-36/proc_mix_app.git
cd proc_mix_app
npm install
npm run tauri build
```

The built installer will appear in `src-tauri/target/release/bundle/`.

---

## Development

```bash
npm install          # install JS dependencies
npm run tauri dev    # start full app (Rust + React hot-reload)
```

| Command | Description |
|---------|-------------|
| `npm run dev` | Frontend dev server only |
| `npm run tauri dev` | Full app with hot-reload |
| `npx tsc --noEmit` | TypeScript typecheck |
| `npm run lint` | ESLint |
| `npm test` | Frontend tests (Vitest) |
| `cargo test` | Rust tests (from `src-tauri/`) |
| `cargo clippy --all-targets -- -D warnings` | Rust lint |

---

<div align="center">
<sub>MIT License · Built with <a href="https://tauri.app">Tauri</a> · <a href="https://github.com/ez404-36/proc_mix_app/issues">Report an issue</a></sub>
</div>
