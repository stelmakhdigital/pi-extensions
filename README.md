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
| [sandbox](extensions/sandbox/) | Пер-командная изоляция bash-вызовов агента (L1): bwrap (Linux) / sandbox-exec (macOS), уровни dev/untrusted/vm, маркер `.sandbox` по репо, fake $HOME, env-allowlist |

## Установка

Целиком:

```bash
pi install git:github.com/stelmakhdigital/pi-extensions@v0.1.0
```

После установки `/reload` (или перезапуск pi). Обновление:

```bash
pi update --extensions          # обновить пакеты
pi install git:github.com/stelmakhdigital/pi-extensions@v0.1.1   # перевязать на новый тег
```

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

Далее — пример для каждого (глобальные настройки `~/.pi/agent/settings.json`).

### Только prompt-snippets

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
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
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
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
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
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
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
			"extensions": ["extensions/graft/*"]
		}
	]
}
```

Даст инструменты `graft_ask`, `graft_grep`, `graft_callers`, `graft_skeleton`,
`graft_map`, `graft_check`, `graft_blast`, секцию `<graft>` в системном промпте,
blast radius после write/edit, бейдж свежести и команду `/graft`.
Вне репо с построенным графом (`graft build`) расширение молчит.
CLI ставится отдельно: `npm i -g @nanonets/graft` (без него расширение
автоматически использует `npx -y @nanonets/graft`).

### Только sandbox

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
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

### Несколько расширений

Несколько паттернов в одном пакете (или в разных записях пакета — так же):

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
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
    index.ts                  # интеграция @nanonets/graft (CLI) в pi
  sandbox/
    index.ts                  # per-command sandbox (bwrap / sandbox-exec)
sandbox/
  Dockerfile                  # pi-контур для недоверенного кода (см. sandbox/README.md)
  README.md
```

## Лицензия

MIT.
