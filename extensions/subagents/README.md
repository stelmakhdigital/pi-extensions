# subagents

Асинхронное управление подагентами: спавн в панели tmux, live-статус в виджете,
автоматический возврат результата в основную сессию (steer-сообщение), resume и interrupt.

Расширение полностью неблокирующее: `spawn_agent` возвращает управление сразу,
подагент работает в собственной панели tmux, а результат приходит в основную
сессию самостоятельно (новым ходом) — опрашивать статус не нужно.

## Требования

- tmux 3.x, pi запущен **внутри** tmux: `tmux new -A -s pi 'pi'`
  (рекомендуется `set -g extended-keys on` + `set -g extended-keys-format csi-u` в tmux.conf).
- Если pi запущен вне tmux — при старте расширение предложит перезапустить pi
  внутри tmux с продолжением сессии (handoff, см. ниже).

## Установка

Часть пакета pi-extensions (целиком или фильтром):

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/subagents/*"]
		}
	]
}
```

После установки — `/reload` (или перезапуск pi).

## Инструменты

| Инструмент | Назначение |
|---|---|
| `spawn_agent` | Спавн подагента в панели tmux (async, мгновенный возврат) |
| `agents_list` | Определения агентов (`.pi/agents/*.md` + `~/.pi/agent/agents/*.md`) |
| `interrupt_agent` | Отмена текущего хода (Escape в панель); сессия остаётся живой |
| `resume_agent` | Продолжить сессию подагента (по файлу .jsonl), опционально с сообщением |

Параметры `spawn_agent`: `task` (обяз.), `name`, `agent` (definition), `fork`
(полный контекст диалога), `interactive`, `model`, `thinking`, `systemPrompt`,
`skills` (через запятую), `tools` (allowlist), `cwd`.

Параллельный спавн — обычный вызов несколько `spawn_agent`; все панели работают
конкурентно, результаты приносят независимо.

В дочерней сессии доступны свои инструменты `agent_done` (явное завершение) и
`agent_ping` (вопрос родителю; родитель отвечает через `resume_agent`).
Рекурсивный спавн исключён: родительские инструменты в детях не регистрируются.

## Команда

```
/spawn [agent] <task...>
```

Без аргументов — интерактивный выбор агента и ввод задачи.

## Как это работает

1. Родитель создаёт **детерминированный файл сессии** ребёнка
   (`~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`) и launch-скрипт
   (артефакты — в каталоге сессии, пригодны для отладки).
2. tmux: правый сплит панели родителя (`split-window -d -h -t $TMUX_PANE`,
   фокус не крадётся), окно переименовывается в имя агента.
3. Запуск — только через launch-скрипт (`send-keys -l "bash <скрипт>"`) —
   без shell-эскейпинга.
4. Ребёнок пишет снапшоты активности (throttle 500ms) — по ним родитель
   классифицирует `starting / active · <tool> / waiting / stalled`.
5. Завершение: sidecar `<file>.exit` (done/ping/error) — fast path;
   исчезновение панели без sidecar — crash path; sentinel
   `__SUBAGENT_EXIT_$?` в экране — запасной детект.
6. Результат (последний assistant-сообщение ребёнка + метаданные) прилетает в
   основную сессию steer-сообщением с карточкой: статус, время, путь к сессии,
   команда `pi --resume <file>`. `Ctrl+O` — развернуть.

## Режимы сессии

- `standalone` (дефолт) — чистая сессия;
- `lineage` — чистая сессия со связью `parentSession`;
- `fork` — копия текущего диалога родителя (override `fork: true` в вызове).

## Определения агентов

`.pi/agents/<name>.md` (проект, приоритет) и `~/.pi/agent/agents/<name>.md`
(глобально). Тело файла — системный промпт/роль; frontmatter:

```yaml
---
name: scout
description: Быстрая разведка кодовой базы
model: anthropic/claude-haiku
thinking: minimal
tools: read, bash
skills: some-skill
session-mode: lineage-only   # standalone | lineage | fork
auto-exit: true              # самозакрытие после хода; ручной ввод отключает
interactive: false           # по умолчанию ¬auto-exit
cwd: subdir                  # rel к проекту или abs
---
```

## Конфигурация

Приоритет: defaults → `~/.pi/agent/subagents.json` → `<cwd>/.pi/subagents.json`
(только trusted-проекты) → env.

```jsonc
{
	"tmux": {
		"handoff": "ask",            // "ask" | "auto" | "never"
		"sessionName": "pi",         // имя tmux-сессии для handoff
		"sessionCommand": "pi -c",   // команда нового pi (продолжить сессию)
		"shellReadyMs": 700          // задержка готовности shell в новой панели
	},
	"limits": { "maxConcurrent": 6 },
	"watch": { "intervalMs": 1000 },
	"watchdog": { "snapshotStaleMs": 30000 },
	"widget": { "enabled": true },
	"cleanup": { "killSurfaceOnExit": true, "keepOnError": true },
	"child": { "extensions": "none" }
}
```

- `child.extensions` — окружение субагента: `"none"` (дефолт) — детерминированный
  ребёнок без глобальных расширений (`--no-extensions`): глобальные расширения могут
  блокировать ход ребёнка (trust-диалоги, интерактивные промпты) и дают поверхность
  рекурсии; `"all"` — глобальные расширения доступны (если субагенту нужны твои тулзы).

- `tmux.handoff` — поведение при старте pi **вне** tmux: `ask` — спросить
  (вариант «Never ask again» запишет `never`), `auto` — перезапустить сразу,
  `never` — молчать. Механика: `tmux new-session -A -s pi 'pi -c'` + graceful
  shutdown текущего процесса — сессия продолжается внутри tmux.
- env-оверрайды: `PI_SUBAGENTS_HANDOFF=ask|auto|never`,
  `PI_SUBAGENTS_MAX_CONCURRENT=N`, `PI_SUBAGENTS_STALL_MS=N`,
  `PI_SUBAGENTS_SHELL_READY_MS=N`, `PI_SUBAGENTS_DISABLED=1`.
- Флаг CLI: `--subagents-disabled` (аварийный отбой на запуск).

## Watchdog

Снапшот старше `snapshotStaleMs` (30 с), если ребёнок «залип» в работе,
помечает `stalled` + уведомление. Тихий «waiting» (ход завершён, сессия открыта)
ложным stall не считается. Повторный stall — повторный пинг; восстановление —
тихо (виджет).

## Тестирование

```bash
node test/subagents.test.mjs   # unit: конфиг, definitions, seed-режимы, tmux-команды (fake runner), watchdog
node test/smoke.test.mjs       # smoke: загрузка index.ts/child.ts через jiti
```

Интеграционный чек-лист выполнен 2026-09-24 (tmux 3.6, локальная LLM): пункты 1–7
пройдены; пойманы и исправлены три интеграционных бага — path-дубль в seed-файле
(`sessionsRootFor`), auto-exit отключался первым промптом (`sawAgentStart`), TOCTOU-гонка
лимита (синхронное резервирование слота) + handoff без `-d` не создавал сессию.

Ручной интеграционный чек-лист:

1. В tmux: `spawn_agent {agent: <echo-агент>, task}` → виджет
   starting → active → done; карточка результата со steer.
2. `interrupt_agent` — ход прерван, панель жива, статус waiting.
3. `resume_agent` по файлу сессии — диалог продолжается; ответ на `agent_ping`.
4. Заполнить `maxConcurrent` — 7-й спавн получает ошибку-лимит.
5. Килльнеть панели (`tmux kill-pane`) — error-карточка «surface disappeared».
6. Запуск pi вне tmux → handoff-диалог → перезапуск внутри tmux → сплиты работают.
7. `PI_SUBAGENTS_DISABLED=1` / `--subagents-disabled` — spawn возвращает «disabled».

## Устранение неполадок

- `PI_SUBAGENTS_DEBUG_LOG=<file>` (у child) — лог обработанных событий child-расширения
  (для отладки auto-exit/sidecar).
- Артефакты запуска (launch-скрипт, system prompt, activity-снапшот) лежат в
  `<sessionDir>/artifacts/<childId>/` — launch-скрипт можно перезапустить вручную
  (`bash launch.sh`) и смотреть, что именно запускается.
- Если child завис «в диалоге» — это глобальные расширения: уберите их из child
  (`child.extensions: "none"`, дефолт) или ответьте в панели вручную.

## Ограничения (v1)

- Только tmux; интерфейс `MuxBackend` заложен под будущие бэкенды.
- `--tools` (allowlist) сужает и расширения — child-инструменты
  (`agent_done`, `agent_ping`) добавляются в список автоматически.
- Detached-хост-сессия как альтернатива handoff — в бэклоге.
