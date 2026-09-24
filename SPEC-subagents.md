# SPEC — расширение Subagents (v1, дизайн)

Статус: на согласовании. Контекст и решения — в PROJECT_MEMORY.md, этапы — roadmap.md.
Все факты API/форматов проверены против pi 0.87.0 (dist/types + docs + живые сессии).

## 1. Назначение

Асинхронное управление подагентами из основной pi-сессии: спавн в сплите текущего
окна tmux (панели рядом), live-статус в виджете, возврат результата
steer-сообщением, resume и interrupt. Только tmux; бэкенд-абстракция под будущие
мультиплексоры. Если pi запущен вне tmux — handoff при старте: предлагается (или
по конфиг `auto`) перезапустить pi внутри tmux с продолжением сессии.
Вне tmux (без handoff) spawn возвращает ошибку-инструкцию.

## 2. Состав

### Инструменты (родительская сессия)
| Инструмент | Назначение | Параметры (typebox) |
|---|---|---|
| `spawn_agent` | Спавн подагента (async, мгновенный возврат) | `task` (req), `name?`, `agent?`, `fork?`, `interactive?`, `model?`, `thinking?`, `systemPrompt?`, `skills?`, `tools?`, `cwd?` |
| `agents_list` | Определения агентов (`.pi/agents/*.md` + `~/.pi/agent/agents/*.md` + bundled planner/scout/worker/reviewer) | — |
| `interrupt_agent` | Отмена текущего хода (Escape в поверхность) | `id?` / `name?` (мин. один) |
| `resume_agent` | Возобновление завершённой сессии подагента | `sessionPath` (req), `name?`, `message?`, `autoExit?` |

promptSnippet/guidelines: не опрашивать статус (polling запрещён) — результат приходит
сам steer-сообщением; параллельный спавн допустим; после вызова — ждать steer,
не выдумывать результат.

### Инструменты (только в дочерней сессии, грузятся через `-e child.ts`)
| Инструмент | Действие |
|---|---|
| `agent_done` | Эксплицитное завершение: пишет sidecar `.exit`, завершает сессию |
| `agent_ping` | Вопрос родителю: пишет sidecar (type ping), завершает; родитель отвечает через `resume_agent` |

Дочерний режим определяется env `PI_SUBAGENTS_CHILD_ID`. Родительское расширение в
детях НЕ регистрирует ничего (ранний выход по тому же env) — защита от рекурсивного
спавна и конфликта имён. Исключение — opt-in `spawning: true` в определении агента:
launch-скрипт грузит у ребёнка и `index.ts` (второй `-e`), ставит env
`PI_SUBAGENTS_SPAWNING=1` и не исключает parent-тулзы — такой агент может спавнить
внуков (steer-результаты внуков приходят в сессию агента, а не в корневой родитель).

### Команды (пользователь)
`/spawn [agent] <task...>` — ручной спавн; при пустых аргументах — интерактивный
запрос (ui.input/select по agent-definitions).
v2: `/iterate [agent] <task...>` — спавн с fork текущей сессии (ребёнок видит весь
контекст разговора); `/plan <task...>` — фазовый workflow planner→worker→reviewer
(см. раздел v2); `/subagents doctor` — self-check окружения (отчёт сообщением).

## 3. Архитектура

```
extensions/subagents/
  index.ts         # родитель: инструменты, /spawn, watch-цикл, виджет, steer-результат
  child.ts         # ребёнок: agent_done, agent_ping, снапшоты активности, авто-exit
  types.ts         # MuxBackend, SurfaceRef, ActivitySnapshot, ResultDetails, конфиг
  backend.ts       # выбор/регистрация бэкенда (конфиг; v1: только tmux)
  tmux-backend.ts  # реализация tmux; exec через injectable runner(args[]) (unit-тесты)
  agents.ts        # discovery + frontmatter agent-definitions
  config.ts        # merge: defaults < global < project < env; валидация
  session.ts       # детерминированный путь файла сессии, seed: standalone/lineage/fork
  README.md
test/subagents.test.mjs   # unit: config, agents, session-seed, tmux-команды (fake runner),
                          #   интерпретация .exit/sentinel
test/smoke.test.mjs       # + загрузка index.ts и child.ts через jiti-стаб
```

