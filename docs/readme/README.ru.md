<div align="center">

<img src="../../src-tauri/icons/icon.png" width="96" height="96" alt="ProcMix logo" />

<h1>ProcMix</h1>

<p align="center">
  <a href="../../README.md" title="English"><img alt="English" src="https://img.shields.io/badge/EN-English-8B949E?style=flat-square&labelColor=30363D"></a>
  <kbd title="Русский"><img alt="Русский" src="https://img.shields.io/badge/RU-%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-3584E4?style=flat-square&labelColor=241F31"></kbd>
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](../../LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-black?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-black?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-black?style=flat-square&logo=typescript)](https://www.typescriptlang.org)

</div>

---

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

**Выполнение на удалённых хостах по SSH**<br/>
Запускайте команды и сценарии на удалённых хостах из вашего `~/.ssh/config` или с запросом хоста при запуске. В Истории для каждого удалённого запуска показывается бейдж цели.

</td>
<td width="50%" valign="top">

**Передача файлов по SFTP**<br/>
Двухпанельный браузер для переноса файлов между вашей машиной и удалённым хостом — загрузка, скачивание, переименование и удаление с живым прогрессом.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Встроенный HTTP API сервер**<br/>
При желании открывайте выбранные команды и сценарии по локальному REST API, чтобы запускать их из скриптов или других инструментов. По умолчанию выключен, слушает только `127.0.0.1` и защищён Bearer-токеном из системного хранилища ключей.

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

---

<div align="center">
<sub>MIT License · Built with <a href="https://tauri.app">Tauri</a> · <a href="https://github.com/ez404-36/proc_mix_app/issues">Report an issue</a></sub>
</div>
