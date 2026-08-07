#!/usr/bin/env bash
# setup-env.sh — prepares a local dev environment for ProcMix (Tauri 2 app:
# Rust backend in src-tauri/, React+TS frontend in src/, plus a separate
# web/ browser-served UI with its own package.json).
#
# Usage: bash scripts/setup-env.sh
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP"

hr() { printf '%.0s─' {1..64}; echo; }
info() { echo "-- $*"; }
warn() { echo "!! $*" >&2; }
die() { echo "!! $*" >&2; exit 1; }

REQUIRED_NODE_MAJOR="$(cat "$APP/.nvmrc" 2>/dev/null | tr -d '[:space:]')"
REQUIRED_NODE_MAJOR="${REQUIRED_NODE_MAJOR:-24}"

SUMMARY_OS=""
SUMMARY_APT="skipped"
SUMMARY_NODE="skipped"
SUMMARY_RUST="skipped"
SUMMARY_NPM_ROOT="skipped"
SUMMARY_NPM_WEB="skipped"
SUMMARY_HOOKS="skipped"
SUMMARY_ASKPASS="skipped"

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

OS="$(detect_os)"
SUMMARY_OS="$OS"
hr
info "Detected platform: $OS"
hr

install_linux_deps() {
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found — skipping automatic system dependency install."
    warn "Install the Tauri prerequisites manually: https://tauri.app/start/prerequisites/"
    warn "Required libraries: libwebkit2gtk-4.1-dev, libgtk-3-dev, libayatana-appindicator3-dev, librsvg2-dev, libasound2-dev"
    SUMMARY_APT="not available (see warning above)"
    return
  fi

  info "Installing Linux system dependencies via apt-get (requires sudo)..."
  # WebKitGTK + GTK headers are required by Tauri's Linux build.
  # libasound2-dev provides alsa.pc, needed by alsa-sys (rodio -> cpal) for
  # notification-sound playback.
  local packages=(
    libwebkit2gtk-4.1-dev
    libgtk-3-dev
    libayatana-appindicator3-dev
    librsvg2-dev
    libasound2-dev
  )

  local missing=()
  for pkg in "${packages[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      missing+=("$pkg")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    info "All required system packages are already installed."
    SUMMARY_APT="already installed"
  else
    # apt-get update can exit non-zero if a third-party repo has a bad/missing
    # GPG key, even though the repos we actually need refreshed fine. Don't
    # let that abort the script; apt-get install below stays strict and will
    # fail the script if the required packages truly can't be installed.
    sudo apt-get update || warn "apt-get update reported errors (possibly from a third-party repo) — continuing anyway."
    sudo apt-get install -y "${missing[@]}"
    SUMMARY_APT="installed: ${missing[*]}"
  fi
}

case "$OS" in
  linux)
    install_linux_deps
    ;;
  macos)
    info "macOS detected — skipping automatic dependency install."
    info "Make sure Xcode Command Line Tools are installed (xcode-select --install)."
    info "See Tauri prerequisites: https://tauri.app/start/prerequisites/"
    SUMMARY_APT="n/a (macOS)"
    ;;
  windows)
    info "Windows (git-bash) detected — skipping automatic dependency install."
    info "Make sure WebView2 and the Visual Studio Build Tools (C++ workload) are installed."
    info "See Tauri prerequisites: https://tauri.app/start/prerequisites/"
    SUMMARY_APT="n/a (Windows)"
    ;;
  *)
    warn "Unrecognized platform — skipping automatic dependency install."
    warn "See Tauri prerequisites: https://tauri.app/start/prerequisites/"
    SUMMARY_APT="n/a (unknown platform)"
    ;;
esac
hr

info "Checking Node.js and npm..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  die "Node.js (>=${REQUIRED_NODE_MAJOR}) and npm are required but not found.
  Install via https://nodejs.org or nvm (https://github.com/nvm-sh/nvm):
    nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  die "Node.js >=${REQUIRED_NODE_MAJOR} is required, found $(node -v).
  Install via https://nodejs.org or nvm (https://github.com/nvm-sh/nvm):
    nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
fi
info "Node $(node -v), npm $(npm -v) OK."
SUMMARY_NODE="$(node -v) / npm $(npm -v)"
hr

info "Checking Rust toolchain..."
if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  die "Rust toolchain (rustc, cargo) is required but not found.
  Install via: curl https://sh.rustup.rs -sSf | sh"
fi
info "$(rustc --version)"
info "$(cargo --version)"
SUMMARY_RUST="$(rustc --version)"
hr

info "Installing root npm dependencies..."
npm install
SUMMARY_NPM_ROOT="installed"
hr

info "Installing web/ npm dependencies..."
( cd "$APP/web" && npm install )
SUMMARY_NPM_WEB="installed"
hr

info "Configuring git hooks (core.hooksPath -> .githooks)..."
git config core.hooksPath .githooks
SUMMARY_HOOKS="configured"
hr

info "Building the SSH askpass helper (optional, for remote SSH password auth)..."
if npm run build:askpass; then
  SUMMARY_ASKPASS="built"
else
  warn "Failed to build the askpass helper — remote SSH password auth won't work,"
  warn "but this is optional and does not affect the rest of the dev setup."
  SUMMARY_ASKPASS="failed (non-fatal, see warning above)"
fi
hr

echo "Setup summary:"
echo "  platform:            $SUMMARY_OS"
echo "  system dependencies: $SUMMARY_APT"
echo "  node/npm:            $SUMMARY_NODE"
echo "  rust:                $SUMMARY_RUST"
echo "  root npm install:    $SUMMARY_NPM_ROOT"
echo "  web/ npm install:    $SUMMARY_NPM_WEB"
echo "  git hooks:           $SUMMARY_HOOKS"
echo "  askpass helper:      $SUMMARY_ASKPASS"
hr
echo "Next steps:"
echo "  npm run tauri:dev        # start the Tauri app in dev mode"
echo "  npm test                 # run the frontend test suite"
echo "  (cd src-tauri && cargo test)  # run the Rust test suite"
echo "  npm run askpass:status   # check SSH askpass helper build status"