### MuxBackend (контракт)
```ts
interface MuxBackend {
  id: string;                                  // "tmux"
  probe(): Promise<{ ok: boolean; detail?: string }>;
  createSurface(opts: { name: string; cwd?: string }): Promise<SurfaceRef>;
  sendCommand(surface: SurfaceRef, scriptPath: string): Promise<void>;
  sendEscape(surface: SurfaceRef): Promise<void>;
  isAlive(surface: SurfaceRef): Promise<boolean>;
  captureTail(surface: SurfaceRef, lines?: number): Promise<string>;
  rename(surface: SurfaceRef, title: string): Promise<void>;
  close(surface: SurfaceRef): Promise<void>;
  batchStatus(surfaces: SurfaceRef[]): Promise<Map<string, boolean>>; // ОДИН tmux-вызов
}
type SurfaceRef = { kind: "pane" | "window"; target: string; session?: string };
```
Реестр в backend.ts: `registerBackend(impl)` + `getBackend(config)`. Новый бэкенд =
новый файл + одна строка регистрации; поведение выбирается конфигом/конфигурируется.

### tmux-реализация (проверено: tmux 3.6)
- Только pane-стратегия: `split-window -d -h -t $TMUX_PANE -P -F "#{window_id} #{pane_id}"`
  (цель — панель родителя, а не фокус пользователя); `rename-window` именем агента.
  Вне tmux (TMUX-env пуст / бинарника нет) → spawn возвращает ошибку с инструкцией
  «запусти pi внутри tmux: tmux new -A -s pi 'pi'».
- **Handoff при старте**: при `session_start` (TUI-режим, не в tmux, нет guard-env)
  по `tmux.handoff`:
  - `"ask"` (дефолт): ui.select с тремя опциями: «Restart pi inside tmux
    (session continues, attach: tmux a -t <sessionName>)» / «Not now» /
    «Never ask again» (последняя → пишется `"tmux":{"handoff":"never"}` в
    `~/.pi/agent/subagents.json`).
  - `"auto"`: handoff сразу, без диалога.
  - `"never"`: молчим.
  Механика: `spawn(bash, ["-c", "sleep 0.3; exec env PI_SUBAGENTS_TMUX_HANDOFF=1
  tmux new-session -d -A -s <name> '<cmd>'"], {stdio:"inherit", detached:true})` +
  guard-env (анти-цикл) + `ctx.shutdown()`. Флаг `-d` обязателен: без него tmux
  пытается прицепить клиента к терминалу, которым ещё владеет старый pi, и
  сессия не создаётся (проверено в интеграции). Команда по умолчанию —
  `pi --session <текущий файл сессии>` (детерминированное продолжение именно этой
  сессии), при отсутствии файла — `tmux.sessionCommand` (дефолт `pi -c`).
  Пользователь прицепляется: `tmux a -t pi`.
- `sendCommand`: запуск ИСКЛЮЧИТЕЛЬНО через launch-скрипт (artifacts-директория):
  `send-keys -l -t <t> "bash <script>"` + `send-keys Enter`. Скрипт = чистый массив
  строк (cd, env, `exec pi ...`, echo sentinel) — ноль shell-эскейпинга, артефакт
  остаётся для отладки.
- alive/batch: `list-panes -s -F "#{window_id} #{pane_id}"` (один вызов на тик).
- sentinel завершения: скрипт оканчивается `; echo "__SUBAGENT_EXIT_$?"__`;
  fallback-детект через `capture-pane -p -t <t> -S -5`.

### Сессии ребёнка (формат проверен по dist + живым файлам)
- Путь: `~/.pi/agent/sessions/--<cwd с / → -->/<ISOZ>_<uuid>.jsonl` (правило pi:
  leading `/` срезается, `/\\: → -`). Родитель сам создаёт файл (все режимы) и
  передаёт `pi --session <путь>` — детерминированный, гонок нет.
- Header v3: `{"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}`.
- Режимы (`agent`-frontmatter `session-mode`, override `fork: true` в вызове):
  - `standalone` — только header (новый id).
  - `lineage` — header + `parentSession: <путь сессии родителя>`.
  - `fork` — header + копии записей активного ветвления родителя
    (`ctx.sessionManager.getBranch()`, без старого header); id записей сохраняются.
