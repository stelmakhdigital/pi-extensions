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
- [ ] Разрешение на коммит (явная команда)
