# AGENTS.md

## Проект
pi-extensions — git-пакет коллекции расширений для [pi](https://pi.dev) (v0.87.0 API).
ESM + TypeScript (загрузка через jiti), `type: module`. Документация — на русском,
код и коммиты — на английском, коммиты по конвеншн (`feat(scope):`, `fix(scope):`).

## Текущая задача
Новое расширение `extensions/subagents/` — асинхронное управление подагентами
(spawn в tmux-панелях, live-статус, steer-результат, resume, interrupt).
Контекст, факты дисквери и решения — в **PROJECT_MEMORY.md**; этапы — в **roadmap.md**.
Требование: самостоятельный проект — нигде не упоминаем авторов и ссылки сторонних
референсов; только tmux, но с абстракцией бэкенда под будущие расширения.
Ключевые решения: короткие имена инструментов без префикса (spawn_agent/agents_list/
interrupt_agent/resume_agent); стратегия запуска pane → detached-сессия (конфиг); v1 = 4
инструмента + виджет + agent-definitions + команда /spawn.
Дизайн v1 (API/форматы проверены по pi 0.87.0) — в **SPEC-subagents.md**.

**v2 (завершено 2026-09-24, live-проверено в tmux; коммит по команде пользователя):**
tokens/cost ребёнка (виджет + steer-details), `/subagents doctor`, умный shell-ready
(`tmux.shellReadyMs`), `/iterate [agent] <task>` (fork текущей сессии), `/plan <task>`
(planner→worker→reviewer, фазы исполняет модель по steer-инструкции), 4 bundled-агента
(`extensions/subagents/agents/`: planner/scout/worker/reviewer), `spawning: true` и
`deny-tools` в agent frontmatter. SPEC §5a, README расширения — чек-лист 8–13.

## Структура
- `extensions/<name>/index.ts` — расширение (default-export функция от `ExtensionAPI`),
  `README.md` — документация, `package.json` → `pi.extensions[]` — регистрация в пакете.
- `skills/<name>/SKILL.md` — скиллы, `pi.skills[]` в package.json.
- `test/smoke.test.mjs` — загрузка каждого расширения jiti со стаб-объектом ExtensionAPI
  (новый расширение добавлять сюда).
- `graft/` — кэш графа кода; `.memory/` — память сессий.

## Соглашения расширений
- Инструменты: `pi.registerTool` с typebox-схемой параметров, `promptSnippet`/`promptGuidelines`,
  `renderCall`/`renderResult`.
- UI: `ctx.ui.custom` (кэш рендера КЛЮЧИТЬ по ширине — pi-tui не invalidate при resize),
  общие всплывающие окна сериализовать через `globalThis.__piSharedUiLock`.
- Steer-сообщения в основную сессию: `pi.sendMessage(text, { triggerTurn: true, deliverAs: "steer" })`.
- Виджеты: `ctx.ui.setWidget(name, ...)` / `undefined` для удаления.
- Конфигурация: секции в settings.json (проектная/глобальная) + env-оверрайды;
  локальный config.json в каталоге расширения — gitignored.

## Процесс
- Работать по SDLC/PMBOK: дисквери → дизайн (согласовать) → реализация → тесты → коммит.
- Каждый шаг: краткий план на русском + todos (обязательные пункты: «компиляция и тестирование»,
  «разрешение на коммит»); промежуточные доклады; факты проверять, не гадать.
- Коммит — только по явной команде пользователя; тогда же отмечать выполненные пункты roadmap.md.
