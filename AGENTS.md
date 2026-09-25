# AGENTS.md

## Проект
pi-extensions — git-пакет коллекции расширений для [pi](https://pi.dev) (v0.87.0 API).
ESM + TypeScript (загрузка через jiti), `type: module`. Документация — на русском,
код и коммиты — на английском, коммиты по конвеншн (`feat(scope):`, `fix(scope):`).

## Текущая задача
Два расширения-столпа: `extensions/subagents/` (асинхронные подагенты в tmux) и
`engine/graft/` + `extensions/graft/` (собственный движок кодового графа).
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

### Graft engine (задача от 2026-09-24, SPEC-graft-engine.md)
Собственный движок кодового графа вместо @nanonets/graft: `engine/graft/` (TS, tsc strict:
scan/parse(extractOther: 25 языков)/build/extract/type-inference/deep/concepts/query/
refresh/wiring/lsp/viz/store), CLI `bin/graft.mjs`, MCP `bin/graft-mcp.mjs`,
тонкое расширение `extensions/graft/` (jiti, без spawn: 7 тулзов + бейдж + /graft).
Deep — только явный конфиг (env GRFT_LLM_BASE_URL/MODEL/API_KEY). Авто-refresh:
fingerprint + ensureFresh во всех query-путях + auto-rebuild после write/edit (badge).
**Программа A–E (2026-09-25) ЗАВЕРШЕНА, v2.0–v2.4, unit 29/29:** A — авто-refresh/
badge/check-exit; B — LSP (lsp-status/lsp-sync, рёбра confidence "lsp") + full-fidelity
go/java/kotlin/php/swift; C — Notes в карточках + concept-links + viz --serve (live-reload);
D — +7 языков (R/Elixir/Solidity/OCaml/Zig/Clojure/Nix) + monorepo-scope;
E — ask --json, blast --format/--no-owners/--name/--export-viz, init/uninstall.
Коммит — по команде пользователя.

## Структура
- `extensions/<name>/index.ts` — расширение (default-export функция от `ExtensionAPI`),
  `README.md` — документация, `package.json` → `pi.extensions[]` — регистрация в пакете.
- `skills/<name>/SKILL.md` — скиллы, `pi.skills[]` в package.json.
- `engine/graft/` — движок графа (свой пакет: src/*.ts + bin/), `extensions/graft/` — адаптер.
- `test/smoke.test.mjs` — загрузка каждого расширения jiti со стаб-объектом ExtensionAPI
  (новое расширение добавлять сюда); `test/graft-engine.test.mjs` — unit движка;
  `test/subagents.test.mjs` — unit subagents.
- `graft/` — кэш графа (`.engine/`, `cards/`); `.memory/` — память сессий.

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
