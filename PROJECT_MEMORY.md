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
**v1–v1.6 ГОТОВО (2026-09-24, бэклог ЗАКРЫТ). Коммиты: ef48083 (v1), 092ca7c (v1.1), 4f3399b (v1.2), 7f3c48a (v1.3), 741ab68 (v1.4), a997cfe (v1.5); v1.6 — pending.**

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
- Репо-граф: 32 файла / 435 узлов / 414 рёбер (после v1.4); deep v1 (cat-vllm) сохранён в deep.json
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
11. php: имя класса/метода = нода типа «name»; enclosingClassName должна учитывать её
    (иначе qualified = null). ruby: callee вызова `obj.helper` — ПОСЛЕДНИЙ identifier.
12. TS arrow с expression-body: поле body arrow_function = само выражение (new_expression) —
    для inferred return тянуть childForFieldName("body") с arrow, а не с declarator.
13. **web-tree-sitter: child-обёртки — НОВЫЕ объекты** (namedChildren без кэша) — indexOf по
    ссылке = -1; искать по node.id (Set<id> для skipped — id стабилен).
14. dart-грамматика: function_body — SIBLING метод_signature (не child) — caller-цепочка рвётся;
    фикс pairedBody (walk тела с caller=метод, skip в родительском цикле).
15. lua: self:helper — function_call [method_index_expression, arguments]; имя метода ВНУТРИ
    index-ноды (lastIdent обязан спускаться в method/dot_index_expression).
16. re.sub-удаление строк с trailing-newline в python-патчах склеивает код (//-коммент глотает
    следующее) — удалять построчно (list of lines), не регуляркой по тексту.

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

### v1.3 (беклог 2, 2026-09-24)
1. **Возвратные выражения**: `inferredReturn` — первое «return new X» в теле (и expression-body
   `=> new X()`); без аннотации. Только new-конструкторы (надежно).
2. **Языки +3**: Ruby (class/method, call + bare identifier в body_statement, calleeFrom
   lastIdent), PHP (class/method qualified, function_call/member_call expression, имя-нода «name»),
   Swift (class/func qualified, call_expression: simple_identifier | navigation_expression —
   последний ident). Механика extractOther: callNodes[], calleeFrom, bareIdentCall;
   enclosing class: class_declaration/object_declaration/class (ruby).
3. Движок: **15 языков** (ts/tsx/js/mjs/cjs/py + go/rust/c/cpp/sh/java/csharp/kotlin/ruby/php/swift).

### v1.4 (беклог 3, 2026-09-24)
1. **Return-вызовы**: `firstReturnCall` (первое «return g()») + транзитивное разрешение
   fnReturns до 3 хопов (wrap → base → new Foo).
2. **Языки +3**: Dart (pairedBody! bare-ident вызовы), Scala (def qualified, call_expression),
   Lua (function_declaration с dot/method index, function_call, self:m()).
3. Движок: **18 языков**.

### v1.5 (беклог 4, 2026-09-24): auto-refresh deep
1. **Auto-deep в `build()`** (index.ts): при `!opts.deep` — если `hasDeep(root)` (deep.json
   не пуст) И `deepCfgFromEnv()` (GRFT_LLM_BASE_URL/MODEL) → инкрементальный deepBuild +
   conceptsBuild. Только изменившиеся bodyHash; **без дрейфа — 0 LLM-вызовов**.
   Выкл: `autoDeep: false` / env `GRFT_AUTO_DEEP=0`. `store.hasDeep`, `deep.deepCfgFromEnv` —
   новые экспорты.
2. **CLI watch**: auto-deep включён (через build); строка rebuild показывает
   `+N файлов/+M символов (кэш a/b)`; заголовок — подсказка про env.
3. Semантика: auto-deep = тихое обновление по дрейфу; `build deep` = явный полный проход.
4. **Live**: tmux-запуск `build .` с GRFT_LLM_* — «… auto-deep: инкрементальный deep
   (env-конфиг)» (перечитывает дрейф v1.1–v1.4, ~200+ символов, cat-vllm).
