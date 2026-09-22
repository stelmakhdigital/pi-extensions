# graft (расширение pi)

Глубокая интеграция [Graft](https://github.com/trailhq/Graft) (`@nanonets/graft`)
в pi: кодовый граф репо как источник контекста для агента — нативные инструменты
вместо шелла, автоматическая синхронизация, blast radius после правок.

## Требования

- CLI: `npm i -g @nanonets/graft` (или расширение само использует
  `npx -y @nanonets/graft`; переопределить можно через `GRAFT_CMD`).
- Построенный граф: `graft build` в корне репо (tree-sitter, без LLM-ключей, $0).
  LLM-слой (`graft build --deep`) опционален: `GRAFT_PROVIDER`,
  `GRAFT_API_KEY`, `GRAFT_MODEL`, `GRAFT_BASE_URL`.
- Расширение работает только там, где выше cwd найден каталог `graft/`;
  в остальных проектах — тихий no-op. В дочерние процессы ставится
  `DO_NOT_TRACK=1` (без телеметрии).

## Что даёт

| Возможность | Механизм |
|---|---|
| `graft_ask` | ранжированный запрос к графу (символы/ноды с file:line, детерминированный) |
| `graft_grep` | исчерпывающий regex по индексированным файлам, группировка по замыкающему символу |
| `graft_callers` | точные рёбра: кто использует символ (`in`, по умолчанию) / на что ссылается (`out`), глубина `-d N` |
| `graft_skeleton` | все сигнатуры файла без тел (~10× дешевле чтения) |
| `graft_map` | ориентация в репо: кластеры каталогов, хабы, hotspots |
| `graft_check` | отчёт свежести графа (JSON) |
| `graft_blast` | blast radius git-диффа (`--base origin/main` и т.п.) |
| `<graft>`-секция системного промпта | при каждом промпте (before_agent_start) подмешивается `graft map`; кэш 2 мин, инвалидация при правках |
| Push-режим (`--graft-push`) | дополнительно `graft ask "<промпт>"`, топ-хиты — в ту же секцию |
| Blast radius после write/edit | к результату тула дописывается «кто зависит от изменённых символов» (skeleton → callers по первым 3 символам), + уведомление |
| Бейдж в футере | `graft: synced` / `graft: ⚠ N stale` / `graft: нет графа` (graft check --json), обновление при старте сессии и после хуков |
| `/graft` | статус (CLI, путь графа, свежесть, флаги); `/graft build` — пересборка; `/graft build deep` — с LLM-суммаризацией |

## Флаги

| Флаг | По умолчанию | Назначение |
|---|---|---|
| `--graft` | true | Мастер-включатель (автоматически неактивен без графа) |
| `--graft-map` | true | Секция с картой репо в системном промпте |
| `--graft-push` | false | Подмешивать `graft ask` под каждый промпт |
| `--graft-blast` | true | Blast radius после write/edit |
| `--graft-max-output` | 16000 | Лимит вывода инструментов, символы |

## Ключи и переменные окружения

### LLM-провайдер (нужен только для `graft build --deep`)

Базовый граф (`build`, `ask`, `grep`, `map`, `check`, `callers`, `blast`) —
детерминированный tree-sitter, без ключей и сети. Ключи нужны лишь для
LLM-слоя: суммаризация файлов, концепт-ноды, per-symbol crux.

| Переменная | Назначение |
|---|---|
| `GRAFT_PROVIDER` | Wire-формат, не компания: `openai` (любой OpenAI-совместимый endpoint), `anthropic`, `litellm` (прокси), `orcarouter` |
| `GRAFT_API_KEY` | Ключ провайдера |
| `GRAFT_MODEL` | Идентификатор модели в терминологии провайдера (например `openai/gpt-4o-mini`, `claude-sonnet-5`) |
| `GRAFT_BASE_URL` | Для формата `openai`: как выбрать провайдера — OpenRouter `https://openrouter.ai/api/v1`, Groq `https://api.groq.com/openai/v1`, Fireworks `https://api.fireworks.ai/inference/v1`, LiteLLM `http://localhost:4000`, Ollama `http://localhost:11434/v1`; для `anthropic` не нужна |

Примеры:

```bash
# OpenRouter
export GRAFT_PROVIDER=openai GRAFT_BASE_URL=https://openrouter.ai/api/v1
export GRAFT_API_KEY=sk-or-... GRAFT_MODEL=openai/gpt-4o-mini

# Anthropic напрямую
export GRAFT_PROVIDER=anthropic GRAFT_API_KEY=sk-ant-... GRAFT_MODEL=claude-sonnet-5

# Локальная модель (Ollama)
export GRAFT_PROVIDER=openai GRAFT_BASE_URL=http://localhost:11434/v1
export GRAFT_API_KEY=ollama GRAFT_MODEL=qwen2.5-coder:14b
```

### Расширение (pi)

| Переменная | Назначение |
|---|---|
| `GRAFT_CMD` | Явный путь/имя CLI, которым расширение запускает graft (приоритет над поиском `graft` в PATH и npx) |
| `DO_NOT_TRACK` | Расширение само ставит `DO_NOT_TRACK=1` дочерним процессам — телеметрия выключена; переменная дополнительно не нужна |

### Graft CLI (настройки поведения)

| Переменная | Назначение |
|---|---|
| `GRAFT_DIR` | Где лежит граф (по умолчанию `graft/` в корне репо) — расширение находит граф именно так, поэтому при нестандартном месте настраивать надо и CLI, и расширение |
| `GRAFT_NO_REFRESH=1` | Выключить автопересборку графа перед запросами (по умолчанию каждый запрос обновляет граф по working tree, $0) |
| `GRAFT_REFRESH=hash` | Сравнивать файлы по хэшу, а не size+mtime (медленнее, надёжнее) |
| `GRAFT_NO_GITIGNORE=1` | Не писать `graft/` в `.gitignore` (если игнорируется глобально) |
| `GRAFT_NO_IGNORE=1` | Не создавать `.ignore` (ripgrep re-admit) — только если поиском управляете сами |
| `GRAFT_NO_STATUSLINE=1` | `graft init` не трогает statusLine Claude Code (для pi нерелевантно, но если репо общий) |

Наследуемые фолбэки (если `GRAFT_API_KEY` не задан): `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `GRAFT_OPENROUTER_MODEL`, затем `ORCAROUTER_API_KEY` и т.д. — см. `.env.example` в [репозитории Graft](https://github.com/trailhq/Graft/blob/main/.env.example).
