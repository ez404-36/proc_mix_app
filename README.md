# ProcMix

Cross-platform automation tool built with Tauri 2.0 + Rust backend, React 18 + TypeScript 5 frontend.

## Features

- Visual drag-and-drop workflow editor (Apple Shortcuts style)
- Fast Rust execution engine
- Cross-platform: Windows, macOS, Linux
- Plugin system
- Global hotkeys and command palette
- Local storage — data never leaves your device

## Development

### Prerequisites

- Node.js 24+
- Rust (stable)
- Tauri prerequisites for your platform: https://tauri.app/start/prerequisites/

### Setup

```bash
npm install
npm run tauri dev
```

### Commands

| Command | Description |
|---|---|
| `npm run dev` | Frontend dev server |
| `npm run tauri dev` | Full app (Rust + React) |
| `npm run build` | Frontend build |
| `npm run tauri build` | Full app build |
| `npx tsc --noEmit` | TypeScript typecheck |
| `npm run lint` | ESLint |
| `npm test` | Frontend tests (Vitest) |
| `cargo test` | Rust tests (run from `src-tauri/`) |
| `cargo clippy --all-targets -- -D warnings` | Rust lint |

## License

MIT
