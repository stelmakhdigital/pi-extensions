# PROJECT_MEMORY — расширение Subagents (pi-extensions)

> Файл контекста для продолжения работы в другой сессии. Обновлять по мере принятия решений.

## Цель

Самостоятельное расширение для управления подагентами в `pi`, живущее в этом репозитории
(`extensions/subagents/`). Пишется с нуля как наша разработка: **без упоминаний авторов и ссылок
стороннего референс-проекта нигде** (код, README, коммиты, документация).

## Ключевые требования (от пользователя, 2026-07-24)

1. Управление подагентами: асинхронный spawn в панях терминального мультиплексора, не блокирует
   основную сессию; результат возвращается в основную сессию (steer-сообщение).
2. Мультиплексор — **только tmux**. Но архитектура — с абстракцией бэкенда и конфигурированием,
   чтобы будущие бэкенды добавлялись конфигурацией/регистрацией, а не переписыванием.
3. Улучшения, а не копия. Свои рекомендации по улучшению проекта — в roadmap.md (см. «Рекомендации»).
4. Процесс: SDLC/PMBOK, сначала дисквери. Работа — только после явного подтверждения понимания.
   Коммит — только по явной команде пользователя (тогда же отмечать выполненные пункты roadmap.md).
   Каждый шаг: план на русском, todos включают «компиляция и тестирование» и «разрешение на коммит».

## Дисквери: ключевые факты (проверено)

### Наш репозиторий
- pi-extensions: git-пакет для pi, коллекция мелких расширений, ESM + TypeScript (jiti), `type: module`.
- Манифест пакета — `package.json` → `pi.extensions[]` (массив путей) + `pi.skills[]`.
- Существующие расширения: prompt-snippets, bash-guard, ask-user-question, graft, sandbox, gen-speed.
- Паттерн расширения: `export default function (pi: ExtensionAPI)`, `pi.registerTool`, `pi.on`,
  `ctx.ui.custom/editor/setWidget`, `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`.
- UI-мьютекс для всплывающих окон — глобальный `globalThis.__piSharedUiLock` (см. ask-user-question).
- Тесты: `test/smoke.test.mjs` — загрузка каждого расширения через jiti со стаб-объектом ExtensionAPI.
- Правила проекта: код/комментарии — английский в коде, документация — русский; коммиты конвеншн.

### pi CLI (проверено: v0.87.0)
- `pi --session <path>` — точный путь к файлу сессии (детерминированный pre-create файла ребёнка
  возможен — нет гонок при параллельном spawn).
- `-e <path>` — доп. расширение ребёнка (child-extension: subagent_done, caller_ping, activity).
- `--model <provider/id[:thinking]>`, `--tools`, `--exclude-tools`, `--append-system-prompt`
  (принимает и путь к файлу — так передаём многострочный системный промпт без экранирования),
  `--skill`? (нет, скиллы через промпт-аргумент `/skill:<name>` как message), `--session-dir`.
- `--fork`, `--session-id`, `--print` — доступные, но spawn идёт интерактивным (панель).

### Механика референс-архитектуры (изучены исходники; переносим идею, пишем свою)
- Родитель: инструменты `subagent` (spawn, мгновенный возврат), `subagents_list`,
  `subagent_interrupt` (Escape в панель), `subagent_resume` (по пути к сессии);
  команды `/plan`, `/iterate`, `/subagent`.
- tmux: `split-window -d -h -t $TMUX_PANE -P -F "#{pane_id}"`, `send-keys -l` + Enter,
  `send-keys Escape`, `rename-window`, `list-panes` (poll 1 c), `capture-pane` (экран),
  `kill-pane`. Окно/панель получает имя подагента.
- Детерминированный файл сессии ребёнка: родитель сам генерирует путь
  `<sessionDir>/<timestamp>_<uuid>.jsonl` и передаёт `--session`. Режимы сессии:
  standalone / lineage-only (пустая сессия + parentSession-связь) / fork (копируются ходы (turns) родителя).