- Запуск ребёнка (строки скрипта):
  ```
  cd <childCwd>
  PI_SUBAGENTS_CHILD_ID=<id> PI_SUBAGENTS_ACTIVITY_FILE=<abs> \
  PI_SUBAGENTS_SESSION_FILE=<childFile> \
  exec pi --session <childFile> -e <ext>/child.ts
       [--model <m[:thinking>]] [--tools <allowlist + agent_done,agent_ping>]
       [--append-system-prompt <file>] -- <task[/skill-префиксы]>
  ; echo "__SUBAGENT_EXIT_$?"__
  ```
  Скиллы — как prompt-аргументы `/skill:<name>` перед задачей. System prompt —
  во временный файл (флаг принимает путь) — без экранирования.
- **Детерминированное окружение ребёнка**: по умолчанию `--no-extensions` (конфиг
  `child.extensions: "none" | "all"`, дефолт `none`). Глобальные расширения могут
  блокировать ход ребёнка (trust-диалоги, интерактивные промпты) и являются
  поверхностью рекурсии; проверено в интеграции (sandbox-trust останавливал child).
  Скиллы/тулзы глобальных расширений в этом режиме субагенту недоступны —
  осознанный trade-off (детерминизм > богатство окружения).

### Снапшот активности (child → JSON-файл, throttle ~500ms, atomic rename)
```json
{ "v":1, "childId":"<id>", "seq":17, "ts":1700000000000,
  "phase":"starting|active|waiting|done",
  "agentActive":true, "turnActive":true, "providerActive":false,
  "toolActive":true, "toolName":"bash" }
```
События: session_start/input/agent_start/agent_end/turn_start/turn_end/
before_provider_request/after_provider_response/message_update/
tool_execution_start/tool_result/tool_execution_end/agent_done/agent_ping/
session_shutdown. Parent classifies: `starting` (нет снапшота), `active`
(любой active-флаг), `waiting` (ход завершён, сессия жива), `stalled`
(снапшот старше `watchdog.snapshotStaleMs`, дефолт 30s, и фаза не done).
`stalled` → один steer-пинг родителю (только для non-interactive; interactive-агенты
молчат — пользователь работает в панели). Recover — только виджет, без пинга.

### Завершение и результат
- Fast path: sidecar `<childFile>.exit` = `{"type":"done"|"ping"|"error","exitCode",
  "ping"?,"errorMessage"?}` (пишет child: agent_done/agent_ping/auto-exit/ошибка хода).
- Slow path: sentinel `__SUBAGENT_EXIT_<code>__` в captureTail (крэш/kill).
- Summary: последний assistant-текст из jsonl сессии ребёнка; при ошибке хода —
  её errorMessage (не притворяться успехом).
- Steer: `pi.sendMessage({customType:"subagents.result", content:"Подагент X завершён:
  <summary>", display:true, details:{name,id,status,exitCode,elapsedMs,sessionFile,
  ping?,errorMessage?}}, {triggerTurn:true, deliverAs:"steer"})` +
  `pi.registerMessageRenderer("subagents.result")` — карточка со статусом, временем,
  путём к сессии и командой `pi --resume <file>`.
- ping-результат: «Подагент X просит помощи: <msg> + sessionFile» (родитель отвечает
  resume_agent).
- Cleanup: `close(surface)` при завершении, если `cleanup.killSurfaceOnExit` (дефолт
  true); при ошибке — если `cleanup.keepOnError` (дефолт true) поверхность живёт.

### Watch-цикл (улучшение против N процессов на тик)
Один `setInterval(watch.intervalMs, 1000)` на всех бегущих:
1. `batchStatus` — один tmux-вызов для всех поверхностей;
2. чтение `.exit`-sidecar и снапшотов — из fs (дешево);
3. обновление статусов, виджет (только при изменении), watchdog, steer по завершении.
Никаких per-agent execFileSync.

### Виджет
`ctx.ui.setWidget("subagents", lines | undefined)`:
```
╭─ Subagents — 2 running ─────────────────────────────────╮
│ 00:23  Scout: Auth (scout)  active · bash · 12.3k tok   │
│ 01:45  Worker (worker)       waiting · 45.1k tok $0.01 │
╰──────────────────────────────────────────────────────────╯
```
Обновление на тике; `undefined` при пусто. v2: счётчик токенов/стоимости —
инкрементальный parse usage-записей из jsonl сессии ребёнка (offset, только хвост),
каждый тик; итог дублируется в steer-карточке (финальный read от 0).

