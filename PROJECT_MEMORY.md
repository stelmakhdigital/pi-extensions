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

**v1, v2 (1–7) и v3 завершены и live-проверены в tmux (2026-09-24). Коммиты сделаны и
pushed: v1 098ac5b, v2 a50b72e, v3 f443b28 (по явной команде, двумя коммитами).**

Состав: `extensions/subagents/*` (8 ts + 4 bundled-агента), `test/subagents.test.mjs` (unit 36),
`test/smoke.test.mjs` (секция 9), package.json, README (корневой + расширения).
Тесты: tsc --strict --noUnusedLocals — 0 ошибок; unit 36/36; smoke 52/52.

### v3 (2026-09-24) — что добавлено
1. **Детектор «без ответа» (child.ts)**: auto-exit при `stopReason === "stop"` и без
   assistant-текста в последнем сообщении → sidecar ping с инструкцией родителю
   (один раз на процесс). `sidecarWritten` — явный agent_done/agent_ping не
   перезаписывается. Пейсхолдер pi `"  (no response)"` фильтруется
   (`lastAssistantHasText` + `lastAssistantText`) — без этого детектор не срабатывал
   (найден live: модель «без ответа» оставляет блок `(no response)`).
2. **noSummary-карточка**: done без summary → details.noSummary, явный текст
   «did not write a final answer… resume_agent» (resultText + compact/expanded + notify).
3. **Stall-репинг**: `watchdog.stallRepingTicks` (дефолт 30; 0 = один раз), env
   `PI_SUBAGENTS_STALL_REPING_TICKS`; чистая логика `nextStallAction()` (unit).
4. **/plan: 4-я фаза `test`** (окно plan: test): прогон тестов/сборки после ревью.

Live-интеграция v3: авто-пинг (⇠ nocase2 ping с нашим текстом); явный agent_done
без текста → noSummary-карточка, родитель сам резюмил и получил ответ; явный
agent_ping (своим текстом) → ping-карточка; stall-репинг (SIGSTOP-ребёнок:
«looks stalled (5s)» → «still stalled (no snapshot for 171s)», тик 5s из test-конфига);
/plan — 4 фазы до «plan: test», файл создан.

### v2 (2026-09-24) — что добавлено
1. **Токены/стоимость ребёнка**: `readChildUsage` (session.ts) — инкрементальный parse
   usage-записей из jsonl (offset, только хвост, partial-line-безопасно); в виджете
   (`· 19.3k tok [· $x]`), в steer-details (`tokens`/`costUsd`) и expanded-рендере.
2. **`/subagents doctor`** — collectDoctor (async) + renderDoctorReport (чистая, unit):
   tmux/версия, в tmux ли pi, сервер, pi CLI, disabled, конфиг (источники+значения),
   агент-definitions по source, session-файл, child-mode/guard-env.
3. **Умный shell-ready**: `waitForShellReady` (capture-pane 125ms до маркера промпта
   `$ > ❯ # %`); `tmux.shellReadyMs` теперь = max-ожидание, 0 = не ждать.
4. **`/iterate [agent] <task>`** — fork текущей сессии (+ITERATE_PROMPT без agent-def);
   без auto-exit по умолчанию — интерактивный режим (пользователь ведёт панель).
5. **`/plan <task>`** — spawn planner + steer-инструкция модели на фазы worker/reviewer
   (окна `plan: <фаза>`); фазы исполняет модель по steer-результатам.
6. **Bundled-агенты** `extensions/subagents/agents/`: planner, scout, worker, reviewer
   (приоритет project > global > bundled; agents_list показывает source).
7. **`spawning: true` / `deny-tools`**: у spawning-агента child грузит и index.ts
   (второй -e), env PI_SUBAGENTS_SPAWNING=1, parent-тулзы не исключаются (guard в
   extension: child-mode пропускает только при SPAWNING=1); deny-tools — append к
   --exclude-tools. Рекурсия проверена live: parent → boss → grandchild, карточка босса
   со словом внука.

Live-интеграция v2 (tmux 3.6, локальная LLM): doctor — все чек-и зелёные; виджет
с токенами; /iterate (ребёнок увидел 19.3k ctx); spawning-цепочка (малая модель босса
нервозно звала agent_done без текста — родитель сам резюмил его, расширение работало
корректно); /plan — три фазы дошли, hello.txt создан, вердикт ревьюера получен.

### Из v1 (напоминание): пойманные интеграционные баги
1. Path-дубль seed-файла → `sessionsRootFor()`. 2. Auto-exit отключался первым промптом
→ `sawAgentStart`. 3. TOCTOU лимита → синхронное резервирование слота. 4. Handoff без `-d`
не создавал сессию → `-d` + явный `--session <file>`. 5. Глобальные расширения блокировали
ребёнка → `--no-extensions` по умолчанию (`child.extensions`).

Осталось:
1. Дальнейший бэклог (roadmap §«Вне v2»): detached-хост-сессия, другие MuxBackend,
   repeated stall-пинги — уже есть (v3), /plan-фаза test — уже есть (v3).

Замечания для отладки: артефакты запуска — в `<sessionDir>/artifacts/<childId>/`;
sidecar — `<childSession>.exit`; `PI_SUBAGENTS_DEBUG_LOG=<file>` у child — лог событий.

## GRAFT-ENGINE (задача от 2026-09-24: свой движок вместо @nanonets/graft)
**v1 + v1.1 + v1.2 ГОТОВО (2026-09-24). Коммиты: ef48083 (v1), 092ca7c (v1.1); v1.2 — pending.**