5. Тест 21-й: auto-deep (созданный дрейф → filesDone≥1 + LLM-вызовы; повтор → 0 вызовов;
   GRFT_AUTO_DEEP=0 → rep.deep undefined; в конце — восстановление main-fake summary,
   иначе карточки-тест ловит «Авто summary»).
6. **Live auto-deep (cat-vllm, 33 мин)**: дрейф v1.1–v1.4 → 15+109 новых, 17+290 кэш, 6 ошибок;
   8 реальных тем; retry 11с; сходимость 2.2с, 0 ошибок, 404/404 кэш. deep.json репо обновлён.

### v1.6 (беклог 5, 2026-09-24 — финал, БЭКЛОГ ЗАКРЫТ)
1. **Дженерики**: `typeOfAnnotation` (вместо returnTypeOf) — Promise/PromiseLike<T> → первый
   не-примитивный аргумент (PRIMITIVE_TYPES set); Promise<примитив> → null; Foo<T> → Foo.
2. **Типизированные локальные**: `collectParamTypes` (required/optional/formal_parameter —
   граммака TS 0.20+; type_annotation как named child БЕЗ fieldName!) → vars {kind:"type"};
   аннотация переменной (`const x: Foo`) ставится ПОСЛЕ value-инференса (authoritative).
3. **await**: variable_declarator value: await_expression → unwrap к argument.
4. PendingVia + kind "type"; resolveVia: type → сразу класс-имя.
5. Тесты: 21/21 (mkAsyncPair Promise<Pair>, useAsyncPair await, greet(g: Greeter), typedGreet).

### v2.0 (программа A–E от 2026-09-25, в работе; v2.0 ГОТОВО, тест 23/23)
Запрос пользователя: «все: A–E» (A автоматизация, B LSP+full-fidelity, C концепты+viz,
D языки+монорепо, E CLI/init). tmux НЕДОСТУПЕН (unknown flag -S) — работаю напрямую.
**v2.0 (A) — сделано:**
1. `refresh.ts`: fingerprint.json (size+mtime после build; GRFT_REFRESH=hash — sha1);
   `driftReport(root)` (git ls-files+stat, ~десятки мс); `ensureFresh(root)` — тихая
   пересборка при дрейфе (GRFT_NO_REFRESH=1 выкл; БЕЗ ttl-кэша — TTL глотал дрейф, баг);
   `enableAutoRebuild(fn, 4000)` — дебаунс-коалесер.
2. `scan.ts`: `isIndexablePath()` (единый фильтр scanRepo+refresh).
3. index.ts: build() пишет fingerprint; экспорты ensureFresh/driftReport/enableAutoRebuild/
   deepCoverage (доля символов с актуальным deep).
4. CLI: ask/grep/callers/skeleton/map/blast — ensureFresh; `check` — exit 1 при дрейфе
   (и --json); check НЕ авто-ресинчит (это и есть отчёт).
5. Расширение: ensureFresh во всех 7 тулзах + before_agent_start map; флаг
   `--graft-auto-rebuild` (def true) — после write/edit: бейдж «syncing…» + debounced build;
   бейдж: `graft: synced · N% deep` / `⚠ N stale · N% deep`; /graft — % deep.
6. MCP: ensureFresh перед каждым тулзом.
- Тесты: +refresh (fingerprint/ensureFresh/GRFT_NO_REFRESH), +CLI check exit 0/1 — 23/23.
- Live: zz-probe.ts → ask → тихий rebuild (builtAt сместился). AUTO-REFRESH-OK.
- **Остаток программы A–E: B5 LSP, B6 full-fidelity go/java/kt/php/swift, C7 концепт-узлы+Notes,
  C8 viz serve, D9 +7 языков (R/Elixir/Solidity/OCaml/Zig/Clojure/Nix), D10 monorepo-scope,
  E11 CLI UX (ask --json, blast --format/--name/--owners), E12 init/uninstall.**
