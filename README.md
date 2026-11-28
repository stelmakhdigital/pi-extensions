# pi-extensions

Коллекция небольших расширений для [pi](https://pi.dev) в одном git-репозитории.
Установить можно всё целиком — или только нужные расширения (см. [Установка по отдельности](#установка-по-отдельности)).

## Все расширения — коротко

Загружаются все из `package.json` (`pi.extensions`); отключаются своей командой
или флагом. Столбец «Включение» — что набирать в TUI и что передавать при запуске.

| Расширение | Что делает | Включение / выключение |
|---|---|---|
| [yolo](extensions/yolo/) | Автономный режим: без стартовых вопросов, снимает интерактивные блокировки guard'ов | `--yolo`, `PI_YOLO=1`, `/yolo` |
| [prompt-snippets](extensions/prompt-snippets/) | Одноцелевые промпт-правила на каждое сообщение | `alt+s`, `/snippets` |
| [dir-guard](extensions/dir-guard/) | Жёсткий блок read/write/edit/ls/find/grep/bash вне CWD и сверх allowlist'а секретов | `/dir-guard`, `--dir-guard-disabled`, `--dir-guard-allow`, `--dir-guard-allow-secrets` |
| [bash-guard](extensions/bash-guard/) | Запрос «Выполнить / Отменить» на рискованный bash + жёсткий «пол» для катастрофических | `/bash-guard`, `/bash-guard:rm`, `--bash-guard-disabled`, `--bash-guard-auto-allow`, `--bash-guard-git-strict` |
| [injection-guard](extensions/injection-guard/) | Метки `UNTRUSTED` на внешних данных, блок «секрет + сеть», маскирование ключей, подтверждение опасных действий после внешнего контента | `/injection-guard` (off/label/strict), `/injection-guard:stats`, `--injection-guard-off`, `--injection-guard-strict` |
| [edit-fresh](extensions/edit-fresh/) | Блок `edit`, если файл не читали или он изменился после read (правка «по памяти») | всегда включено, `--edit-fresh-disabled` (команды нет) |
| [bash-exit-hint](extensions/bash-exit-hint/) | Снимает флаг ошибки с `grep`/`rg`/`diff` с exit 1 и дописывает пояснение, чтобы модель не ретраила штатный код | всегда включено (команд и флагов нет) |
| [text-guard](extensions/text-guard/) | Контроль текста модели: без эмодзи, стрелок и слов-маркеров ИИ-стиля; автофикс | `/text-guard` (off/warn/strict, дефолт warn), `/text-guard:fix`, `/text-guard:stats`, `--text-guard-off`, `--text-guard-strict` |
| [ask-user-question](extensions/ask-user-question/) | Инструмент `ask_user_question`: один вопрос с вариантами и ожидание ответа | всегда включено |
| [subagents](extensions/subagents/) | Асинхронные подагенты в tmux со стиром результата, resume и interrupt | `/spawn`, `/subagents`, `/iterate`, `/plan`, `--subagents-disabled` (нужен tmux) |
| [sandbox](extensions/sandbox/) | Пер-командная изоляция bash (bwrap / sandbox-exec), fail-closed | `/sandbox status\|on <dev\|untrusted\|vm\|off>\|test\|forget`, `--sandbox-level`, файл `.sandbox` в проекте |
| [gen-speed](extensions/gen-speed/) | Бейдж скорости генерации и TTFT | всегда включено |
| [todo](extensions/todo/) | Живой чек-лист сессии: инструмент `todo` + виджет над редактором | `/todos`, `alt+t` |
| [edit-check](extensions/edit-check/) | typecheck/линт в конце прогона, ошибки — обратно модели | `/edit-check` (проверить сейчас), `/edit-check off`, `.edit-check.json` |

Порядок строк — порядок загрузки, он значим (см. [Порядок загрузок](#порядок-загрузок)).
Подробные описания — в следующей таблице и в разделах ниже.

## Расширения — подробно

| Расширение | Назначение |
|---|---|
| [yolo](extensions/yolo/) | Автономный режим `--yolo` / `PI_YOLO=1` / `/yolo`: без стартовых вопросов (доверие проекту, tmux-handoff) и без блокировок guard'ов, включая «пол» bash-guard; бейдж `YOLO` в футере, `/yolo` переключает посреди сессии. Подробности — [Автономный запуск без вопросов](#yolo-автономный-запуск-без-вопросов) |
| [prompt-snippets](extensions/prompt-snippets/) | Комбинируемые одноцелевые промпт-правила: включаются на каждое сообщение через меню (`alt+s` / `/snippets`), вставляются перед или после вашего текста |
| [bash-guard](extensions/bash-guard/) | Перехватывает вызовы инструмента `bash`: интерактивный запрос «Выполнить / Отменить» для рискованных команд (read-only git — без запроса, `--bash-guard-git-strict` для строгого режима), жёсткий блок катастрофических операций в субагентах и в «полу» автономного режима; команду, которую `sandbox` возьмёт в изоляцию, не спрашивает (состояние читается из `extensions/sandbox-state.ts`), «пол» при этом остаётся; toggle персистентны (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [dir-guard](extensions/dir-guard/) | Жёсткий блок read/write/edit/find/grep/ls/bash, чьи пути уходят вне рабочей директории (CWD) и allowlist'а: realpath-канонизация (symlink-escape блокируется), allowlist — `$HOME/.pi` (дефолт) + `--dir-guard-allow` + `.dir-guard.json` в CWD, файлы учётных данных (`~/.ssh`, `~/.aws`, `auth.json`, `*.pem`, `.env`) блокируются сверх allowlist'а (`--dir-guard-allow-secrets` / `"secrets": "allow"`), `/dir-guard` и бейдж `DR OFF`, состояние персистентно (`~/.pi/agent/guard-state.json`, переживает `/reload`) |
| [injection-guard](extensions/injection-guard/) | Защита от prompt injection: результаты внешних инструментов (веб, сеть, MCP, файлы недоверенного репо) оборачиваются в метки `UNTRUSTED` с обезвреживанием поддельных меток + секция правил в системном промпте; блок корреляции «чтение секрета + сетевой уход»; маскирование секретов из вывода bash (формы ключей, дампы `env`/`git config --list`, пароль в URL); в strict опасные действия (файлы агента, отправка наружу, установка пакетов, git push) после внешнего контента спрашиваются. Режимы off/label/strict (`/injection-guard`, дефолт label), бейдж `IG`, `/injection-guard:stats`, `.injection-guard.json` в CWD |
| [text-guard](extensions/text-guard/) | Контроль текста модели (документация, комментарии, коммиты, чат) — без эмодзи, стрелок, слов-маркеров ИИ-стиля («давайте», delve…) и умных названий: секция стиля в системном промпте, скан write/edit/bash (коммиты, heredoc, echo), режимы off/warn/strict (`/text-guard`, дефолт warn), автофикс эмодзи/стрелок, `.text-guard.json` в CWD (allow/skip/words/ignore), `/text-guard:stats`, бейдж `TG OFF`, состояние персистентно |
| [ask-user-question](extensions/ask-user-question/) | Инструмент `ask_user_question`: задаёт пользователю один вопрос (текст, выбор одного, мультивыбор) и ждёт ответа |
| [sandbox](extensions/sandbox/) | Пер-командная изоляция bash-вызовов агента (L1): bwrap (Linux) / sandbox-exec (macOS), уровни dev/untrusted/vm, стартовый промпт «доверяешь ли проекту?» (project_trust + фолбэк), маркер `.sandbox`, fake $HOME, env-allowlist |
| [gen-speed](extensions/gen-speed/) | Бейдж скорости генерации в футере: `41t/s (0.8s)` (EMA по ответам, на лету при стриминге; в скобках TTFT — время до первого токена; aborted/короткие ответы не считаются) |
| [todo](extensions/todo/) | Живой чек-лист над редактором: инструмент `todo` (add/toggle/list/clear), виджет `задачи 2/5` с открытыми пунктами, `/todos` и `alt+t` — полный список в оверлее, бейдж в футере. Состояние в истории сессии (переживает `/reload`, корректно в любой ветке) |
| [edit-check](extensions/edit-check/) | Проверка типов/линта в конце прогона: после правок запускает `typecheck`-скрипт проекта (или `cmd` из `.edit-check.json`), а ошибки отправляет модели с `triggerTurn` — «готово» со сломанными типами не проходит. `/edit-check`, `/edit-check off`, бейдж `✗ 2/3`, после 3 раундов цикл обрывается |
| [edit-fresh](extensions/edit-fresh/) | Блок `edit`, если файл не читали в этой сессии или он изменился после read: oldText «по памяти» почти никогда не совпадает, и правка ушла бы битой. Канонизация путей (symlink), бейдж `edit-fresh`, состояние сбрасывается на новой сессии; в yolo снят |
| [bash-exit-hint](extensions/bash-exit-hint/) | Exit 1 у `grep`/`egrep`/`fgrep`/`rg`/`diff`/`cmp`/`comm`/`pgrep` — штатный код («нет совпадений», «файлы различаются»), а не падение. Снимает `isError` и дописывает пояснение, чтобы модель не ретраила тот же вызов. Коды >= 2 и произвольные скрипты не трогает; разбор цепочек общий с guard'ами (`extensions/shell-parse.ts`), работает и под `UNTRUSTED`-фрейсом injection-guard |
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
(регулярки обходятся и валят легитимный текст), он работает на четырёх границах.

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
4. Маскирование. Из вывода bash вырезаются секреты по жёстким формам (`AKIA…`,
   `ghp_…`, `sk-…`, PEM, JWT, пароль в URL, `ТОКЕН=значение`), а в дампах
   (`env`, `git config --list`, `cat .env`) — по имени переменной. `read`/`edit`
   не маскируются: файлы модель правит посимвольно, а доступ к ключам закрывает
   dir-guard. Настройка `redact` (`off`/`bash`/`all`) и `redactAllow` — там же.

```bash
/injection-guard            # off -> label (дефолт) -> strict
/injection-guard:stats      # что маркировано, замаскировано, заблокировано; текущее окно
```

Флаги `--injection-guard-off` / `--injection-guard-strict`, настройка
`.injection-guard.json` в CWD (`untrusted` / `trusted` — имена инструментов,
glob `*`; `redact` — `off`/`bash`/`all`; `redactAllow` — значения-фикстуры),
бейдж `IG n` в футере, режим персистентен (`guard-state.json`).
В `label` guard не мешает работе, но оставляет модели явную границу
«данные / команды».

## Порядок загрузок

Список `pi.extensions` в `package.json` — это и порядок цепочки хендлеров
(`tool_call` и `tool_result` идут по нему). Он значим, переставлять элементы
без причины не стоит:

- `yolo` первым — отвечает на `project_trust` раньше `sandbox`, иначе автономная
  сессия упрётся в вопрос о доверии проекту.
- `dir-guard` до `bash-guard` — жёсткая граница путей проверяется до того, как
  пользователь уже ответил на «Выполнить / Отменить». Иначе выходил диалог на
  команду, которая в итоге всё равно блокируется.
- `sandbox` — последним из тех, кто меняет bash-команду: guard'ы обязаны
  разбирать сырую команду, а не обёртку `bwrap`/`sandbox-exec`.
- `edit-check` последним — ему нужен чистый `tool_result`.

Следствия порядка закрыты явными мостами, а не угадыванием по тексту:

- bash-guard и sandbox. Guard не видит обёртку, поэтому спрашивает состояние
  песочницы через `extensions/sandbox-state.ts`: изолированную команду не
  спрашивает (изоляция уже ограничила хост), но «пол» жёсткого блока держит —
  рабочий каталог внутри песочницы доступен на запись. Нет sandbox'а или
  предикат бросил — guard спрашивает как обычно.
- bash-exit-hint и injection-guard. injection-guard закрывает вывод в
  `UNTRUSTED`-фрейс раньше, и строка `Command exited with code 1` перестаёт быть
  последней — hint срезает хвост фрейса перед проверкой.
- Субагенты. Состояние guard'ов из `guard-state.json` в ребёнке не читается:
  `dir-guard` всегда включён, `injection-guard`/`text-guard` в strict, у
  `bash-guard` остаётся «пол». `/dir-guard off` в родителе на детей не
  распространяется — это fail-safe, а не рассинхрон.
- edit-check запускает проверку через `spawn`, мимо `sandbox` и `bash-guard`:
  typecheck исполняется на хосте. Учитывайте это при `sandbox untrusted`.

Фильтры в `settings.json` порядок манифеста сохраняют. Одно исключение:
force-include вида `+extensions/...` дописывает файл в конец списка и порядок
ломает — для guard'ов это заметная смена поведения.

## Границы защиты

Guard'ы — это барьер от случайности модели, а не от атакующего с shell'ом.
Что они **не** делают:

- **PowerShell не разбирается.** Команды guard'ы анализируют bash'овые
  (`extensions/shell-parse.ts` — общий разбор токенов). Целевые платформы —
  Linux и macOS; `powershell` — не целевой инструмент, его вызовы guard'ы не
  оценивают (песочница `sandbox` на таких вызовах тоже не работает).
- **Неразрешимые токены не блокируются.** `$ПЕРЕМЕННАЯ`, глобы (`a*.txt`),
  backtick'и: разрешить путь нельзя, а блокировать наугад — ловить ложные
  срабатывания на каждом `grep x *.log`. Осознанный компромисс dir-guard.
- **Односегментные абсолютные пути** (`/models`, `/app`) не считаются
  хостовыми: в docker/k8s-командах это пути контейнера.
- **Регистр и алиасы shell'а** (function, alias, `~/scripts/rm`) не
  разворачиваются — голова команды берётся как есть.

Настоящий барьер — [sandbox](extensions/sandbox/): он ограничивает процесс,
а не намерение команды, и потому не зависит от качества разбора.

## Скиллы

| Скилл | Назначение |
|---|---|
| [session-insights](skills/session-insights/) | Анализ собственных pi-сессий (`~/.pi/agent/sessions`) → отчёт с рекомендациями и черновиками улучшений (новые скиллы, правила для AGENTS.md, каркасы экстеншенов). Read-only, Python 3 stdlib |
| [ui-design](skills/ui-design/) | Дизайн экрана по порядку: инвентарь существующей стилевой базы и компонентов, референсы, taste preflight, токен-план в `DESIGN.md` проекта, вёрстка на надутых данных, самопроверка. `references/anti-patterns.md` — признаки генерации и счётные ограничители; `references/data.md` — экраны с данными (вопрос → тип графика, оси и форматтеры `Intl`, вырожденные данные, состояния, плотность таблицы); `references/motion.md` — движение (носитель, motion-токены, `prefers-reduced-motion`, сниппеты) |
| [ui-review](skills/ui-review/) | Ревью вёрстки тремя скриптами: `lint-ui.mjs` по исходникам, `a11y.mjs` по экрану (axe-core, свой расчёт контраста, layout/motion/тап-цели), `perf.mjs` по скорости (LCP/CLS/INP/TBT, oversized-картинки, кто двигает макет); скриншоты в трёх ширинах с побитовым diff. Чеклист — `references/checklist.md`, поведение виджетов — `references/aria-patterns.md`, порядок правок скорости и бюджет в CI — `references/perf.md` |

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
для каждого расширения: порядок манифеста при этом сохраняется
(см. [Порядок загрузок](#порядок-загрузок)).

| Расширение | Фильтр |
|---|---|
| prompt-snippets | `extensions/prompt-snippets/*` |
| yolo | `extensions/yolo/*` |
| bash-guard | `extensions/bash-guard/*` |
| dir-guard | `extensions/dir-guard/*` |
| edit-fresh | `extensions/edit-fresh/*` |
| bash-exit-hint | `extensions/bash-exit-hint/*` |
| injection-guard | `extensions/injection-guard/*` |
| text-guard | `extensions/text-guard/*` |
| ask-user-question | `extensions/ask-user-question/*` |
| sandbox | `extensions/sandbox/*` |
| subagents | `extensions/subagents/*` |
| gen-speed | `extensions/gen-speed/*` |
| todo | `extensions/todo/*` |
| edit-check | `extensions/edit-check/*` |

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
for s in ui-design ui-review; do
  ln -sfn "/tmp/pi-ext/skills/$s" ~/.pi/agent/skills/"$s"
done
```

После установки `/reload` (или перезапуск pi). Браузерные скрипты (`a11y.mjs`,
`perf.mjs`) требуют playwright и chromium в том проекте, который проверяется
(скилл сам печатает команду установки, если пакета нет): `npm i -D playwright &&
npx playwright install chromium`. Скрипт ищет пакет от каталога запуска, поэтому
запускать надо из корня проверяемого проекта. Коды выхода: 0 — чисто, 1 — есть
находки или что-то не проверилось, 2 — неверные аргументы, 3 — playwright не найден,
4 — chromium не запустился; «не проверилось» и «нарушений нет» не смешиваются. В этом репозитории playwright и axe-core уже в devDependencies, поэтому
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

### Как пользоваться UI-скиллами

Два скилла, различие одно: строить или проверять. Скиллы включаются сами по
описанию в задаче; если не подхватились — явно `/skill:ui-design` или
`/skill:ui-review`. Для обоих есть prompt-сниппеты (они подмешивают короткий
каркас в первое сообщение).

Всё, что раньше было отдельными скиллами, теперь разделы внутри: экраны с данными
и движение — в `ui-design` (`references/data.md`, `references/motion.md`),
скорость — в `ui-review` (`references/perf.md`). Порядок в одном тикете: `ui-design`
(или правка экрана) → `ui-review`; внутри ревью скорость меряется, если экран
тяжёлый или есть жалобы.

Первый запуск в проверяемом проекте (один раз, если playwright там нет):

```bash
npm i -D playwright && npx playwright install chromium
```

Браузерные скрипты ищут playwright от каталога запуска, поэтому запускать нужно
из корня проекта. Коды выхода: `0` чисто, `1` находки или что-то не проверилось,
`2` неверные аргументы, `3` playwright не найден, `4` chromium не запустился.

```bash
S=$HOME/.pi/agent/git/github.com/stelmakhdigital/pi-extensions/skills/ui-review/scripts

node "$S/lint-ui.mjs" src --strict                    # по исходникам, браузер не нужен
node "$S/a11y.mjs" http://localhost:3000 \            # по экрану: axe, контраст, геометрия, скриншоты
  --widths 375,768,1440 --out ui-review/run-1 --wait 800 \
  --click "button.menu,button.new-item"
node "$S/a11y.mjs" http://localhost:3000 --out ui-review/run-2 --baseline ui-review/run-1
node "$S/a11y.mjs" http://localhost:3000 --out ui-review/run-dark --dark --widths 375,768,1440
node "$S/a11y.mjs" http://localhost:3000 --out ui-review/run-rm --reduced-motion --widths 1440
node "$S/perf.mjs" http://localhost:3000 --click "button.menu" --wait 1500
node "$S/perf.mjs" http://localhost:3000 --budget lcp=2500,cls=0.1,inp=200 --strict --json
```

`--baseline` сравнивает кадры с прошлым прогоном побитово и пишет `*-diff.png`;
`--axe ./node_modules/axe-core/axe.min.js` — для офлайна; `file://` годится для
статичного HTML, но там неполная ресурсная статистика и нет TTFB.

Состояния проверяются отдельными прогонами, а не глазами: `--dark` ставит
`color-scheme: dark` (контраст пересчитывается по тёмным цветам, кадры уходят в
`<width>-dark.png`), `--reduced-motion` ловит текст, оставшийся с `opacity: 0`
после отключения анимации (такой прогон валится с exit 1), `--zoom 2` ловит
обрезку при крупном тексте через CSS `zoom`.

В CI: `lint-ui.mjs src --strict` и `a11y.mjs <preview-url> --strict --json` на
каждый push, `perf.mjs <preview-url> --budget ... --strict` с бюджетом от текущих
чисел с запасом 10-15 процентов.

Ложное срабатывание лимта снимается на строку (`// ui-lint-disable <id>`) или на
правило целиком (`--rule-allow <id>`). Найденное правило не отключается «чтобы
не мешало»: в `ui-review` это находка с обоснованием.

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
  shell-parse.ts              # разбор bash-команд: токены, сегменты, головы, кандидаты путей
  paths.ts                    # canonical / resolvePath (realpath с шагом вверх)
  untrusted.ts                # «окно недоверия»: флаг внешнего контента в контексте
  sandbox-state.ts            # мост sandbox -> bash-guard: «будет ли команда изолирована»
  yolo/
    index.ts                  # флаг --yolo, команда /yolo, авто-доверие проекту, бейдж
  prompt-snippets/
    index.ts                  # расширение
    snippets/                 # сниппеты (по одному .md на правило)
  bash-guard/
    index.ts                  # запрос на рискованный bash + «пол» катастрофических
  dir-guard/
    index.ts                  # блок путей вне CWD и сверх allowlist'а секретов
  edit-fresh/
    index.ts                  # блок edit без свежего read
  bash-exit-hint/
    index.ts                  # штатный exit 1 у grep/diff — не ошибка
  text-guard/
    index.ts                  # стиль текста модели, автофикс эмодзи/стрелок
  injection-guard/
    index.ts                  # маркировка UNTRUSTED, блок «секрет + сеть», эскалация
  ask-user-question/
    index.ts
  sandbox/
    index.ts                  # per-command sandbox (bwrap / sandbox-exec)
  gen-speed/
    index.ts                  # бейдж скорости генерации токенов + TTFT в футере
  todo/
    index.ts                  # инструмент todo + виджет/оверлей списка задач
  edit-check/
    index.ts                  # typecheck/lint в конце прогона, ошибки — модели
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
    references/data.md        # экраны с данными: вопрос → тип графика, оси, Intl-форматтеры, вырожденные данные, состояния
    references/motion.md      # движение: носитель, токены, reduced-motion, scroll reveal, View Transitions, списки
  ui-review/
    SKILL.md                  # контекст → машинная проверка → рендер → скорость → находки
    references/checklist.md   # семантика/layout/motion/состояния/данные + эвристики Нильсена
    references/aria-patterns.md   # роли, клавиатура и возврат фокуса у самодельных виджетов
    references/perf.md        # замер → где вес → правки по одной → keep-or-revert → CI-гард
    scripts/
      a11y.mjs                # axe-core, контраст, layout-пробы, скриншоты по ширинам и состояниям (--dark/--reduced-motion/--zoom)
      perf.mjs                # LCP/CLS/INP/TBT, вес по типам, oversized-картинки, бюджет (playwright)
      lint-ui.mjs             # статические правила по исходникам, без браузера и зависимостей
      png-diff.mjs            # декодер/энкодер PNG и побитовое сравнение кадров, без зависимостей
      browser.mjs             # где искать playwright, chromium и axe-core (общий для браузерных скриптов)
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
- `addyosmani/agent-skills` — порядок работы с производительностью (measure →
  fix → verify → keep-or-revert, регресс-гард) и разделы про empty/error-состояния.
- `SvaraNova/skills` — формат `references/` со сниппетами (токен-шит, компонент,
  review-чеклист), motion-паттерны и шаблоны графиков без зависимостей.
- `plugin87/ux-ui-agent-skills` дополнительно — конспект ARIA-паттернов
  (`skills/ui-review/references/aria-patterns.md`) по WAI-ARIA Authoring
  Practices. MIT.

Витрины тем (`anthropics/skills` → theme-factory), готовые библиотеки токенов и
чужие on-disk киты в репозиторий не переносились: они завязаны на свой тулинг и
под свой формат, а польза от них — в правилах, которые уже в скиллах.

## Лицензия

MIT.
