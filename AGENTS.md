# AGENTS.md — pi-extensions

Репозиторий-коллекция расширений для [pi](https://pi.dev) coding agent. Репозиторий = один git-пакет.

## Структура
- `extensions/<name>/index.ts` — расширение (один файл + README.md, без per-extension манифестов/package.json)
- `package.json` — корневой; регистрация расширений: `"pi": { "extensions": ["extensions/<name>/index.ts", ...], "skills": [...] }`
- `test/<name>*.test.mjs` — самодостаточные smoke-скрипты (jiti + стаб `ExtensionAPI`): `npm test` прогоняет все, `node test/<файл>` — один
- `README.md` — таблица расширений; новое расширение добавляется строкой в таблицу
- `.github/workflows/ci.yml` — npm ci + `npm test` на Node 22
- `.memory/` (вне git) — заметки сессий

## Как устроены расширения (паттерн, см. bash-guard)
- SDK: `import ... from "@earendil-works/pi-coding-agent"` (peerDependency).
- Блокировка tool calls: `pi.on("tool_call", async (event, ctx) => { if (!isToolCallEventType("bash", event)) return; ... return { block: true, reason: "..." }; })`
- Слэш-команда: `pi.registerCommand("name", { description, handler })`; CLI-флаги: `pi.registerFlag("--name-...")`.
- Статус-иконка в футер: `ctx.ui.setStatus(" <name>", text)` — **ключ с пробелом в начале** (сортировка/обрезка футера). Выкл-бейдж: `theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ XX OFF ")))`; сброс: `setStatus(key, undefined)`.
- Toggle-состояние guard-расширений (bash-guard/dir-guard/text-guard/injection-guard) — персистентно: `extensions/guard-state.ts` → `<agentDir>/guard-state.json` (переживает /reload и перезапуск; в субагентах файл не читается — fail-safe).
- Общее состояние вне factory — модуль-синглтон (`extensions/yolo-mode.ts`, `extensions/untrusted.ts`): export-функции + подписчики, состояние в переменных модуля. Так guard'ы видят режим друг друга, не импортируя чужой index.ts.
- Изменение результата инструмента: `pi.on("tool_result", ...)` возвращает `{ content }` (хендлеры цепочкой, порядок = порядок загрузки в `package.json`). Список путей учётных данных — один на dir-guard и injection-guard: `extensions/secret-paths.ts`.
- Хуки/типы: `docs/extensions.md` и `dist/core/extensions/types.d.ts` в `@earendil-works/pi-coding-agent` (версия в `~/.pi/agent/install/releases/<ver>/node_modules/`).
- `ToolCallEventResult`: `{ block?: boolean; reason?: string; terminate?: boolean }`; input мутируется in place; ошибка хендлера = fail-safe блок.

## Проверки
- `npm test` — все smoke-тесты. Внешних сервисов не требуют, tmux для тестов не нужен.
- Песочница (`extensions/sandbox`): e2e-проверки имеют смысл только на Linux с рабочими
  user namespaces. Без bwrap они печатают `skip ...` и не валят прогон. Фикстуры
  `$HOME/pi-sbx-fixture*` создаются на время прогона и удаляются в конце.
- Пути в тестах — от `os.homedir()` / `import.meta.url`. Зашитых путей конкретного
  пользователя быть не должно: на чужой машине смоук падает сразу.

## Состояние
- graft вынесен в отдельный пакет `pi-graft` (2026-11). Здесь остались только
  комментарии про порядок иконок в футере (`z-` префикс ключей статуса).
