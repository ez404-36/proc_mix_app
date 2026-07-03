#!/usr/bin/env bash
# profile-release.sh — честный release-профиль ProcMix через `tauri build --no-bundle`.
#
# Почему `tauri build`, а не `cargo build --release`: cargo собирает бинарник с
# ЗАШИТЫМ devUrl (http://localhost:1420), поэтому запущенный без Vite-сервера он
# показывает "Connection refused" и WebView НЕ грузит реальный UI — footprint
# рендерера получается заниженным. `tauri build` использует build.frontendDist
# (встроенный dist), и WebView загружает настоящий интерфейс.
#
# Почему `--no-bundle`: пропускает упаковку AppImage/deb и updater-артефакты,
# поэтому НЕ требует TAURI_SIGNING_PRIVATE_KEY (иначе билд падает на подписи).
# Бинарник всё равно собирается с prod-фронтендом — этого достаточно для замера.
#
# Требует: node/npm, cargo, @tauri-apps/cli, pgrep, ps, pidstat (sysstat).
# Запуск из app/:  bash scripts/profile-release.sh
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$APP/src-tauri/target/release/procmix"
DBG="$APP/src-tauri/target/debug/procmix"
LOG="/tmp/procmix-release.log"

hr() { printf '%.0s─' {1..64}; echo; }
die() { echo "!! $*" >&2; exit 1; }

command -v cargo   >/dev/null || die "cargo не найден"
command -v pidstat >/dev/null || die "pidstat не найден — sudo apt install sysstat"
[ -f "$APP/package.json" ] || die "не похоже на app/ ($APP)"
cd "$APP"

echo ">>> Сборка release через 'tauri build --no-bundle' (несколько минут)..."
echo "    Использует build.frontendDist → WebView загрузит реальный UI."
npx tauri build --no-bundle
[ -f "$BIN" ] || die "release-бинарник не собрался: $BIN"
hr

echo ">>> Размеры бинарников:"
ls -lh "$BIN"                  | awk '{print "  release:", $5}'
[ -f "$DBG" ] && ls -lh "$DBG" | awk '{print "  debug  :", $5}'
hr

echo ">>> Закрываю ранее запущенные инстансы ProcMix..."
pkill -f 'target/(debug|release)/procmix' 2>/dev/null || true
sleep 2
if pgrep -f 'target/(debug|release)/procmix' >/dev/null; then
  echo "   добиваю -9..."; pkill -9 -f 'target/(debug|release)/procmix' 2>/dev/null || true; sleep 1
fi
hr

echo ">>> Запускаю release (лог: $LOG)..."
"$BIN" >"$LOG" 2>&1 &
APP_PID=$!
echo "    PID=$APP_PID — прогрев WebView 15 с..."
sleep 15

if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "!! процесс $APP_PID умер до замера. Последние строки лога:"
  tail -n 20 "$LOG" || true
  hr
  die "нечего измерять — устраните причину выше"
fi

if grep -qi "Connection refused" "$LOG"; then
  echo "!! ВНИМАНИЕ: в логе 'Connection refused' — бинарник всё ещё смотрит на devUrl."
  echo "   WebView не загрузил UI, замер рендерера будет занижен. Лог:"
  tail -n 5 "$LOG"
  hr
fi

echo ">>> Release footprint (backend + дочерние WebKit):"
CH="$(pgrep -P "$APP_PID" | paste -sd, - || true)"
ps -o pid,rss,%cpu,comm -p "$APP_PID${CH:+,$CH}" 2>/dev/null | \
  awk 'NR==1{print;next}{printf "%8s %7.1fMB %5s%% %s\n",$1,$2/1024,$3,$4; t+=$2}
       END{printf "── TOTAL RSS: %.0f MB\n", t/1024}'
hr

echo ">>> Release idle CPU (10×2 с, НЕ трогайте окно):"
pidstat -h -r -u -p "$APP_PID" 2 10 2>/dev/null | \
  awk '/procmix/{c+=$8; r=$14; n++}
       END{ if(n) printf "RELEASE IDLE: %.2f%% CPU | backend RSS %.0f MB\n", c/n, r/1024 }'
hr

echo "Сравнение с DEV (ранее замерено):"
echo "  DEV: backend ~250 МБ | WebView ~308 МБ | network ~58 МБ | Σ ~615 МБ | idle 0,00% CPU"
echo "  Диск: debug 154 МБ → release 47 МБ (−69%)"
echo
echo "Остановить release: kill $APP_PID"
echo "Готово — пришлите весь вывод для анализа."
