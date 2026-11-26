# pi-extensions

Коллекция небольших расширений для [pi](https://pi.dev) в одном git-репозитории.
Установить можно всё целиком — или только нужные расширения (см. [Установка по отдельности](#установка-по-отдельности)).

## Расширения

| Расширение | Назначение |
|---|---|
| [yolo](extensions/yolo/) | Автономный режим `--yolo` / `PI_YOLO=1` / `/yolo`: без стартовых вопросов (доверие проекту, tmux-handoff) и без блокировок guard'ов, включая «пол» bash-guard; бейдж `YOLO` в футере, `/yolo` переключает посреди сессии. Подробности — [Автономный запуск без вопросов](#yolo-автономный-запуск-без-вопросов) |
| [prompt-snippets](extensions/prompt-snippets/) | Комбинируемые одноцелевые промпт-правила: включаются на каждое сообщение через меню (`alt+s` / `/snippets`), вставляются перед или после вашего текста |
| [bash-guard](extensions/bash-guard/) | Перехватывает вызовы инструмента `bash`: интерактивный запрос «Выполнить / Отменить» для рискованных команд (read-only git — без запроса, `--bash-guard-git-strict` для строгого режима), жёсткий блок катастрофических операций в субагентах, toggle персистентны (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [dir-guard](extensions/dir-guard/) | Жёсткий блок read/write/edit/bash, чьи пути уходят вне рабочей директории (CWD) и allowlist'а: realpath-канонизация (symlink-escape блокируется), allowlist — `$HOME/.pi` (дефолт) + `--dir-guard-allow` + `.dir-guard.json` в CWD, файлы учётных данных (`~/.ssh`, `~/.aws`, `auth.json`, `*.pem`, `.env`) блокируются сверх allowlist'а (`--dir-guard-allow-secrets` / `"secrets": "allow"`), `/dir-guard` и бейдж `DR OFF`, состояние персистентно (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [injection-guard](extensions/injection-guard/) | Защита от prompt injection: результаты внешних инструментов (веб, сеть, MCP, файлы недоверенного репо) оборачиваются в метки `UNTRUSTED` с обезвреживанием поддельных меток + секция правил в системном промпте; блок корреляции «чтение секрета + сетевой уход»; в strict опасные действия (файлы агента, отправка наружу, установка пакетов, git push) после внешнего контента спрашиваются. Режимы off/label/strict (`/injection-guard`, дефолт label), бейдж `IG`, `/injection-guard:stats`, `.injection-guard.json` в CWD |
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
интерактивные блокировки guard'ов этого репозитория, включая «пол» bash-guard.
Кроме «пола» injection-guard: маркировка внешних данных и блок «секрет + сеть»
остаются включёнными даже при `/injection-guard` в off — в автономной сессии
инъекцию смотреть некому.

Для Orca проще задать `PI_YOLO=1` в окружении автоматизации, чем менять
команду запуска. Команда `/yolo` работает в обе стороны и держит `PI_YOLO` в
синхроне (дочерние агенты наследуют состояние), но вопросы старта она не
отменяет — они случаются до первой команды. Подробно (что именно выключается и
границы) в [extensions/yolo/README.md](extensions/yolo/README.md).

## Защита от prompt injection

Инъекция приходит с данными: веб-страница, `curl`, склонированный репозиторий,
MCP-инструмент, снапшот браузера. `injection-guard` не ищет «плохие слова»
(регулярки обходятся и валят легитимный текст), он работает на трёх границах.

1. Маркировка. `tool_result` оборачивает вывод внешних инструментов в
   `<UNTRUSTED tool=... src=...>`, из содержимого вырезаются попытки закрыть
   фрейс досрочно. Секция `<untrusted-content>` в системном промпте объясняет
   модели, что внутри фрейса — данные, а не команды. Файловые инструменты
   недоверенного проекта (`ctx.isProjectTrusted()` false) получают короткую
   пометку вместо фрейса, чтобы не раздувать контекст.
2. Эксфильтрация. Корреляция вместо паттерна: в одной bash-команде чтение
   секрета (`~/.ssh`, `~/.aws`, `auth.json`, ключевые файлы — общий список в
   `extensions/secret-paths.ts`) И сетевой уход — жёсткий блок с причиной.
   Работает в label и в yolo. Тот же слой блокирует доступ к секрету вне CWD
   через read/write/edit, но только в окне недоверия — это резерв на случай
   выключённого dir-guard.
3. Эскалация (strict). Пока активно «окно недоверия» (с момента внешнего
   результата до живой реплики пользователя), опасные действия спрашиваются:
   правка файлов агента (`AGENTS.md`, `.pi/settings.json`, guard'ы), отправка
   данных наружу, установка пакетов, `git push`. В субагенте и в yolo вместо
   вопроса блок.

```bash
/injection-guard            # off -> label (дефолт) -> strict
/injection-guard:stats      # что маркировано, что заблокировано, текущее окно
```

Флаги `--injection-guard-off` / `--injection-guard-strict`, настройка
`.injection-guard.json` в CWD (`untrusted` / `trusted` — имена инструментов,
glob `*`), бейдж `IG n` в футере, режим персистентен (`guard-state.json`).
В `label` guard не мешает работе, но оставляет модели явную границу
«данные / команды».

## Скиллы

| Скилл | Назначение |
|---|---|
| [session-insights](skills/session-insights/) | Анализ собственных pi-сессий (`~/.pi/agent/sessions`) → отчёт с рекомендациями и черновиками улучшений (новые скиллы, правила для AGENTS.md, каркасы экстеншенов). Read-only, Python 3 stdlib |
| [ui-design](skills/ui-design/) | Дизайн нового экрана по порядку: референсы, taste preflight, токен-план в `DESIGN.md` проекта, вёрстка на надутых данных, самопроверка. `references/anti-patterns.md` — признаки генерации и счётные ограничители |
| [ui-review](skills/ui-review/) | Ревью вёрстки двумя скриптами: `lint-ui.mjs` по исходникам, `a11y.mjs` по экрану (axe-core, свой расчёт контраста, layout/motion/тап-целы), скриншоты в трёх ширинах с побитовым diff. Чеклист вынесен в `references/checklist.md` |

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
| injection-guard | `extensions/injection-guard/*` |
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
блок файлов учётных данных сверх allowlist'а, команду `/dir-guard` и флаги
`--dir-guard-disabled` / `--dir-guard-allow` / `--dir-guard-allow-secrets`.
Без зависимостей.

### Только injection-guard

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@master",
			"extensions": ["extensions/injection-guard/*"]
		}
	]
}
```

Даст маркировку внешних результатов метками `UNTRUSTED`, секцию `<untrusted-content>`
в системном промпте, блок «секрет + сеть» и (в strict) подтверждение опасных
действий после внешнего контента: `/injection-guard`, `/injection-guard:stats`,
флаги `--injection-guard-off` / `--injection-guard-strict`, `.injection-guard.json` в CWD.
Работает вместе с dir-guard (у него общий список секретов, `extensions/secret-paths.ts`),
но не зависит от него. Подробности — [Защита от prompt injection](#защита-от-prompt-injection).

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
  guard-state.ts              # персистентность режимов guard'ов (<agentDir>/guard-state.json)
  json-store.ts               # readJson / writeJson (tmp + rename)
  secret-paths.ts             # пути учётных данных (dir-guard + injection-guard)
  untrusted.ts                # «окно недоверия»: флаг внешнего контента в контексте
  yolo/
    index.ts                  # флаг --yolo, команда /yolo, авто-доверие проекту, бейдж
  prompt-snippets/
    index.ts                  # расширение
    snippets/                 # сниппеты (по одному .md на правило)
  bash-guard/
    index.ts
  injection-guard/
    index.ts                  # маркировка UNTRUSTED, блок «секрет + сеть», эскалация
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
    SKILL.md                  # референсы → preflight → DESIGN.md → вёрстка → самопроверка
    references/anti-patterns.md   # признаки генерации и счётные ограничители
  ui-review/
    SKILL.md                  # контекст → машинная проверка → рендер → находки
    references/checklist.md   # семантика/layout/motion/состояния/данные + эвристики Нильсена
    scripts/
      a11y.mjs                # axe-core, контраст, layout-пробы, скриншоты по ширинам (playwright)
      lint-ui.mjs             # статические правила по исходникам, без браузера и зависимостей
      png-diff.mjs            # декодер/энкодер PNG и побитовое сравнение кадров, без зависимостей
```

Скиллы грузятся пакетом через манифест `package.json` → `pi.skills`
(каталог `skills/` с папками, содержащими `SKILL.md`).

## Откуда что взялось в UI-скиллах

Правила и механика проверок сверялись с открытыми наборами скиллов; в наш формат
они перенесены своими словами, скопированных файлов в репозитории нет:

- `anthropics/skills` — `frontend-design` (признаки генерации, two-pass «план →
  проверка плана → код», требования к тексту) и `webapp-testing` (сначала
  разведка рендера, потом действия; скрипты как чёрные ящики). Apache-2.0.
- `yashh1323/atelier-ui` — идея статического лимта рядом с браузерной
  проверкой и список правил для `lint-ui.mjs`. MIT.
- `plugin87/ux-ui-agent-skills` — протокол верификации (не называть неизмеренное,
  skip это не pass, «рендер и смотри»), mobile-first как базовый слой, восемь
  состояний, токен по смыслу. MIT.
- `arham777/ui-ux-kit` — счётные ограничители (eyebrow, зигзаги, семейства
  раскладки, одна CTA) и разбор hero-композиций. MIT.

## Лицензия

MIT.