## 4. Конфигурация

Источники (растущий приоритет): defaults → `~/.pi/agent/subagents.json` →
`<cwd>/.pi/subagents.json` (только при trusted project, `ctx.isProjectTrusted()`) →
env. env-оверрайды: `PI_SUBAGENTS_DISABLED=1`, `PI_SUBAGENTS_HANDOFF=ask|auto|never`,
`PI_SUBAGENTS_MAX_CONCURRENT=N`, `PI_SUBAGENTS_STALL_MS=N`.
Флаг CLI: `--subagents-disabled` (registerFlag) — аварийный отбой.

```jsonc
{
  "tmux":   { "handoff": "ask", "sessionName": "pi", "sessionCommand": "pi -c", "shellReadyMs": 700 },
  "limits": { "maxConcurrent": 6 },
  "watch":  { "intervalMs": 1000 },
  "watchdog": { "snapshotStaleMs": 30000 },
  "widget": { "enabled": true },
  "cleanup": { "killSurfaceOnExit": true, "keepOnError": true },
  "child": { "extensions": "none" }
}
```
- `tmux.handoff`: `"ask" | "auto" | "never"` — поведение при старте pi вне tmux.
- `tmux.sessionName` / `sessionCommand` — имя сессии и команда нового pi при handoff
  (дефолт `pi -c` — продолжить последнюю сессию cwd; в v2 handoff использует явный
  `pi --session <файл текущей сессии>`, если файл существует).
- `child.extensions` — `"none"` (дефолт, `--no-extensions` у ребёнка) / `"all"`.
- `tmux.shellReadyMs` — v2: МАКСИМАЛЬНОЕ ожидание готовности shell перед send-ом
  launch-команды (умный shell-ready: capture-pane-поллинг 125ms до маркера промпта —
  последний непустой символ из `$ > ❯ # %`; по таймауту — send всё равно). 0 —
  ждать не вообще.

## 5. Agent-definitions

`.pi/agents/*.md` (проект) > `~/.pi/agent/agents/*.md` (глобально) >
`extensions/subagents/agents/*.md` (bundled: planner/scout/worker/reviewer). Тело
файла — системный промпт/роль; frontmatter:
`name, description, model, thinking, tools (allowlist), skills, session-mode
(standalone|lineage|fork), auto-exit (bool), interactive (bool, по умолчанию
¬auto-exit), cwd (rel/abs), deny-tools (список через запятую), spawning (bool)`.
`auto-exit`: после нормального конца хода child сам пишет .exit и выходит;
ручной ввод в панели отключает auto-exit (забирает управление). Первый
task-промпт тоже приходит как input-событие, но до `agent_start` — поэтому он
auto-exit НЕ отключает (guard `sawAgentStart`; без него auto-exit не работал
никогда — баг, пойманный в интеграции).
`deny-tools`: добавляется к `--exclude-tools` (для всех агентов, включая spawning).
`spawning: true`: агенту разрешён рекурсивный спавн — у child грузится и parent-
расширение, parent-тулзы не исключаются, env PI_SUBAGENTS_SPAWNING=1. Без флага
детям всегда `--exclude-tools` родительские spawn/agents_list/interrupt/resume
(рекурсия запрещена по умолчанию).

## 5a. v2-добавления (2026-09-24)

1. **Токены/стоимость** — см. раздел «Виджет»; в steer-details: `tokens {input,
   output, total}` + `costUsd` (финальный read), в expanded-рендере — строка Tokens.
2. **`/subagents doctor`** — self-check: tmux-бинарник/версия, в tmux ли pi
   (TMUX_PANE), сервер (list-panes), pi CLI --version, disabled-флаг, конфиг
   (источники + эффективные значения), agent-definitions (счёт по source),
   родительский session-файл, child-mode/guard-env. Отчёт — custom-сообщение
   `subagents.report` (display, без triggerTurn) + ui.notify со счётчиком проблем.
   Чистая часть (`renderDoctorReport`) — unit-тестируема.
3. **Умный shell-ready** — `waitForShellReady(backend, surface, timeoutMs, pollMs=125)`:
   capture-pane(-6 строк) → последний непустой ряд; если заканчивается на `$ > ❯ # %` —
   shell готов. По таймауту (timeoutMs = tmux.shellReadyMs) send всё равно (best-effort;
   краш покрывается sentinel/crash-путями).
