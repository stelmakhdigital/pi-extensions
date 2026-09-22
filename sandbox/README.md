# pi-sandbox — Docker-контур для недоверенного кода

Готовый образ, в котором **весь процесс pi** (включая bash/read/write и
инструменты расширений) работает внутри контейнера. Для сессий с
недоверенным кодом: prompt injection, чужой upstream, репо с интернета.

Схема из официальной документации pi (containerization.md, «Plain Docker»):
cwd хоста монтируется в `/workspace`, изменения файлов видны на хосте
(write-through), конфиги/сессии pi живут в named volume.

## Сборка

```bash
cd sandbox
docker build -t pi-sandbox -f Dockerfile .
```

## Запуск

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v pi-agent-home:/root/.pi/agent \
  pi-sandbox
```

- `-v "$PWD:/workspace"` — проект, с которым работаем (из него запускай).
- `-v pi-agent-home:/root/.pi/agent` — отдельный конфиг/сессии внутри
  контейнера. **Не** монтируй хостовый `~/.pi/agent` — тогда в контейнер
  попадут ключи провайдеров и сессии хоста.
- Ключ провайдера передаётся через `-e`: `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY` и т.д. — какой нужен.

Полезные варианты:

```bash
# Несколько каталогов (монорепо, зависимости рядом)
docker run --rm -it -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" -v ~/Code/shared:/shared:ro \
  -v pi-agent-home:/root/.pi/agent pi-sandbox

# Недолгий headless-запуск
docker run --rm -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" -v pi-agent-home:/root/.pi/agent \
  pi-sandbox -p "найди все вызовы auth() и опиши flow"
```

## Что изолирует / что нет

| Изолировано | Не изолировано |
|---|---|
| Файловая система хоста (кроме смонтированных каталогов) | API-ключ, переданный через `-e` (вижен процессам контейнера) |
| Процессы/сети хоста (по умолчанию у контейнера свой net-namespace) | Смонтированный `/workspace` — туда контейнер пишет прямо на хост |
| | SSH-агенты и сокеты, если их пробросить (не пробрасывай) |

Для жёсткой модели (ключ не попадает в контейнер вообще, подставляется
прокси при исходящих запросах) смотрите Docker Sandboxes (`sbx`) —
описание в docs/containerization.md.

## Правило использования

- Доверенные проекты: pi + bash-guard на хосте, без контейнера.
- Недоверенный код: сессия под `pi-sandbox`. Расширения из
  `stelmakhdigital/pi-extensions` внутри контейнера ставятся так же:
  `pi install git:github.com/stelmakhdigital/pi-extensions@<тег>`.
