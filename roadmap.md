# Roadmap — расширение Subagents

Этапы (SDLC). Выполненные пункты отмечаются по мере выполнения; коммит — только по
явной команде пользователя (этап 4).

## 0. Дисквери / согласование
- [x] Изучить репозиторий pi-extensions (манифест, паттерны расширений, тесты)
- [x] Изучить референс-архитектуру (tmux-сплиты, снапшоты активности, steer-результаты, agent-definitions)
- [x] Проверить окружение (tmux 3.6, флаги pi CLI 0.87.0, settings)
- [x] PROJECT_MEMORY.md / roadmap.md / AGENTS.md
- [x] Ответы пользователя: короткие имена инструментов без префикса + удаление стороннего
      пакета из settings; объём v1 — ядро + /spawn; конфиг — файлы + env
- [x] Решение по «pi вне tmux»: как в оригинале (сплит текущего окна; иначе ошибка-инструкция)
      + handoff при старте (ask/auto/never): tmux new -A -s pi 'pi -c' + continuation сессии
- [x] Подтверждение понимания → переход к дизайну

## 1. Дизайн
- [x] Спецификация v1 (SPEC-subagents.md): инструменты/команды, конфиг-схема, интерфейс
      MuxBackend, форматы снапшота и steer-details, план тестов
- [x] Согласование спецификации с пользователем (включая замену detached на handoff)

## 2. Реализация (v1)
- [x] Конфигурация: `~/.pi/agent/subagents.json` < `<cwd>/.pi/subagents.json` (trusted) < env;
      валидация, persistHandoffPreference (config.ts)
- [x] tmux-бэкенд: сплит из $TMUX_PANE (-d -h), send-keys (launch-скрипт), escape,
      list/kill/rename, captureTail, batchStatus (1 вызов/тик); injectable runner (tmux-backend.ts)
- [x] Спавн: детерминированный файл сессии ребёнка, seed standalone/lineage/fork (header v3,
      parentSession, копия ветви), launch-скрипт (cd/env/pi --session -e child.ts --model --tools
      --exclude-tools --append-system-prompt -- /skill:* task; sentinel `__SUBAGENT_EXIT_$?`) (session.ts)
- [x] Child-extension: agent_done, agent_ping, снапшоты активности (throttle 500ms, atomic),
      auto-exit (ввод после agent_start отключает; первый промпт — нет), sidecar `.exit` (child.ts);
      детерминированное окружение ребёнка: `--no-extensions` по умолчанию (конфиг child.extensions)
- [x] Родительский цикл: watch 1с (batchStatus + fs), watchdog (stalled: устаревший busy-снапшот;
      idle не ложный), steer-карточка (sendMessage customType + registerMessageRenderer) (index.ts)
- [x] Виджет статуса setWidget("subagents")
- [x] Инструменты: spawn_agent, agents_list, interrupt_agent, resume_agent
- [x] Agent-definitions (`.pi/agents` > `~/.pi/agent/agents`), guard рекурсии
      (env PI_SUBAGENTS_CHILD_ID + --exclude-tools в launch)
- [x] Команда /spawn (интерактив при пустых аргументах); handoff при старте вне tmux
      (ui.select: да/не/никогда; guard-env от цикла; ctx.shutdown)
- [x] README расширения; секции корневого README (таблица, фильтр, «Только subagents», структура);
      манифест package.json `pi.extensions[]`

## 3. Компиляция и тестирование
- [x] tsc --noEmit --strict (pi 0.87.0 dist-типы) — 0 ошибок
- [x] unit: 23/23 (test/subagents.test.mjs): config merge/env, agents discovery/frontmatter/allowlist,
      session seed 3 режима + lastAssistantText, tmux-команды fake-runner'ом, launch-script
      (цитирование/skills/sentinel/allowlist), watchdog-классификация
- [x] smoke: 52/52 (test/smoke.test.mjs), включая загрузку index.ts/child.ts (jiti), режимы child-env
- [x] Headless-интеграция реальным `pi -p`: загрузка расширения, agents_list (проектные
      definitions), unknown-agent-ошибка, spawn вне tmux → backend-ошибка с командой handoff
- [x] Ручной чек-лист в tmux (выполнен 2026-09-24): spawn→виджет→steer-карточка ✓; interrupt ✓;
      resume ✓; maxConcurrent=2 ✓; handoff вне tmux ✓ (detached-сессия + явный --session);
      PI_SUBAGENTS_DISABLED ✓. Pойманы и исправлены 5 интеграционных багов (sessionsRootFor,
      sawAgentStart auto-exit, TOCTOU-лимита, handoff -d, child --no-extensions) — см. PROJECT_MEMORY.md

## 4. Коммит
- [x] Разрешение на коммит (явная команда пользователя); удалён сторонний
      subagents-пакет (HazAT) из ~/.pi/agent/settings.json + добавлен `extensions/subagents/*`
      в локальный список пакета pi-extensions (вступает в силу после push/update пакета)

## Бэклог (v2+, обсуждается)
- [ ] /iterate (форк текущей сессии), /plan (фазовый workflow + тайтлы окон), bundled-агенты
- [ ] Стоимость/токены ребёнка в виджете (usage из jsonl)
- [ ] doctor-команда (self-check tmux-окружения)
- [ ] «Умный» shell-ready (capture-pane-маркер промпта вместо фиксированной задержки)
- [ ] deny-tools / spawning frontmatter; detached-хост-сессия как альтернатива handoff
- [ ] Другие бэкенды поверх MuxBackend