### Что есть
- `engine/graft/` (TS, tsc strict, 14 модулей): scan (git ls-files + untracked; языки:
  ts/tsx/js/mjs/cjs/py — tree-sitter двухпроходная экстракция; go/rust/c/cpp/sh —
  `extractOther.ts`: tree-sitter + правила по нод-типам) / parse (web-tree-sitter + wasm) /
  extract (edges calls; local→export; импорты; member-цепочки `new X().m()`, `x.m()` —
  `globalMethods` + `resolveVia` (new/call/ident)) / build (pending-resolve) / store
  (`graft/.engine/{graph,deep}.json`, `graft/cards/`, `index.md`) / query (ask — с deep
  summary+crux; grep; callers; skeleton; map — `{deep:true}`: темы + file-summaries;
  check — языки через `langOf`; blast) / deep (openai-chat fetch, кэш bodyHash, валидация
  crux по строкам тела, типы+функции+методы+классы; явный конфиг `GRFT_LLM_BASE_URL/MODEL/API_KEY`) /
  concepts (LLM-темы 3–8, dir-fallback, кэш `deep.concepts` по hash) / viz (`graft/viz.html`,
  self-contained SVG: кластеры каталогов, size=degree, клик=соседи, deep-панель) / index.
- CLI `bin/graft.mjs`: build [--deep|--incremental] (и alias `build deep`), map, ask, grep,
  callers, skeleton, check, blast, concepts, viz, watch (fs.watch recursive, debounce 1.5 c).
- MCP `bin/graft-mcp.mjs`: stdio JSON-RPC 2.0 (newline-delimited), 7 инструментов,
  корень = env `GRFT_MCP_ROOT` ?? cwd; ноль внешних зависимостей (jiti + движок).
- `extensions/graft`: тонкий адаптер (jiti, без spawn): 7 тулзов, `<graft>` (TTL 120 с,
  map без deep), blast-хук (diff-ориентированный, по write/edit + 60 с), бейдж, `/graft build [deep]`.
- Репо-граф: 32 файла / 431 узел / 410 рёбер (после v1.2); deep v1 (cat-vllm) сохранён в deep.json
  (crux пересоберутся при следующем deep-прогоне по-новому).

### Баги/факты (уроки)
1. **bash-обёртка инструмента** съедает backticks и `${}` в heredoc/строках — патчить файлы
   через write-инструмент либо chr(96)/chr(36) в python. (Потерял на этом ~3 цикла.)
2. pi `registerFlag` — только string/boolean.
3. MCP: обработчик stdin должен прогнать ВСЕ линии чанка (ранний return/break теряет остаток
   буфера); catch-all «method not found» — только по флагу `handled`.
4. go-методы: тип рецивера = `type_identifier` (ptr-рецивер: pointer_type→type_identifier);
   `identifier` — это переменная (i), не тип.
5. bash-grammar: имя команды = нода `command_name`.
6. LLM (cat-vllm qwen) не гарантирует дословность crux — верификация по строкам тела обязательна.
7. `check()`/`scan` — набор языков всегда через `langOf` (единый источник), не хардкод-списки.
8. tree-sitter: `Language` — отдельный именованный экспорт web-tree-sitter (не Parser.Language).
9. java `this.helper()`: callee method_invocation — первая именованная нода, а не
   namedChildren[0] (this идёт первым).
10. short-name fallback: базовое имя вызова (helper) резолвится в qualified-метод того же
   файла (иначе byName с ключом «T.m» никогда не попадается по имени «m»).

### v1.2 (беклог, 2026-09-24)
1. **Type inference v1**: `extract.fnReturns` — явные return-типы TS/JS (function_declaration и
   arrow/function_expression: field `return_type` → первый type_identifier; Foo<T> → Foo).
   `build.resolveVia`: via.kind === "call" → fnReturns → класс в-файле или импорт → Foo.m.
   Только явные аннотации; full inference (выражения, дженерики) — вне.
2. **Языки +3**: Java (class_declaration / method_declaration / method_invocation),
   C# (class_declaration / method_declaration / invocation_expression),
   Kotlin (class_declaration / function_declaration / call_expression, name = simple_identifier).
   Qualified-методы через `enclosingClassName` (parent-walk к class_declaration).
   Расширения: .java, .cs, .kt, .kts; грамматики: java, c_sharp, kotlin.
3. **Concepts-fallback без LLM**: root — по языковой семье (root/ts-js, root/go, …; при ≥3
   файлов), каталоги — темы, группы <2 файлов → «прочее».

### Тесты
- 20 unit (`test/graft-engine.test.mjs`): fixtures ts/mjs/py/go/rust/sh/java/cs/kt;
  member-chain (new().m, cross-file); fnReturns (usePair→Pair.get); deep + concepts через
  fake-LLM (node:http); concepts-fallback (отдельный fixture: root/ts-js, src, «прочее»);
  viz; MCP spawn roundtrip (3 запроса).
- 52 smoke, 36 subagents — без регрессов. tsc strict — чисто.

### Осталось
- Live smoke v1.2 (быстрый, через pi -p или tmux) + коммит v1.2 (по команде пользователя).
- Бэклог дальше: full type inference (возвратные выражения, дженерики), авто-refresh deep,
  другие языки (ruby/php/swift — грамматики в tree-sitter-wasm есть, 100+).
