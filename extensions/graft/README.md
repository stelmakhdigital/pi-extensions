# graft (расширение pi)

Локальный кодовый граф репо как источник контекста для агента: собственный движок
(`engine/graft/`, web-tree-sitter + wasm, без внешних CLI и LLM по умолчанию) и
тонкое расширение, которое встраивает его в pi — нативные инструменты вместо шелла,
авто-синхронизация, blast radius после правок.

## Требования

- Зависимости пакета: `web-tree-sitter`, `tree-sitter-wasm` (wasm-грамматики, ~25 языков).
  Расширение загружает движок через jiti — внешних CLI нет, spawn не используется.
- Построенный граф: `node engine/graft/bin/graft.mjs build` в корне репо
  (или `/graft build` в pi). LLM-слой (deep-суммаризация) опционален — см. ниже.
- Расширение работает только там, где выше cwd найден `graft/.engine/graph.json`;
  в остальных проектах — тихий no-op.

## Что даёт

| Возможность | Механизм |
|---|---|
| `graft_ask` | ранжированный запрос к графу (символы/ноды с file:line, детерминированный) |
| `graft_grep` | исчерпывающий regex по индексированным файлам, группировка по замыкающему символу |
| `graft_callers` | точные рёбра: кто использует символ (`in`, по умолчанию) / на что ссылается (`out`), глубина `depth` (число или `all` — полное замыкание) |
| `graft_skeleton` | все сигнатуры файла без тел (~10× дешевле чтения) |
| `graft_map` | ориентация в репо: кластеры каталогов, хабы, hotspots (+ `full`-опция — глубокие описания) |
| `graft_check` | отчёт свежести графа (JSON; при дрейфе exit 1) |
| `graft_blast` | blast radius git-диффа (`base`, напр. `origin/main`) |
| `<graft>`-секция системного промпта | при старте агента подмешивается `graft map`; кэш 2 мин, инвалидация при правках |
| Push-режим (`--graft-push`, **вкл по умолчанию**) | в секцию — топ-3 **указателя `file:line`** под промпт (без кода — свежая инъекция full-price, код через `graft_ask`); гейты: длина/слова, **coverage-скор** (сильный матч → указатели; слабые хиты → одноразовый нудж; без хитов → тишина), scope-хинт, сессионный dedup |
| Blast radius после write/edit | к результату тула дописывается «кто зависит от изменённых символов» |
| Авто-синхронизация | fingerprint (size+mtime) перед каждым запросом; тихая пересборка при дрейфе; после write/edit — debounced rebuild (флаг `--graft-auto-rebuild`, по умолчанию вкл) |
| Budget rebuild'а | rebuild дольше 10 c (`GRFT_REFRESH_TIMEOUT_MS`) не блокирует промпт/тул: ответ по старому графу + бейдж «syncing…», rebuild докручивается фоном (single-flight) |
| `ask --source` | `graft_ask {source: true}` / CLI `--source` / MCP: код span'а хита (≤8 строк) прямо в выдаче — без доп. чтения файла |
| Scope по правке | push-пакет в multi-scope репо подсвечивает скоуп последней правленой файлом (приоритетнее слов промпта) |
| Scope на всех командах | `--in <scope>` (CLI ask/grep/callers) и `scope` в `graft_ask`/`graft_callers`/MCP: именованный скоуп или префикс пути; пустой scope у callers — «зависимых нет, вне фильтра N» |
| Лимит результатов | `graft ask … -n N` / `graft_ask.limit` / MCP `n`: 1–50, дефолт 12 |
| Проза-ноды | `graft build --deep` генерирует нарратив «как это устроено» (10–20 строк, LLM, кэш по hash файлов темы) в `graft/prose/<slug>.md`; `ask` сам подсовывает совпавшие ноды; `graft prose` — список |
| Usage mix | Счётчик прямых source-reads (тул `read`; читы `graft/*` не считаются): строка «Usage mix: N% граф / M% прямой source-read» в `/graft stats` и в CLI `graft stats [--json]` (без графа и сети — локальный JSON последней сессии) |
| Сессионные метрики | `~/.local/state/pi-graft/metrics/<sessionId>.json` (calls/tokens; env `GRFT_STATE_DIR`); строка «Сессия: …» в `/graft`; если в ходе были savings без отчёта «🌱» — одноразовое напоминание в секции |
| Сводка экономии | `/graft stats` — по всем сессиям: сегодня / 7 дней / 30 дней / всего (вызовы + ≈токены); строка «Сводка за 7 дней» в обычный `/graft` |
| Compliance-tally | `/graft stats` показывает «🌱-отчёт в ответе: X из Y graft-ходов» (доля ходов, где модель отчиталась об экономии) |
| Фон-синк | после завершения хода — тихий `ensureFresh` + бейдж; строка свежести в заголовке секции `<graft>` |
| Бейдж в футере | `graft: synced · N% deep · ≈N tok saved` / `⚠ N stale · N% deep` / `graft: нет графа` |
| Tokens saved | retrieval-выводы (`ask`/`grep`/`skeleton`/`callers`) открываются строкой `[graft] tokens saved ≈ N` — оценка сэкономленных токенов против чтения покрытых файлов целиком (размеры из fingerprint, 4 символа/токен, строка только при ≥100 tok). Сессионная сумма — в бейдже; guideline просит закончить ответ строкой «🌱 graft сэкономил ~N токенов (M вызовов)» |
| Скилл `skills/graft` | в `pi.skills[]`: scenario-таблица тулов, правила экономики (map→ask→skeleton→read, не резать выводы, когда графа не хватает), отчёт об экономии |
| `/graft` | статус (путь графа, свежесть, флаги); `/graft build` — пересборка; `/graft build deep` — с LLM-суммаризацией |

