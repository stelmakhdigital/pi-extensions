# AGENTS.md — pi-extensions

Репозиторий-коллекция расширений для [pi](https://pi.dev) coding agent. Репозиторий = один git-пакет.

## Структура
- `extensions/<name>/index.ts` — расширение (один файл + README.md, без per-extension манифестов/package.json)
- `package.json` — корневой; регистрация расширений: `"pi": { "extensions": ["extensions/<name>/index.ts", ...], "skills": [...] }`
- `test/<name>*.test.mjs` — самодостаточные smoke-скрипты (jiti + стаб `ExtensionAPI`), запуск `node test/<файл>`
- `README.md` — таблица расширений; новое расширение добавляется строкой в таблицу
- `engine/` — движки (graft); `.memory/` — заметки сессий (не трогать)

## Как устроены расширения (паттерн, см. bash-guard)
- SDK: `import ... from "@earendil-works/pi-coding-agent"` (peerDependency).
- Блокировка tool calls: `pi.on("tool_call", async (event, ctx) => { if (!isToolCallEventType("bash", event)) return; ... return { block: true, reason: "..." }; })`
- Слэш-команда: `pi.registerCommand("name", { description, handler })`; CLI-флаги: `pi.registerFlag("--name-...")`.
- Статус-иконка в футер: `ctx.ui.setStatus(" <name>", text)` — **ключ с пробелом в начале** (сортировка/обрезка футера). Выкл-бейдж: `theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ XX OFF ")))`; сброс: `setStatus(key, undefined)`.
- Toggle-состояние — переменная в памяти сессии (не персистент).
- Хуки/типы: `docs/extensions.md` и `dist/core/extensions/types.d.ts` в `@earendil-works/pi-coding-agent` (версия в `~/.pi/agent/install/releases/<ver>/node_modules/`).
- `ToolCallEventResult`: `{ block?: boolean; reason?: string; terminate?: boolean }`; input мутируется in place; ошибка хендлера = fail-safe блок.

## Текущая задача
- dir-guard (2026-09): блокировка read/write/edit/bash ниже CWD, бейдж `DR OFF`, `/dir-guard`. Контекст — `PROJECT_MEMORY.md`, этапы — `roadmap.md` (вне git, рабочие файлы).