- Патч-скрипт расшир. — /tmp/patchA.py (уже применён).

### v2.1 (D10 monorepo-scope) ГОТОВО, test 24/24 → после D9 25/25
- scan.ts: `detectScopes(paths)` — сабпроекты по маркерам (package.json/pyproject/
  Cargo.toml/go.mod/pom.xml/build.gradle в каталоге ≠ корню); scope → пути, корневые —
  "(root)". Пусто — только корневой маркер. ВАЖНО: вызывается на listRepoPaths (ВСЕ пути),
  не на code-файлы (маркеры не-кодовые!).
- types.ts Graph.meta.scopes?; build.ts заполняет; query.ts: ask — scope-fusion (глоб.
  топ-6 + топ-3 каждого scope, [scope] label), map — "scopes:" блок (files/symbols/hubs
  per scope), grep — named-scope (opts.scope = имя scope → фильтр по path-set, иначе
  prefix). Расширение graft_ask/graft_grep scope-param уже передаёт.
- Тест: monorepo fixture (packages/alpha+beta), scopes/ask-label/map/grep --in-scope.

### v2.2 (D9: +7 языков) ГОТОВО, test 25/25
- Языки: r(.R/.r), elixir(.ex/.exs), solidity(.sol), ocaml(.ml/.mli), zig(.zig),
  clojure(.clj/.cljs/.cljc), nix(.nix) — Lang union, LANG_BY_EXT, GRAMMAR(parse),
  OTHER_LANGS(extract.ts), RULES(extractOther).
- extractOther: break→continue (несколько правил под один node-type, напр. elixir
  defmodule/def); +helpers deepFirstIdent, pathIdent.
- Нюансы грамматик (wasm): R — имя fn = LHS binary_operator(<-) identifier; elixir —
  defmodule/def/defp = call-ноды (head identifier), qualified по enclosing defmodule;
  solidity — contract_declaration+function_definition, callee childForFieldName(function);
  ocaml — value_name ВЛОЖЕН в let_binding (глубже), callee value_path→pathIdent;
  zig — callee = plain identifier (walk передаёт уже identifier); clojure — (defn ...) =
  list_lit, callee head sym_lit (fn.type==="sym_lit"!), SPECIAL-фильтр; nix — топ-уровень
  в wasm глючит (ERROR), целиться в `binding` (attrset cfg={a=1;b=..}); nix-фикстура attrset.
- Тест: языки v2 (7 новых) — символы + вызовы (R run→helper, Elixir Math.add→Math.sub,
  Solidity App.run→App.calc, OCaml add→sub, zig/clojure run→helper, nix attrset).

### v2.3 (B6: full-fidelity go/java/kotlin/php/swift) ГОТОВО, test 25/25
- extractOther LangRules +memberCall (obj.m()→pending via ident) +varAssigns (тип-подсказки
  x=new T()/x:T/x:=NewT()); extractOther теперь возвращает РЕАЛЬНЫЕ vars+pending (были пустые).
- Правила: go selector_expression(short_var_decl, NewX()→X, &T{} comp lit), java
  method_invocation(local_variable_decl, new T), kotlin call_expression+navigation_expression
  (property_declaration val s=T()), php member_call_expression(assignment, new T), swift
  call_expression+navigation_expression (property_declaration let s=T()).
- **КРИТИЧНО**: build.ts globalMethods брал только kind==="method"; kotlin/swift методы —
  kind "function" (квалифицированы Cls.m) → member-вызовы не резолвились. Исправлено:
  kind method ИЛИ function.