## Флаги расширения

| Флаг | Назначение |
|---|---|
| `--graft-max-output` | максимум символов в ответе инструментов (или env `GRFT_MAX_OUTPUT`) |
| `--graft-push` | в `<graft>`-секцию добавлять и результаты `ask` по промпту |
| `--graft-auto-rebuild` | auto-rebuild графа после write/edit (def true) |

## LLM-провайдер (только для deep: `/graft build deep`, `build --deep`)

Deep — суммаризация файлов/символов и концепт-темы. Конфиг явный, без дефолтных
эндпоинтов (openai-chat-формат, `fetch`):

| Переменная | Назначение |
|---|---|
| `GRFT_LLM_BASE_URL` | …/v1 (OpenAI-совместимый: Ollama, vLLM, OpenRouter, Anthropic-прокси) |
| `GRFT_LLM_MODEL` | имя модели |
| `GRFT_LLM_API_KEY` | ключ (для локальных серверов — любое значение) |

Пример (локальный vLLM): `GRFT_LLM_BASE_URL=http://127.0.0.1:8000/v1 GRFT_LLM_MODEL=qwen GRFT_LLM_API_KEY=dummy`.
Без `GRFT_LLM_BASE_URL`/`GRFT_LLM_MODEL` — deep честно отказывается работать.
Auto-deep (инкрементальный deep при обычной пересборке, если deep уже был)
управляется тем же конфигом; выкл: `GRFT_AUTO_DEEP=0`.

## Переменные окружения движка

| Переменная | Назначение |
|---|---|
| `GRFT_NO_REFRESH=1` | не автопересобирать граф перед запросами (fingerprint-проверка) |
| `GRFT_AUTO_DEEP=0` | выключить auto-deep при структурной пересборке |
| `GRFT_MAX_OUTPUT` | лимит вывода инструментов (если флаг не задан) |
| `GRFT_MCP_ROOT` | корень репо для MCP-сервера (иначе — cwd) |

## Graft CLI — `node engine/graft/bin/graft.mjs`

| Команда | Назначение |
|---|---|
| `build [--deep]` | пересборка (+ LLM-суммаризация при `--deep`) |
| `map`, `ask <q> [--json]`, `grep <re>`, `callers <sym>`, `skeleton <file>` | запросы к графу (авто-ресинк перед каждым) |
| `check [--json]` | дрейф графа; **exit 1 при дрейфе** (CI-friendly) |
| `blast [base]` | blast radius git-диффа; `--format text\|json\|markdown`, `--no-owners`, `--name` (LLM-имена зон), `--export-viz <dir>` |
| `viz [--serve [порт]]` | статичный `graft/viz.html` (SVG) или HTTP-сервер: `/` (live-reload каждые 5с) + `/api/graph` |
| `lsp-status`, `lsp-sync` | нерешённые member-вызовы → LSP goToDefinition → рёбра `confidence: "lsp"` |
| `init [--dry-run] [--no-mcp]` | секция в `AGENTS.md` (маркеры, идемпотентно) + `mcpServers.graft` в `.mcp.json` |
| `uninstall [-y]` | убрать секцию и MCP-запись (без `-y` — dry-run) |

### LSP (опционально)

Статический путь (tree-sitter) покрывает прямые вызовы; наследование/динамика остаются
в `graft/.engine/unresolved.json`. `lsp-sync` прогоняет их через LSP-сервер
(goToDefinition) и добавляет рёбра. Серверы ставятся по желанию (отчёт — `lsp-status`):
ts/js — `npm i -g typescript-language-server typescript`; py — `npm i -g pyright`;
go — `go install golang.org/x/tools/gopls@latest`; rust — `cargo install rust-analyzer`;
c/cpp — clangd.

## MCP-сервер

`node engine/graft/bin/graft-mcp.mjs` (stdio, JSON-RPC 2.0): 7 инструментов (ask, grep,
callers, skeleton, map, check, blast). Регистрация в pi/Claude:
`"graft": { "command": "node", "args": ["<путь>/graft-mcp.mjs"], "env": { "GRFT_MCP_ROOT": "<корень репо>" } }`
(или `graft init` — впишет в `.mcp.json` сам).