4. **`/iterate [agent] <task...>`** — `spawnAgentInternal({fork: true, ...})`: ребёнок
   стартует с копией ветви текущей сессии (полный контекст разговора). Без agent-definitions
   — дефолтный ITERATE_PROMPT (системный промпт «работаешь на форке, примени задачу,
   отчитайся»). Окно называется `iterate`.
5. **`/plan <task...>`** — фазовый workflow: (1) расширение сразу спавнит planner
   (bundled/planner или fallback-промпт) с задачей «Plan (do NOT implement)»; (2)
   шлёт родителю steer-инструкцию (customType subagents.report, triggerTurn) — она
   заставляет модель запускать фазы 2/3 (worker с планом) и 3/3 (reviewer) по мере
   прихода steer-результатов, а затем давать финальную сводку. Окна именованы
   `plan: planner/worker/reviewer`. Фазы исполняет МОДЕЛЬ (не код) — осознанный
   выбор: цепочки async-результатов в коде расширения не выразимы без polling.
6. **Bundled-агенты** — 4 файла в `extensions/subagents/agents/`: planner (read-only,
   план ≤ 60 строк), scout (read-only разведка с file:line), worker (реализация плана,
   тесты, без коммитов), reviewer (ревью diff, вердикт). Все: standalone + auto-exit.
7. **spawning / deny-tools** — см. раздел 5.

## 6. Обработка ошибок
- tmux/бэкенд недоступен → spawn возвращает error-текст с инструкцией (запустить
  pi внутри tmux; handoff в конфиге), details {error:"backend-unavailable"}.
- Ошибка child-хода (stopReason=error) → sidecar type=error → steer с ошибкой.
- Лимит `limits.maxConcurrent`: code `"limit"`. Слот резервируется синхронно
  (проверка + `running.set` ДО первого await) — иначе параллельные вызовы
  инструмента проходят проверку по устаревшему счётчику (TOCTOU-гонка, поймана
  в интеграции: 3 спавна в параллельной пачке все прошли при лимите 2).
  `resume_agent` тоже учитывается лимитом.
- Киль родителя: `session_shutdown` → close всех поверхностей (best-effort),
  очистка интервалов.
- Все таймеры/интервалы — unref; никаких висящих процессов после /quit.

## 7. Тестирование
- Unit (`test/subagents.test.mjs`): merge/валидация конфига; парсинг frontmatter и
  приоритеты discovery; seed всех 3 режимов (реальный header + branch-копия из
  фикстур); сборка tmux-команд через fake runner (pane/alive/capture/close/escape —
  assert массивы аргументов); интерпретация .exit и sentinel;
  классификация watchdog (starting/active/waiting/stalled).
- Smoke: загрузка index.ts и child.ts через jiti со стаб-ExtensionAPI (регистрация
  4+1 инструментов, команда /spawn, флаг).
- Интеграция (ручной чек-лист в README): spawn echo-агента в tmux → виджет
  starting→active→waiting → .exit → steer-карточка; interrupt (Escape); resume
  с продолжением диалога; maxConcurrent; handoff (pi вне tmux → ask/auto →
  pi -c внутри tmux, сплиты работают).

## 8. Ограничения/риск-лист (честно)
- Путь каталога сессий `~/.pi/agent/sessions/--<path>--` — правило pi 0.87.0;
  при смене home/pi-дистрибутива (CONFIG_DIR_NAME) — учесть (константа есть в API).
- `--tools` allowlist сужает и расширения — поэтому к списку из frontmatter
  всегда добавляем `agent_done,agent_ping` (проверить в интеграции).
- Handoff: `pi -c` берёт последнюю сессию cwd (обычно — текущую); если tmux-сессия
  с именем `pi` уже существует, `-A` прилипнет к ней (имя — в конфиге);
  flicker экрана при переходе. Всё — в ручном интеграционном тесте.
- Параллельные spawn в один тик: детерминированные файлы исключают гонки;
  tmux-команды синхронные (execFileSync в runner) — порядок гарантирован.

## 10. Вне v2 (бэклог)
detached-хост-сессия как альтернатива handoff; другие бэкенды поверх MuxBackend;
повторные stall-пинги; /plan-фаза «test». 
