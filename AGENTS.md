# AGENTS.md — pi-extensions

Репозиторий-коллекция расширений для [pi](https://pi.dev) coding agent. Репозиторий = один git-пакет.

## Структура
- `extensions/<name>/index.ts` — расширение (один файл + README.md, без per-extension манифестов/package.json)
- `package.json` — корневой; регистрация расширений: `"pi": { "extensions": ["extensions/<name>/index.ts", ...], "skills": [...] }`
- `test/<name>*.test.mjs` — самодостаточные smoke-скрипты (jiti + стаб `ExtensionAPI`): `npm test` прогоняет все, `node test/<файл>` — один
- `README.md` — одна таблица «все расширения» (что делает + чем включать/выключать);
  подробности — в README самого расширения (он ссылается из таблицы) и в тематических
  разделах ниже. Новое расширение — строка в таблицу, фильтр в «Установка по
  отдельности» и ветка в «Структура».
- Ревью-знание — в скиллах, а не в промпт-шаблонах и не в сниппетах: бэкенд —
  `skills/review-backend/`, код экранов — `skills/ui-review/references/code.md`.
  Аргументы принимает `/skill:<имя> <запрос>` (docs pi «Skills»), той же командой
  скилл форсится, если модель не подхватила его по описанию. Не дублировать чужие
  ревью-материалы: порядок важности, правила проверки и формат отчёта — у
  `ponytail-review`/`ponytail-audit`, замеры вёрстки — у `skills/ui-review`; в
  своём скилле только недостающая часть (специфика домена) и ограничение «без
  правок». Сниппет — короткое правило на каждое сообщение прогона; пересказ
  скилла в сниппете не держать.
- `.github/workflows/ci.yml` — npm ci + `npm test` на Node 22
- `.memory/` (вне git) — заметки сессий

## Как устроены расширения (паттерн, см. bash-guard)
- SDK: `import ... from "@earendil-works/pi-coding-agent"` (peerDependency).
- Блокировка tool calls: `pi.on("tool_call", async (event, ctx) => { if (!isToolCallEventType("bash", event)) return; ... return { block: true, reason: "..." }; })`
- Слэш-команда: `pi.registerCommand("name", { description, handler })`; CLI-флаги: `pi.registerFlag("--name-...")`.
- Статус-иконка в футер: `ctx.ui.setStatus(" <name>", text)` — **ключ с пробелом в начале** (сортировка/обрезка футера). Выкл-бейдж: `theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ XX OFF ")))`; сброс: `setStatus(key, undefined)`.
- Toggle-состояние guard-расширений (bash-guard/dir-guard/text-guard/injection-guard) — персистентно: `extensions/guard-state.ts` → `<agentDir>/guard-state.json` (переживает /reload и перезапуск; в субагентах файл не читается — fail-safe).
- Общее состояние вне factory — модуль-синглтон (`extensions/yolo-mode.ts`, `extensions/untrusted.ts`, `extensions/sandbox-state.ts`): export-функции + подписчики, состояние в переменных модуля. Так guard'ы видят режим друг друга, не импортируя чужой index.ts.
- Порядок `pi.extensions` значим (цепочка хендлеров идёт по нему): `yolo` первым (`project_trust` до sandbox), `dir-guard` до `bash-guard` (жёсткая граница путей раньше, чем пользователь уже подтвердил команду), `sandbox` последним из меняющих `input.command` (guard'ы разбирают сырую команду, не обёртку bwrap), `edit-check` последним. Force-include `+path` в фильтрах дописывает файл в конец и порядок ломает.
- Sandbox мутирует команду после guard'ов, поэтому `bash-guard` узнаёт об изоляции не по тексту команды, а через предикат `registerSandboxProbe`/`sandboxIsolates` (`extensions/sandbox-state.ts`): изолированную команду не спрашивает, «пол» держит, сбой предиката = спрашивать.
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

## Тесты guard'ов
- Каждый guard-тест обязан вызвать `isolateGuardEnv()` из `test/env.mjs` до
  загрузки расширений: `PI_YOLO=1`/`PI_SUBAGENT_DEPTH` в оболочке читаются в
  момент блокировки, и тест молча проверяет «всё разрешено», оставаясь зелёным.
- Тесты, которые переключают режим guard'а (`/dir-guard`, `/bash-guard`), пишут
  `<agentDir>/guard-state.json`; следующий блок в том же прогоне читает его на
  старте своего factory. Перед блокирующими проверками — пин состояния
  (см. `pinGuardState` в `test/dir-guard-smoke.test.mjs`), либо свой
  `PI_CODING_AGENT_DIR` в tmp (см. `test/bash-guard-sandbox.test.mjs`).
- Взаимодействие расширений проверяется по общему мосту, а не по тексту команды:
  `test/bash-guard-sandbox.test.mjs` поднимает предикат через
  `registerSandboxProbe`, `test/smoke.test.mjs` проверяет реальный предикат
  sandbox'а (нет предиката — guard спрашивает, а не разрешает).

## Состояние
- graft вынесен в отдельный пакет `pi-graft` (2026-11). Здесь остались только
  комментарии про порядок иконок в футере (`z-` префикс ключей статуса).
