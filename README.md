<div align="center">

<img src="src-tauri/icons/icon.png" width="96" height="96" alt="ProcMix logo" />

<h1>ProcMix</h1>

<p align="center">
  <kbd title="English"><img alt="English" src="https://img.shields.io/badge/EN-English-3584E4?style=flat-square&labelColor=241F31"></kbd>
  <a href="docs/readme/README.ru.md" title="Русский"><img alt="Русский" src="https://img.shields.io/badge/RU-%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-8B949E?style=flat-square&labelColor=30363D"></a>
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-black?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-black?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

</div>

---

<div align="center">

<p>Run scripts and automate tasks — no command line needed</p>

<p>ProcMix gives you a graphical interface for managing commands, workflows, and schedules. No memorising flags — just press a button.</p>

</div>

## Features

<table>
<tr>
<td width="50%" valign="top">

**Command palette and hotkeys**<br/>
Instant fuzzy search over your commands and customizable global hotkeys to launch from anywhere.

</td>
<td width="50%" valign="top">

**Variables and substitution**<br/>
Substitute values with `${name}` and `${name:default}`. Sensitive variables are masked as *** in logs and events.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Run as administrator**<br/>
Privilege elevation through the system keychain on Linux/macOS and through UAC on Windows — without storing the password in plain text.

</td>
<td width="50%" valign="top">

**Output schema**<br/>
Describe your command's output format and ProcMix will parse raw text into structured JSON. For example, lines from `df -h` become an array of objects with filesystem, size, used, and available fields.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Visual workflow editor**<br/>
Build command chains from drag-and-drop nodes with branching by exit code. Preview and live execution progress right on the canvas.

</td>
<td width="50%" valign="top">

**Scheduler**<br/>
Run commands and workflows automatically on a schedule.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Cross-platform**<br/>
A single interface on Windows and Linux. macOS support is coming soon.

</td>
<td width="50%" valign="top">

**Local storage, import/export**<br/>
All data is stored locally — privacy by default. Move commands and workflows between machines via import and export.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Remote execution over SSH**<br/>
Run commands and workflows on remote hosts from your `~/.ssh/config`, or be prompted for a host at run time. The History view shows a target badge for each remote run.

</td>
<td width="50%" valign="top">

**SFTP file transfer**<br/>
A dual-pane browser for moving files between your machine and a remote host — upload, download, rename, and delete with live progress.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Built-in HTTP API server**<br/>
Optionally expose selected commands and workflows over a local REST API to trigger runs from scripts or other tools. Disabled by default, bound to `127.0.0.1`, and protected by a Bearer token kept in the OS keychain.

</td>
</tr>
</table>

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
