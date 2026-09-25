# pi-extensions

Коллекция небольших расширений для [pi](https://pi.dev) в одном git-репозитории.
Установить можно всё целиком — или только нужные расширения (см. [Установка по отдельности](#установка-по-отдельности)).

## Расширения

| Расширение | Назначение |
|---|---|
| [prompt-snippets](extensions/prompt-snippets/) | Комбинируемые одноцелевые промпт-правила: включаются на каждое сообщение через меню (`alt+s` / `/snippets`), вставляются перед или после вашего текста |
| [bash-guard](extensions/bash-guard/) | Перехватывает вызовы инструмента `bash`: интерактивный запрос «Выполнить / Отменить» для рискованных команд (read-only git — без запроса, `--bash-guard-git-strict` для строгого режима), жёсткий блок катастрофических операций в субагентах |
| [ask-user-question](extensions/ask-user-question/) | Инструмент `ask_user_question`: задаёт пользователю один вопрос (текст, выбор одного, мультивыбор) и ждёт ответа |
| [graft](extensions/graft/) | Интеграция [Graft](https://github.com/trailhq/Graft): нативные инструменты `graft_ask/grep/callers/skeleton/map/check/blast`, карта репо в системном промпте, blast radius после write/edit, бейдж свежести |
| [sandbox](extensions/sandbox/) | Пер-командная изоляция bash-вызовов агента (L1): bwrap (Linux) / sandbox-exec (macOS), уровни dev/untrusted/vm, стартовый промпт «доверяешь ли проекту?» (project_trust + фолбэк), маркер `.sandbox`, fake $HOME, env-allowlist |
| [gen-speed](extensions/gen-speed/) | Бейдж скорости генерации в футере: `41 t/s · ⌀ 0.8s` (EMA по ответам, на лету при стриминге; TTFT — время до первого токена; aborted/короткие ответы не считаются) |
| [subagents](extensions/subagents/) | Асинхронные подагенты в tmux: спавн в панель (не блокирует основную сессию), live-виджет статусов и токенов (starting/active/waiting/stalled), steer-результат, resume/interrupt, agent-definitions (`.pi/agents/*.md`) + 4 bundled-агента (planner/scout/worker/reviewer); команды `/spawn`, `/subagents [doctor|status]`, `/iterate [agent] <task>`, `/plan <task>` (planner→worker→reviewer); `spawning`/`deny-tools` в frontmatter; вне tmux — handoff (перезапуск pi внутри tmux с продолжением сессии) |

## Скиллы

| Скилл | Назначение |
|---|---|
| [session-insights](skills/session-insights/) | Анализ собственных pi-сессий (`~/.pi/agent/sessions`) → отчёт с рекомендациями и черновиками улучшений (новые скиллы, правила для AGENTS.md, каркасы экстеншнов). Read-only, Python 3 stdlib |

## Установка

Целиком:

```bash
pi install git:github.com/stelmakhdigital/pi-extensions@master
```

После установки `/reload` (или перезапуск pi). Обновление:

```bash
pi update --extensions   # обновить пакеты (подтянет актуальный HEAD ветки master)
```

Привязка к ветке = «latest»: в пакет попадают все свежие коммиты.
Если нужна закреплённая версия — ставь тег или хеш коммита:
`pi install git:github.com/stelmakhdigital/pi-extensions@v0.3.0`.
Обновление фиксированного тега `pi update` не поднимает (fetch идёт `--no-tags`) —
нужен повторный `pi install ...@<новый тег>`.

## Установка по отдельности

Пакет — это весь репозиторий, но в настройках можно загрузить только нужные
расширения через фильтры (объектная форма записи пакета). Конкретный паттерн
для каждого расширения:

| Расширение | Фильтр |
|---|---|
| prompt-snippets | `extensions/prompt-snippets/*` |
| bash-guard | `extensions/bash-guard/*` |
| ask-user-question | `extensions/ask-user-question/*` |
| graft | `extensions/graft/*` |
| sandbox | `extensions/sandbox/*` |
| subagents | `extensions/subagents/*` |
| gen-speed | `extensions/gen-speed/*` |

Далее — пример для каждого (глобальные настройки `~/.pi/agent/settings.json`).

### Только prompt-snippets

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/prompt-snippets/*"]
		}
	]
}
```

Даст меню `alt+s` / `/snippets` и сниппеты из `extensions/prompt-snippets/snippets/`.

### Только bash-guard

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/bash-guard/*"]
		}
	]
}
```

Даст диалог «Выполнить / Отменить» на рискованные bash-команды, `/bash-guard`
и флаги `--bash-guard-disabled` / `--bash-guard-auto-allow`. Зависимость
`shell-quote` ставится автоматически (npm install при установке пакета).

### Только ask-user-question

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/ask-user-question/*"]
		}
	]
}
```

Даст инструмент `ask_user_question`.

### Только graft

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/graft/*"]
		}
	]
}
```

Даст инструменты `graft_ask`, `graft_grep`, `graft_callers`, `graft_skeleton`,
`graft_map`, `graft_check`, `graft_blast`, секцию `<graft>` в системном промпте,
blast radius после write/edit, бейдж свежести и команду `/graft`.
Вне репо с построенным графом расширение молчит.

**Graft-движок встроён в пакет** (`engine/graft/`): собственный парсер
(web-tree-sitter + tree-sitter-wasm, TS/JS/Python), собственный формат
хранилища (`graft/.engine/`, `graft/cards/`, `graft/index.md`) и
LLM-«deep»-проход (явный конфиг `GRFT_LLM_BASE_URL`/`GRFT_LLM_MODEL`/
`GRFT_LLM_API_KEY`, openai-chat-формат). Без внешних CLI-зависимостей:
граф строится командой `/graft build` (в pi) или
`node engine/graft/bin/graft.mjs build` (из консоли). Детали — в
`SPEC-graft-engine.md`.

### Только sandbox

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/sandbox/*"]
		}
	]
}
```

Даст пер-командную песочницу для bash-команд агента: уровни `dev`/
`untrusted` (bwrap на Linux, sandbox-exec на macOS), файл-маркер
`.sandbox` в репо для автоматического включения, `/sandbox status|on|test`,
бейдж в футере. Без песочницы команды агента не выполняются (fail-closed),
если уровень включён, но бэкенд недоступен. Windows — только контейнерный
режим (см. `sandbox/README.md`).

### Только subagents

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

Даст инструменты `spawn_agent` / `agents_list` / `interrupt_agent` /
`resume_agent`, команду `/spawn` и live-виджет подагентов. Требует pi внутри
tmux (`tmux new -A -s pi 'pi'`); вне tmux при старте предложит handoff.
Детали — в `extensions/subagents/README.md`.

### Только session-insights

Скиллы из пакета ставятся вместе с ним (манифест `package.json` → `pi.skills`).
Вручную — без установки пакета:

```bash
# symlink (копирует при желании — то же самое)
mkdir -p ~/.pi/agent/skills
git clone --depth 1 https://github.com/stelmakhdigital/pi-extensions /tmp/pi-ext
ln -sfn /tmp/pi-ext/skills/session-insights ~/.pi/agent/skills/session-insights
```

После установки `/reload` (или перезапуск pi).

#### Использование

Спросить агента естественным языком — скилл подхватится сам по описанию:

> «Проанализируй мои сессии за 30 дней и предложи улучшения»
> «Посмотри, где я больше всего трачу токены / на каких проектах»

Агент соберёт digest, выведет рекомендации с обоснованием из данных и создаст в
каталоге текущего проекта:

```
.session-insights/
  report-<YYYYMMDD>.md   # отчёт: находки + рекомендации
  drafts/                # черновики улучшений (SKILL.md, блок AGENTS.md, TS-экстеншн)
```

Черновиками агент не меняет ничего — только создаёт файлы на проверку.

Ручной запуск digest без агента (Python 3, без зависимостей):

```bash
python3 <путь>/scripts/insights.py --since 30d            # markdown-digest
python3 <путь>/scripts/insights.py --since 60d --cwd pi  # фильтр по проекту
python3 <путь>/scripts/insights.py --errors-only --json  # JSON
```

Фильтры: `--since/--until 7d|2w|ISO`, `--cwd <подстрока>` (повторяемо),
`--min-cost`, `--errors-only`, `--top N`, `--json`, `--all`
(включить автоматические сессии — OM-извлечения по умолчанию скрываются).

### Несколько расширений

Несколько паттернов в одном пакете (или в разных записях пакета — так же):

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": [
				"extensions/prompt-snippets/*",
				"extensions/bash-guard/*"
			]
		}
	]
}
```

Чтобы вообще ничего из пакета не грузить: `"extensions": []`.
Те же фильтры можно задать в проектном `.pi/settings.json` (`pi config -l`).

> Клон репозитория один на все расширения (живёт в `~/.pi/agent/git/...`),
> различается только то, какие файлы из него загружаются.

## Структура

```
package.json                  # pi-манифест + зависимости (shell-quote)
extensions/
  prompt-snippets/
    index.ts                  # расширение
    snippets/                 # сниппеты (по одному .md на правило)
  bash-guard/
    index.ts
  ask-user-question/
    index.ts
  graft/
    index.ts                  # тонкий адаптер pi-graft-engine (без spawn)
  sandbox/
    index.ts                  # per-command sandbox (bwrap / sandbox-exec)
  gen-speed/
    index.ts                  # бейдж скорости генерации токенов + TTFT в футере
  subagents/
    index.ts                  # родитель: инструменты, watch, виджет, steer, handoff
    child.ts                  # дочернее: agent_done/agent_ping, снапшоты активности
    tmux-backend.ts           # tmux-реализация MuxBackend (injectable runner)
    session.ts                # детерминированные файлы сессий, seed (standalone/lineage/fork)
    agents.ts                 # discovery agent-definitions + frontmatter
    config.ts                 # конфиг: defaults < global < project < env
    types.ts                  # MuxBackend, снапшоты, results
sandbox/
  Dockerfile                  # pi-контур для недоверенного кода (см. sandbox/README.md)
  README.md
skills/
  session-insights/
    SKILL.md                  # workflow: digest → рекомендации → отчёт + черновики
    scripts/                  # Python 3 stdlib: sessions.py (библиотека), insights.py (digest)
```

Скиллы грузятся пакетом через манифест `package.json` → `pi.skills`
(каталог `skills/` с папками, содержащими `SKILL.md`).

## Лицензия

MIT.