- PHP парсится ТОЛЬКО с `<?php` тегом (иначе program>text = parse error).
- Тест: B6 full-fidelity (go/java/kt/php/swift: new + member).
- **Осталось в A–E: B5 LSP (opt-in --lsp), C7 концепт-узлы+Notes, C8 viz serve+live-reload,
  E11 CLI UX (ask --json, blast --format/--name/--owners/--export-viz), E12 init/uninstall.**

### v2.4 (B5/C7/C8/E11/E12) ГОТОВО, test 29/29 — программа A–E ЗАВЕРШЕНА (2026-09-25)
- **B5 LSP**: build → `graft/.engine/unresolved.json` (нерешённые member-вызовы с
  file/line/col/caller; PendingMemberCall +line/col в extract.ts + extractOther).
  `lsp.ts`: stdio LSP-клиент (JSON-RPC 2.0 + Content-Length): initialize→initialized→
  didOpen→textDocument/definition → рёбра confidence "lsp" (merge, дедуп).
  LSP_SERVERS: ts/js→typescript-language-server, py→pyright-langserver, go→gopls,
  rust→rust-analyzer, c/cpp→clangd (каждый с args: --stdio где надо; gopls/rust-analyzer
  без args). Без бинаря — отчёт + install-инструкция. CLI: lsp-status, lsp-sync.
  Живая: pyright (локальный node_modules/.bin — глобальный npm i -g упал, code -13) —
  fixture Box(Base), b.inherited() → edge use→Base (lsp) ✓.
  py: типизированные параметры (typed_parameter/parameter, type/dotted_name child) →
  vars {kind:"type"} — ИНАЧЕ py-кандидатов не генерировалось.
  findNodeAtLine: span.start===line → else inside (start<=line<=end).
- **C7**: Notes в карточках (маркеры <!-- graft:notes:begin/end -->, writeCards read→rm→
  rewrite+Notes; маркеры проставляются во ВСЕ карточки); concept-links: детерминированные
  по рёбрам (file→topic map, пары тем, счётчик, топ-20, type "uses") → deep.concepts.links
  (+ ConceptLink type; map deep — блок «связи:»).
- **C8**: viz.ts serveViz(root, port) — http: / (writeViz→read+RELOAD_SCRIPT перед </body>;
  live-reload: fetch /api/graph 5с, по hash — reload), /api/graph (readGraph JSON).
  CLI: `graft viz --serve [порт]` (def 8123). Live: curl 200 ✓.
- **E11**: ask --json (askJson в query.ts); blast: --format text|json|markdown,
  --no-owners (owner = git log -1 --format=%an на файл; null без owner-режима),
  --name (LLM-имена зон, deepConfigSoft + llmChat, JSON-массив), --export-viz <dir>
  (writeBlastViz: сабграф зон+зависимых нод → dir/index.html). blastData(base,{owners})
  в query.ts (git diff -U0 + git log).
- **E12**: wiring.ts initWiring/uninstallWiring — AGENTS.md секция (маркеры graft:begin/
  end, idempotent, dry-run) + .mcp.json mcpServers.graft (merge; uninstall только graft).
  CLI: init [--dry-run|--no-mcp], uninstall [-y] (без -y = dry-run).
  БАГ: нет AGENTS.md → agents="" (пишалось пусто); фикс: else-ветка agents = sec + "\n".
  БАГ: backticks в template literal секции (graft/, node ...) ломали TS-синтаксис —
  убрал backticks из текста.
- Тесты 29/29: +E11/E12 (CLI ask --json/blast formats/owners/export-viz/init/uninstall/
  idempotent/dry-run), +B5 (unresolved/lspStatus/lspSync-graceful), +C7 (notes-регенерация
  + links), +C8 (serveViz fetch /api/graph + html).
- Граф репо после: 35 файлов / 500 узлов / 489 рёбер; lsp-status: 659 ts + 282 js + 14 py
  кандидатов (серверы не установлены — install-подсказки).
- **Программа A–E завершена. Коммит — по команде пользователя.**

