# pi-extensions

Коллекция небольших расширений для [pi](https://pi.dev) в одном git-репозитории.
Установить можно всё целиком — или только нужные расширения (см. [Установка по отдельности](#установка-по-отдельности)).

## Расширения

| Расширение | Назначение |
|---|---|
| [yolo](extensions/yolo/) | Автономный режим `--yolo` / `PI_YOLO=1` / `/yolo`: без стартовых вопросов (доверие проекту, tmux-handoff) и без блокировок guard'ов, включая «пол» bash-guard; бейдж `YOLO` в футере, `/yolo` переключает посреди сессии. Подробности — [Автономный запуск без вопросов](#yolo-автономный-запуск-без-вопросов) |
| [prompt-snippets](extensions/prompt-snippets/) | Комбинируемые одноцелевые промпт-правила: включаются на каждое сообщение через меню (`alt+s` / `/snippets`), вставляются перед или после вашего текста |
| [bash-guard](extensions/bash-guard/) | Перехватывает вызовы инструмента `bash`: интерактивный запрос «Выполнить / Отменить» для рискованных команд (read-only git — без запроса, `--bash-guard-git-strict` для строгого режима), жёсткий блок катастрофических операций в субагентах, toggle персистентны (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [dir-guard](extensions/dir-guard/) | Жёсткий блок read/write/edit/bash, чьи пути уходят вне рабочей директории (CWD) и allowlist'а: realpath-канонизация (symlink-escape блокируется), allowlist — `$HOME/.pi` (дефолт) + `--dir-guard-allow` + `.dir-guard.json` в CWD, `/dir-guard` и бейдж `DR OFF`, состояние персистентно (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [text-guard](extensions/text-guard/) | Контроль текста модели (документация, комментарии, коммиты, чат) — без эмодзи, стрелок, слов-маркеров ИИ-стиля («давайте», delve…) и умных названий: секция стиля в системном промпте, скан write/edit/bash (коммиты, heredoc, echo), режимы off/warn/strict (`/text-guard`, дефолт warn), автофикс эмодзи/стрелок, `.text-guard.json` в CWD (allow/skip/words/ignore), `/text-guard:stats`, бейдж `TG OFF`, состояние персистентно |
| [ask-user-question](extensions/ask-user-question/) | Инструмент `ask_user_question`: задаёт пользователю один вопрос (текст, выбор одного, мультивыбор) и ждёт ответа |
| [sandbox](extensions/sandbox/) | Пер-командная изоляция bash-вызовов агента (L1): bwrap (Linux) / sandbox-exec (macOS), уровни dev/untrusted/vm, стартовый промпт «доверяешь ли проекту?» (project_trust + фолбэк), маркер `.sandbox`, fake $HOME, env-allowlist |
| [gen-speed](extensions/gen-speed/) | Бейдж скорости генерации в футере: `41t/s (0.8s)` (EMA по ответам, на лету при стриминге; в скобках TTFT — время до первого токена; aborted/короткие ответы не считаются) |
| [subagents](extensions/subagents/) | Асинхронные подагенты в tmux: спавн в панель (не блокирует основную сессию), live-виджет статусов и токенов (starting/active/waiting/stalled), steer-результат, resume/interrupt, agent-definitions (`.pi/agents/*.md`) + 4 bundled-агента (planner/scout/worker/reviewer); команды `/spawn`, `/subagents [doctor|status]`, `/iterate [agent] <task>`, `/plan <task>` (planner→worker→reviewer); `spawning`/`deny-tools` в frontmatter; вне tmux — handoff (перезапуск pi внутри tmux с продолжением сессии) |

## Yolo: автономный запуск без вопросов

```bash
pi --yolo "сделай задачу"                 # или
PI_YOLO=1 pi "сделай задачу"              # переменная наследуется дочерними pi
/yolo                                     # переключить посреди идущей сессии
```

Режим для мест, где в TUI никто не ответит: Orca-автоматизации, CI, `pi -p`,
RPC. Убирает стартовые вопросы (доверие проекту, tmux-handoff) и снимает
блокировки всех guard'ов этого репозитория, включая «пол» bash-guard.
Для Orca проще задать `PI_YOLO=1` в окружении автоматизации, чем менять
команду запуска. Команда `/yolo` работает в обе стороны и держит `PI_YOLO` в
синхроне (дочерние агенты наследуют состояние), но вопросы старта она не
отменяет — они случаются до первой команды. Подробно (что именно выключается и
границы) в [extensions/yolo/README.md](extensions/yolo/README.md).

## Скиллы

| Скилл | Назначение |
|---|---|
| [session-insights](skills/session-insights/) | Анализ собственных pi-сессий (`~/.pi/agent/sessions`) → отчёт с рекомендациями и черновиками улучшений (новые скиллы, правила для AGENTS.md, каркасы экстеншенов). Read-only, Python 3 stdlib |
| [ui-design](skills/ui-design/) | Дизайн нового экрана по порядку: референсы → токен-план в `DESIGN.md` проекта → вёрстка на надутых данных → самопроверка. Список анти-шаблонов, от которых экран становится «как у модели» |
| [ui-review](skills/ui-review/) | Ревью вёрстки: машинная проверка `scripts/a11y.mjs` (axe-core + типовые поломки layout/motion/тап-цел) вместо «надеюсь, модель заметила», скриншоты в трёх ширинах, побитовый diff с предыдущим прогоном, чеклист по секциям |

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
| yolo | `extensions/yolo/*` |
| bash-guard | `extensions/bash-guard/*` |
| dir-guard | `extensions/dir-guard/*` |
| text-guard | `extensions/text-guard/*` |
| ask-user-question | `extensions/ask-user-question/*` |
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

Даст диалог «Выполнить / Отменить» на рискованные bash-команды, `/bash-guard`,
`/bash-guard:rm` (снять запрет на удаление файлов) и флаги `--bash-guard-disabled` / `--bash-guard-auto-allow`. Зависимость
`shell-quote` ставится автоматически (npm install при установке пакета).

### Только dir-guard

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/dir-guard/*"]
		}
	]
}
```

Даст жёсткий блок read/write/edit/bash вне рабочей директории (CWD) и allowlist'а
(дефолт `$HOME/.pi`, плюс `--dir-guard-allow` и `.dir-guard.json` в CWD),
команду `/dir-guard` и флаги `--dir-guard-disabled` / `--dir-guard-allow`.
Без зависимостей.

### Только text-guard

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/text-guard/*"]
		}
	]
}
```

Даст контроль текста модели (write/edit/bash + чат): секция стиля в системном
промпте, режимы off/warn/strict (`/text-guard`, дефолт warn), автофикс
эмодзи/стрелок (`/text-guard:fix`), статистику (`/text-guard:stats`),
настройку через `.text-guard.json` в CWD. Без зависимостей.

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

### Только скиллы

Скиллы из пакета ставятся вместе с ним (манифест `package.json` → `pi.skills`).
Вручную — без установки пакета:

```bash
# symlink (копирует при желании — то же самое)
mkdir -p ~/.pi/agent/skills
git clone --depth 1 https://github.com/stelmakhdigital/pi-extensions /tmp/pi-ext
ln -sfn /tmp/pi-ext/skills/session-insights ~/.pi/agent/skills/session-insights
ln -sfn /tmp/pi-ext/skills/ui-design ~/.pi/agent/skills/ui-design
ln -sfn /tmp/pi-ext/skills/ui-review ~/.pi/agent/skills/ui-review
```

После установки `/reload` (или перезапуск pi). `ui-review` требует playwright и
chromium в том проекте, который проверяется (скилл сам печатает команду установки,
если пакета нет): `npm i -D playwright && npx playwright install chromium`. Скрипт
ищет пакет от каталога запуска, поэтому запускать надо из корня проверяемого
проекта. В этом репозитории playwright и axe-core уже в devDependencies, поэтому
e2e-проверки скриншотов и diff-а выполняются обычным `npm test`; без chromium они
печатают skip (код выхода 4 — «среды нет», а не «нарушений нет»).

#### Использование

Спросить агента естественным языком — скилл подхватится сам по описанию:

> «Проанализируй мои сессии за 30 дней и предложи улучшения»
> «Посмотри, где я больше всего трачу токены / на каких проектах»

Агент соберёт digest, выведет рекомендации с обоснованием из данных и создаст в
каталоге текущего проекта:

```
.session-insights/
  report-<YYYYMMDD>.md   # отчёт: находки + рекомендации
  drafts/                # черновики улучшений (SKILL.md, блок AGENTS.md, TS-экстеншен)
```

Черновиками агент не меняет ничего — только создаёт файлы на проверку. Журнал
вмешательств (что поменяли в harness и помогло ли) лежит отдельно и глобально:
`~/.pi/agent/session-insights/ledger.md`.

Ручной запуск digest без агента (Python 3, без зависимостей):

```bash
python3 <путь>/scripts/insights.py --since 30d            # markdown-digest
python3 <путь>/scripts/insights.py --since 60d --cwd pi  # фильтр по проекту
python3 <путь>/scripts/insights.py --errors-only --json  # JSON
python3 <путь>/scripts/surface.py                        # вес always-on (AGENTS.md, скиллы)
python3 <путь>/scripts/ledger.py list                    # журнал вмешательств и verdict'ы
```

Фильтры: `--since/--until 7d|2w|ISO` (`--since` по умолчанию 30d),
`--cwd <подстрока>` (повторяемо), `--min-cost`, `--errors-only`, `--top N`, `--json`, `--window` у `ledger.py check`,
`--all` (включить автоматические сессии — OM-извлечения по умолчанию скрываются).

Digest разделяет повторяющиеся строки промптов на `noise` (логи и вывод команд —
не кандидаты в правила), `rule` (императивные правки) и `fact` (конкретика
проекта), а ошибки инструментов сворачивает в сигнатуры (uuid/hex/числа/пути),
чтобы 40 вариантов одной аварии не выглядели сорока разными проблемами. Тела
скиллов, которые pi разворачивает на `/скилл` в user-сообщение, считаются
отдельно (`skill_injections`) — это цена вызова скилла, а не текст пользователя.
Когда провайдер не отдаёт цены (`cost = 0`), топ сортируется по токенам.

`ledger.py` ведёт `~/.pi/agent/session-insights/ledger.md`: запись заводится до
правки (cue / component / lesson / evidence / confidence), verdict (`helped`,
`hurt`, `no observed effect`, `confounded`, `reverted`) выставляется после замера
частоты pattern'а до и после даты принятия: `ledger.py check --apply`.

Тесты скритов: `node test/session-insights.test.mjs` (нужен python3; без него — skip).

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
  yolo-mode.ts                # isYolo(): /yolo, PI_YOLO или --yolo в argv
  yolo/
    index.ts                  # флаг --yolo, команда /yolo, авто-доверие проекту, бейдж
  prompt-snippets/
    index.ts                  # расширение
    snippets/                 # сниппеты (по одному .md на правило)
  bash-guard/
    index.ts
  ask-user-question/
    index.ts
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
  ui-design/
    SKILL.md                  # референсы → DESIGN.md → анти-шаблоны → вёрстка → самопроверка
  ui-review/
    SKILL.md                  # машинная проверка → скриншоты → чеклист по секциям
    scripts/
      a11y.mjs                # axe-core + layout/motion-пробы + скриншоты по ширинам (playwright)
      png-diff.mjs            # декодер/энкодер PNG и побитовое сравнение кадров, без зависимостей
```

Скиллы грузятся пакетом через манифест `package.json` → `pi.skills`
(каталог `skills/` с папками, содержащими `SKILL.md`).

## Лицензия

MIT.
