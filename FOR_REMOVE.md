# FOR_REMOVE — graft переезжает в отдельное репо pi-graft

После установки **pi-graft** (github.com/stelmakhdigital/pi-graft) как отдельного
пакета из этого репо нужно **убрать всё перечисленное ниже**. Никакой другой
код к graft не относится; остальная часть репо не меняется.

## 1. Удалить целиком (каталоги / файлы)

| Путь | Содержимое |
|---|---|
| `engine/graft/` | движок целиком: `package.json`, `bin/` (`graft.mjs`, `graft-mcp.mjs`), `src/` |
| `extensions/graft/` | `index.ts`, `README.md` |
| `skills/graft/` | `SKILL.md` |
| `test/graft-engine.test.mjs` | тесты движка — целиком |

## 2. `test/smoke.test.mjs` — удалить graft-секцию

Секция **«=== 4. graft ===»**: строки **181–452** (до строки перед
`// === 5. sandbox ===` на стр. 455; строки 453–454 — пустые).

Анкер начала (стр. 181):
```
// === 4. graft ===
```
Анкер конца (стр. 452, закрывающая скобка блока; далее пустые строки и):
```
// === 5. sandbox ===
```
Внутри секции: `jiti("../extensions/graft/index.ts")`, `engineBin =
"../engine/graft/bin/graft.mjs"`, `graft-mcp.mjs`, все проверки
`graft_*` — удаляется всё подряд, ничего другого в секции нет.

Примечание: строки **694** и **729** (`"graft", "graft: ok"` в секции subagents)
— это тест статуса *произвольного* расширения, не зависит от graft: **не трогать**.

## 3. `package.json` (root)

- `dependencies`: удалить строки `"web-tree-sitter": "^0.26.13"` (стр. 13) и
  `"tree-sitter-wasm": "^1.1.6"` (стр. 12) — после удаления поправить запятые.
  Якоря:
  ```json
  "tree-sitter-wasm": "^1.1.6",
  "web-tree-sitter": "^0.26.13"
  ```
- `pi.extensions`: удалить строку `"extensions/graft/index.ts",` (стр. 32).
- `pi.skills`: удалить строку `"skills/graft",` (стр. 38).
- После удаления: `npm install` (обновит `package-lock.json`).

## 4. `README.md`

- **Стр. 13** — строка graft в таблице расширений:
  ```
  | [graft](extensions/graft/) | Кодовый граф: нативные инструменты `graft_ask/grep/callers/skeleton/map/check/blast` (свой движок `engine/graft/`), ... |
  ```
- **Стр. 55** — строка в таблице «Установка по отдельности»:
  ```
  | graft | `extensions/graft/*` |
  ```
- **Стр. 109–145** — секция целиком: заголовок `### Только graft` (стр. 109)
  по строку `Детали — в `extensions/graft/README.md`.` (стр. 145), включительно.
  Следующая секция `### Только sandbox` — с ней ничего не делать.
- **Стр. 265–266** — в дереве «Структура»:
  ```
  graft/
    index.ts                  # тонкий адаптер pi-graft-engine (без spawn)
  ```

## 5. `.gitignore` — **опционально**

Строки 3–4:
```
# graft's local graph cache — regenerable, not committed (run `graft build`).
/graft/
```
Можно **оставить** — безвредно (паттерн `/graft/` в корне всё равно не конфликтует
с будущим отдельным репо pi-graft). Удалять только если хочется чистоты.

## Порядок работ

1. Установить pi-graft как отдельный пакет (settings.json → `pi-graft`).
2. Удалить/вырезать всё из пунктов 1–4.
3. `npm install` → прогнать `npm test` (smoke без секции 4) — всё зелёное.
4. Запустить pi: инструменты `graft_*` и скилл должны приходить из pi-graft.