## v2 (итерация от 2026-09-24, по явной команде пользователя)
- [x] 1. Токены/стоимость ребёнка: инкрементальный сбор usage из jsonl (offset),
      виджет + steer-карточка (tokens/cost)
- [x] 2. `/subagents doctor` — self-check: tmux, TMUX_PANE, конфиг (источники+значения),
      agent-definitions, сессия/артефакты, child-mode/guard-env; чек-отчёт сообщением
- [x] 3. Умный shell-ready: waitForShellReady (capture-pane: последний непустой символ —
      знак промпта, поллинг 125ms) с таймаутом (tmux.shellReadyMs = max-ожидание)
- [x] 4. `/iterate [agent] <task>` — спавн с fork текущей сессии (контекст разговора ребёнку)
- [x] 5. `/plan <task>` — фазовый workflow: спавн planner + steer-инструкция модели на
      phases worker → reviewer → итог (окна именованы по фазам)
- [x] 6. Bundled-агенты: extensions/subagents/agents/{planner,scout,worker,reviewer}.md
      (приоритет: project > global > bundled)
- [x] 7. frontmatter `spawning: true` (рекурсивный спавн: -e index.ts у child,
      PI_SUBAGENTS_SPAWNING=1, spawn-тулзы в allowlist) и `deny-tools: a,b,c`
      (--exclude-tools)
- [x] Компиляция и тестирование (tsc strict, unit 32, smoke) + live-интеграция v2 в tmux: doctor, usage-виджет, /iterate (fork 19.3k ctx), spawning-цепочка parent→boss→grandchild, /plan (3 фазы, файл создан)
- [x] Разрешение на коммит (явная команда) — a50b72e, pushed

## v3 (итерация от 2026-09-24, по явной команде пользователя)
- [x] 1. Детектор «без ответа» (child.ts): auto-exit автономного агента без assistant-текста
      в последнем ходе → ping вместо пустой done-карточки (один раз на процесс;
      явный agent_done не трогаем)
- [x] 2. Явная пометка в карточке: done без summary → «завершился без финального ответа»
      + подсказка resume_agent (resultText + renderer + notify)
- [x] 3. Повторные stall-пинги: watchdog.stallRepingTicks (дефолт 30, 0 = один раз)
- [x] 4. /plan: 4-я фаза `test` (прогон тестов/сборки после ревью; окно plan: test)
- [x] Компиляция и тестирование (tsc strict, unit 36, smoke) + live-интеграция v3 в tmux: авто-пинг «без ответа» (⇠ nocase2 ping), явная agent_done → noSummary-карточка, явный agent_ping, stall-репинг (SIGSTOP-ребёнок: first → still stalled … 171s), /plan 4 фазы (plan: test, v3.txt создан). Пойман и отфильтрован pi-плейсхолдер «(no response)»
- [x] Разрешение на коммит v3 (явная команда) — f443b28, pushed

## graft-engine (итерация от 2026-09-24: полностью своя обёртка/движок вместо @nanonets/graft)
- [x] Дисквери: факты (состав nanonets 128MB, формат graft/, поверхность CLI, языки репо, cat-vllm)
- [x] Дизайн: SPEC-graft-engine.md (решения согласованы: tree-sitter-wasm; v1=структура+deep;
      свой формат хранилища; engine/graft + тонкое расширение; deep — только явный конфиг)
- [x] 1. engine/graft: scan + parse (web-tree-sitter: ts/js/py) + nodes/edges (двухпроходная экстракция)
- [x] 2. store: graph.json/deep.json/cards/index.md + fingerprint
- [x] 3. query: skeleton/callers/map/ask/grep/check/blast → +unit-тесты test/graft-engine.test.mjs (15/15)
- [x] 4. deep: LLM-проход (openai-chat fetch, кэш по bodyHash, явный конфиг, валидация crux) → deep: явный конфиг только (env), без конфига — отказ
- [x] 5. CLI bin/graft.mjs (ручные прогоны) → bin/graft.mjs (8 команд)
- [x] 6. Переписать extensions/graft: тулзы через import, <graft>-секция, blast-хук, бейдж, /graft → без spawn: прямой import движка через jiti
- [x] 7. package.json: +web-tree-sitter, +tree-sitter-wasm; убрать @nanonets/graft из доков; → @nanonets/graft убран из package.json/доков; graft/ репо пересобран (28 файлов/394 узла/355 рёбер)
      миграция graft/ (пересборка новым движком)
- [x] Компиляция и тестирование (tsc strict, unit 15/15, smoke 52) + live в pi (pi -p: LLM вызвал graft_map → «28 файлов · 366 узлов»)
- [x] Разрешение на коммит → коммит ef48083, pushed
- [x] v1.1 (2026-09-24): другие языки (go/rust/c/cpp/sh) + member-цепочки вызовов + deep в
      ask/map (map deep — опционально) + concept-ноды (LLM-темы + dir-fallback, кэш по hash) +
      viz (graft/viz.html, CLI viz) + MCP-сервер (graft-mcp.mjs, stdio) + watch (fs.watch) +
      типы в deep; unit 19/19 (fixtures: go/rust/sh, member-chain, concepts, viz, mcp roundtrip)
- [ ] Live в pi (TUI): бейдж, /graft build deep, blast-notify, push-mode
- [x] v1.2 (2026-09-24, бэклог): type inference v1 (возвратные типы TS/JS → f().m()),
      языки +3 (Java/C#/Kotlin), concepts-fallback без LLM (root по языку, каталоги, «прочее»);
      unit 20/20 (fixtures java/cs/kt, fnReturns, fallback)