- Ребёнок: child-extension (отдельный .ts, грузится через -e) пишет JSON-снапшот активности
  (фаза active/waiting, текущий tool, seq) в артефакт-директорию (путь — через env),
  инструменты `subagent_done` (автозавершение, auto-exit) и `caller_ping` (вопрос родителю,
  сессия завершается, родитель отвечает через resume).
- Родительный watchdog: снапшот не обновляется дольше порога → статус `stalled` → steer-пинг
  родителю (для non-interactive агентов; интерактивные молчат).
- Извлечение результата: после выхода процесса в панели — последний assistant-сообщение из
  jsonl сессии ребёнка → `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`.
- Живой виджет над вводом: `ctx.ui.setWidget("subagent-status", ...)` — список бегущих
  подагентов со статусом (starting/active/waiting/stalled) и текущим инструментом.
- Определения агентов: `.pi/agents/*.md` (frontmatter: model, thinking, tools, skills,
  session-mode, auto-exit, interactive, cwd, deny-tools, spawning) + глобальные
  `~/.pi/agent/agents/` + bundled (planner/scout/worker/reviewer/visual-tester).
- Конфигурация: config.json в каталоге расширения (gitignored) + env
  PI_SUBAGENT_MUX / PI_SUBAGENT_SHELL_READY_DELAY_MS (задержка готовности shell, дефолт 500ms).
- Поддержка Claude Code CLI как бэкенда детей (у нас не планируем — pi only).

### Окружение пользователя
- tmux 3.6 (csi-u extended keys доступны).
- **Текущая сессия НЕ запущена в tmux** (TMUX/TMUX_PANE пустые) → нужен осознанный fallback
  (отдельный tmux session / настройка стратегии запуска) — вопрос открыт.
- В глобальных настройках `~/.pi/agent/settings.json` сейчас установлен сторонний пакет
  pi-interactive-subagents — при вводе нашего расширения его придётся убрать
  (конфликт имён инструментов). Вопрос к пользователю.

## РЕШЕНИЯ (2026-07-24, подтверждено пользователем)

Дизайн v1 — **SPEC-subagents.md** (API/форматы проверены по pi 0.87.0).

1. **Имена инструментов**: короткие, без префикса (кандидаты: `spawn_agent`, `agents_list`,
   `interrupt_agent`, `resume_agent`; child-инструменты — `agent_done`, `agent_ping`).
   При вводе: удалить сторонний пакет `git:github.com/HazAT/pi-interactive-subagents`
   из `~/.pi/agent/settings.json`.
2. **Вне tmux**: конфигурируемая стратегия запуска (pane / detached); дефолт: pane, если
   внутри tmux, иначе авто-создание detached- tmux-сессии (окно подагента, attach по имени).
3. **Объём v1**: 4 инструмента + live-виджет + agent-definitions (.pi/agents + глобальные)
   + команда `/spawn` (быстрый ручной спавн). /iterate, /plan, bundled-агенты — v2 (бэклог).
4. **Конфигурация**: секция в settings.json (проектная/глобальная) + env-оверрайды — фиксируется в дизайне.

## Рекомендации по улучшению (наши, к обсуждению)

1. **Бэкенд-слой**: интерфейс `MuxBackend` (createSurface/sendKeys/sendEscape/surfaceAlive/
   readSurface/closeSurface/renameSurface) + один tmux-реализатор; выбор бэкенда и параметры —
   в конфиге. Будущий бэкенд = новый файл + регистрация.
2. **Стратегия запуска** (pane/window/detached-session) — конфигурируемая; detached-session
   снимает зависимость «pi обязан работать внутри tmux».
3. **Один tmux-процесс на тик**: вместо N execFileSync на каждого подагента — один
   `list-panes -F` для всех паней за раз + fs-wait по снапшотам.
4. **Структурный steer-результат**: details (status, sessionFile, exitCode, elapsed, cost?)
   + renderResult в основной сессии, а не только текст.
5. **Стоимость/токены ребёнка** в виджете (считать из jsonl сессии ребёнка — бесплатно,
   данные уже есть).
