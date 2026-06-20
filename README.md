<div align="center">

<img src="src-tauri/icons/icon.png" width="96" height="96" alt="ProcMix logo" />

<h1>ProcMix</h1>

[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-black?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-black?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

</div>

---

<details open>
<summary><b>🇬🇧 English</b></summary>

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

**Plugin system**<br/>
Extend functionality with JavaScript/TypeScript plugins or native modules written in Rust.

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

</details>

<details>
<summary><b>🇷🇺 Русский</b></summary>

<div align="center">

<p>Запускайте скрипты и автоматизируйте задачи — без командной строки</p>

<p>ProcMix даёт графический интерфейс для управления командами, сценариями и расписаниями. Не нужно запоминать флаги — просто нажмите кнопку.</p>

</div>

## Возможности

<table>
<tr>
<td width="50%" valign="top">

**Палитра команд и горячие клавиши**<br/>
Мгновенный нечёткий поиск по вашим командам и настраиваемые глобальные горячие клавиши для запуска из любого места.

</td>
<td width="50%" valign="top">

**Переменные и подстановка**<br/>
Подставляйте значения через `${name}` и `${name:default}`. Чувствительные переменные маскируются как *** в логах и событиях.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Запуск от имени администратора**<br/>
Повышение привилегий через системное хранилище ключей на Linux/macOS и через UAC на Windows — без хранения пароля в открытом виде.

</td>
<td width="50%" valign="top">

**Схема вывода**<br/>
Опишите формат вывода вашей команды, и ProcMix преобразует сырой текст в структурированный JSON. Например, строки из `df -h` становятся массивом объектов с полями файловой системы, размера, использованного и доступного места.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Визуальный редактор сценариев**<br/>
Стройте цепочки команд из узлов с помощью перетаскивания и ветвления по коду возврата. Предпросмотр и прогресс выполнения прямо на холсте.

</td>
<td width="50%" valign="top">

**Планировщик**<br/>
Запускайте команды и сценарии автоматически по расписанию.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Кроссплатформенность**<br/>
Единый интерфейс на Windows и Linux. Поддержка macOS скоро появится.

</td>
<td width="50%" valign="top">

**Локальное хранение, импорт/экспорт**<br/>
Все данные хранятся локально — приватность по умолчанию. Переносите команды и сценарии между машинами через импорт и экспорт.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Система плагинов**<br/>
Расширяйте возможности плагинами на JavaScript/TypeScript или нативными модулями на Rust.

</td>
</tr>
</table>

## Установка

### Скачать релиз

Готовые установщики доступны на странице [Releases](../../releases):

| Платформа | Установщик |
|-----------|------------|
| macOS | `.dmg` |
| Windows | `.msi` / `.exe` |
| Linux | `.AppImage` / `.deb` |

### Сборка из исходников

**Требования**

- [Node.js](https://nodejs.org) 24+
- [Rust](https://rustup.rs) (стабильный тулчейн)
- Системные зависимости Tauri для вашей платформы → [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

**Настройка**

```bash
git clone https://github.com/ez404-36/proc_mix_app.git
cd proc_mix_app
npm install
npm run tauri build
```

Собранный установщик появится в `src-tauri/target/release/bundle/`.

## Разработка

```bash
npm install          # установить JS-зависимости
npm run tauri dev    # запустить полное приложение (Rust + React hot-reload)
```

| Команда | Описание |
|---------|----------|
| `npm run dev` | Только dev-сервер фронтенда |
| `npm run tauri dev` | Полное приложение с hot-reload |
| `npx tsc --noEmit` | Проверка типов TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Тесты фронтенда (Vitest) |
| `cargo test` | Тесты Rust (из `src-tauri/`) |
| `cargo clippy --all-targets -- -D warnings` | Линтер Rust |

</details>

---

<div align="center">
<sub>MIT License · Built with <a href="https://tauri.app">Tauri</a> · <a href="https://github.com/ez404-36/proc_mix_app/issues">Report an issue</a></sub>
</div>
