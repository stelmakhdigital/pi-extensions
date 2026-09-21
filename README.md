# pi-extensions

Коллекция небольших расширений для [pi](https://pi.dev) в одном git-репозитории.
Установить можно всё целиком — или только нужные расширения (см. [Установка по отдельности](#установка-по-отдельности)).

## Расширения

| Расширение | Назначение |
|---|---|
| [prompt-snippets](extensions/prompt-snippets/) | Комбинируемые одноцелевые промпт-правила: включаются на каждое сообщение через меню (`alt+s` / `/snippets`), вставляются перед или после вашего текста |
| [bash-guard](extensions/bash-guard/) | Перехватывает вызовы инструмента `bash`: интерактивный запрос «Выполнить / Отменить» для рискованных команд в главной сессии, жёсткий блок катастрофических операций в субагентах |
| [ask-user-question](extensions/ask-user-question/) | Инструмент `ask_user_question`: задаёт пользователю один вопрос (текст, выбор одного, мультивыбор) и ждёт ответа |

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
расширения через фильтры (объектная форма записи пакета). Пример — только
`prompt-snippets` в глобальных настройках `~/.pi/agent/settings.json`:

```json
{
	"packages": [
		{
			"source": "git:github.com/stelmakhdigital/pi-extensions@v0.1.0",
			"extensions": ["extensions/prompt-snippets/index.ts"]
		}
	]
}
```

Глобальные паттерны тоже работают, например:

```json
"extensions": ["extensions/prompt-snippets/*", "extensions/bash-guard/*"]
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
```

## Лицензия

MIT.