6. **Лимиты и безопасность**: max-одновременных подагентов; по умолчанию детям запрещён
   рекурсивный spawn (deny `subagent` инструменту ребёнка, кроме явного `spawning: true`).
7. **doctor-команда** `/subagents doctor`: версия tmux, csi-u, TMUX_PANE, доступность паней,
   конфиг — быстрый self-check.
8. **Тесты**: unit (сборка tmux-команд через injectable exec) + интеграция (echo-агент в
   tmux-сессии в тестовом контейнере/окне) + smoke через jiti-стаб как у остальных.
9. **Надёжность shell-ready**: вместо фиксированной задержки — опциональная проверка
   (capture-pane маркер промпта / timeout+retry) при отправке launch-команды.
10. **Авто-закрытие паней** по завершении (kill-pane) + режим «оставлять панель» для
    инспекции (конфиг).

## Стек/ограничения реализации
- Только tmux для v1; интерфейс бэкенда готов к расширению.
- ESM + TS, типизация через typebox для параметров инструментов (как остальные расширения).
- Без новых npm-зависимостей (tmux CLI через execFile).
- Пишем: `extensions/subagents/` (index.ts + child.ts + tmux-backend.ts + session.ts + agents.ts
  + config.ts + types.ts + README.md), регистрация в package.json `pi.extensions[]`, секции
  корневого README, unit (test/subagents.test.mjs) + smoke (секция 9).

## СТАТУС (по итогам сессии — продолжить отсюда)

**Реализация v1 завершена и проверена, включая ручной tmux-интеграционный чек-лист (2026-09-24).**
Состав: `extensions/subagents/*` (8 файлов), `test/subagents.test.mjs` (unit 24),
`test/smoke.test.mjs` (секция 9), package.json, README (корневой + расширения).
Тесты: tsc --strict --noUnusedLocals — 0 ошибок; unit 24/24; smoke 52/52;
headless-интеграция реальным `pi -p` + ручной tmux-чек-лист: все 7 пунктов пройдены
(spawn→виджет→steer-карточка, interrupt, resume, maxConcurrent=2, handoff, disabled).

Интеграционные баги, пойманные в чек-листе и исправленные:
1. Path-дубль в seed-файле ребёнка: `getSessionDir()` возвращает per-cwd подкаталог,
   а не корень sessions → `sessionsRootFor()` (session.ts) + регрессионный unit-тест.
2. Auto-exit child не работал: первый task-промпт приходит как input-событие и отключал
   auto-exit → guard `sawAgentStart` (child.ts).
3. TOCTOU-гонка лимита: параллельные спавны проходили проверку по устаревшему счётчику
   (check и running.set разделены await) → синхронное резервирование слота до первого
   await (spawn и resume; resume теперь тоже учитывается лимитом).
4. Handoff: `tmux new-session` без `-d` не создавал сессию (клиент пытался перехватить
   терминал старого pi) → флаг `-d`; продолжение — явный `pi --session <файл>`, а не
   «последняя в cwd».
5. Ребёнок блокировался глобальными расширениями (trust-диалоги) → детерминированное
   окружение child: `--no-extensions` по умолчанию (конфиг `child.extensions` none/all).

Осталось:
1. Коммит — только по явной команде; тогда: удалить пакет `git:github.com/HazAT/pi-interactive-subagents`
   из ~/.pi/agent/settings.json (решение пользователя, этап 4 roadmap) и отметить этап 4
   в roadmap.md.
2. v2 (бэклог): /iterate, /plan, bundled-агенты, стоимость/токены в виджете, doctor,
   «умный» shell-ready, detached-хост-сессия, другие MuxBackend.

Замечания для отладки: артефакты запуска — в `<sessionDir>/artifacts/<childId>/`
(launch-скрипты, systemprompt, activity-снапшоты); sidecar — `<childSession>.exit`;
`PI_SUBAGENTS_DEBUG_LOG=<file>` у child — лог обработанных событий child-расширения.
