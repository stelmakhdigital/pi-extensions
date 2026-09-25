# SPEC: собственный движок кодового графа (graft-engine)

Задача: убрать чужой runtime `@nanonets/graft` (npx, 128 МБ, tree-sitter-wasm для 15 языков,
LLM-SDK, MCP) из цепочки агента. Пишем своё: движок в `engine/graft/` (чистый TS) + тонкий
адаптер в `extensions/graft/`. Заменённый набор функций: build, map, ask, grep, callers,
skeleton, check, blast, --deep.

## Решения (согласовано с пользователем, 2026-09-24)
1. Парсер: **web-tree-sitter + wasm-грамматики** для TS/TSX, JS, Python.
2. v1 = структурный слой + **свой --deep** (суммаризация файла + per-symbol summary/crux,
   кэш по body_hash).
3. Хранилище — **полностью свой формат** (старый `graft/` перезаписывается; он gitignored —
   миграция = пересборка, git-археологии нет).
4. Код — локальный пакет `engine/graft/` (без pi-API, юнит-тестится напрямую) + тонкий слой
   в `extensions/graft/` (только тулзы/UI/хуки). **Никакого spawn CLI** — прямой import (jiti).
5. Deep: **только явная конфигурация** LLM (env/файл); без неё `build deep` — понятная
   ошибка, никакого дефолтного адреса.

## Хранилище (новый формат)
```
graft/
  .engine/
    graph.json       {version:1, meta:{builtAt, root, files:[{path,hash}]}, nodes[], edges[]}
    deep.json        {files:{path:{hash,summary}}, symbols:{nodeId:{hash,summary,crux:string[]}}}
  cards/<mirror>/    per-file markdown-карточки (сигнатуры + summary при наличии)
  index.md           верхнеуровневая карта (автогенерация: кластеры каталогов, хабы, hotspots)
```
Node: `{id: "path#symbol"|"path", name, kind: file|function|class|method|type, path,
span:{start,end}, signature, exported, bodyHash}`.
Edge: `{source, target, relation: calls|imports|references, confidence:"extracted"}`.

## Движок `engine/graft/` (модули)
- `scan.ts` — обход репо: `git ls-files` + untracked (fallback fs-walk); языки (v1.1):
  .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py (tree-sitter, двухпроходная экстракция) +
  .go/.rs/.c/.h/.cpp/.cc/.cxx/.hpp/.hh/.sh/.bash (tree-sitter + правила, `extractOther.ts`);
  исключения: node_modules, graft/, .git, dist, *.min.js, fixtures/tests-артефакты.

### 2b. v1.1 (после v1, 2026-09-24)
- **Member-цепочки вызовов** (extract + build): `new X().m()` / `x.m()`, где x — результат
  new/вызова/идент; резолв по `globalMethods` (имена методов классов) + `resolveVia`
  (new→класс; call→класс-результат; ident→locals). Полная типизация возвратных типов — вне.
- **Deep в ask/map**: ask — `↳ summary` + `crux:` у топ-хитов; map — темы (concepts) и
  file-summaries опционально (`{ deep: true }`); системный промпт — без deep (бюджет 120 с).
- **Concept-ноды** (`concepts.ts`): LLM-кластеризация файлов в 3–8 тем (каждый файл ровно в
  одной; жёсткий JSON), детерминированный dir-fallback; кэш `deep.concepts` по hash(пути+summaries);
  CLI `concepts`.
- **Viz** (`viz.ts`): `graft/viz.html` — self-contained SVG (кластеры каталогов, размер = degree,
  клик = подсветка соседей, deep-панель, темы); CLI `viz`.
- **Watch** (CLI): `fs.watch` recursive + debounce 1.5 с → инкрементальная пересборка.
- **MCP** (`bin/graft-mcp.mjs`): минимальный MCP-сервер (stdio, JSON-RPC 2.0, newline-delimited),
  7 инструментов (graft_ask/grep/callers/skeleton/map/check/blast); корень = env `GRFT_MCP_ROOT`
  или cwd; без внешних зависимостей (jiti + движок).
- **Типы (interface/type_alias)** теперь в deep-проходе (были function/method/class).

### 2c. v1.2 (2026-09-24, бэклог-итерация)
- **Type inference v1 (возвратные типы)**: явные аннотации TS/JS (`function f(): Foo`,
  `const f = (): Foo =>`) → `const x = f(); x.m()` резолвится в `Foo.m`
  (`extract.fnReturns` + `build.resolveVia`). Только явные типы, классы в-файле/импорты;
  full inference (возвратные выражения) — вне.
- **Языки +3: Java, C#, Kotlin** (`extractOther.ts`): классы, qualified-методы
  (enclosing class), именованные вызовы (`method_invocation` / `invocation_expression` /
  `call_expression`); callee — первая именованная нода (this/obj идут первыми).
  Резолв базовых имён (helper) → qualified-методы того же файла (short-name fallback).
- **Concepts-fallback без LLM** улучшен: корень — по языковой семье (root/ts-js, root/py,
  root/java, …), каталоги — темы; группы <2 файлов → «прочее».
- Языки движка теперь: ts/tsx/js/mjs/cjs/py (двухпроходные) + go/rust/c/cpp/sh/java/csharp/kotlin.

### 2d. v1.3 (2026-09-24, бэклог-итерация 2)
- **Возвратные выражения (inferred return)**: без аннотации — первое «return new X» в теле
  функции/стрелки (включая expression-body `=> new X()`) → fnReturns. Только `new X`
  (надежно); `return foo()`-цепи — вне.
- **Языки +3: Ruby, PHP, Swift** (`extractOther.ts`):
  - ruby: class/method (qualified), вызовы: `call` (callee = последний identifier — obj.helper)
    + базовый identifier в операторной позиции (body_statement);
  - php: class/method (qualified, имя-нода «name»), function_call_expression /
    member_call_expression ($this->helper);
  - swift: class/func (qualified), call_expression (simple_identifier | navigation_expression
    self.m()/obj.m() — последний ident в цепочке).
- Механика: `callNodes[]` (несколько типов call-нод), `calleeFrom: "lastIdent"`,
  `bareIdentCall`; enclosing class — по parent-walk (class_declaration / object_declaration /
  ruby class, имя-ноды: identifier/type_identifier/simple_identifier/name/constant).
- Языки движка теперь (15): ts/tsx/js/mjs/cjs/py + go/rust/c/cpp/sh/java/csharp/kotlin/ruby/php/swift.
### 2e. v1.4 (2026-09-24, бэклог-итерация 3)
- **Return-вызовы (транзитивно)**: `function wrap() { return base(); }` → fnReturns[wrap] =
  fnReturns[base] (до 3 хопов, без циклов; первое «return g()» в теле).
- **Языки +3: Dart, Scala, Lua** (`extractOther.ts`):
  - dart: class/method (qualified); вызовы — bare identifier в expression_statement;
    **pairedBody**: в dart-грамматике function_body — SIBLING метод_signature, а не child
    (walk тела с caller=метод; по node.id — child-обёртки web-tree-sitter не равны по ссылке!);
  - scala: class/def (qualified, имя = первый identifier, modifiers первыми), call_expression;
  - lua: function_declaration (dot/method index → qualified «Service.m»), function_call
    (callee: identifier или метод внутри method/dot_index_expression — lastIdent).
- Языки движка теперь (18): ts/tsx/js/mjs/cjs/py + go/rust/c/cpp/sh/java/csharp/kotlin/ruby/php/
  swift/dart/scala/lua.
### 2f. v1.5 (2026-09-24, бэклог-итерация 4: авто-refresh deep)
- **Auto-deep**: при структурном `build` (без явного `--deep`) движок сам делает
  **инкрементальный deep-проход**, если: (а) `deep.json` уже не пуст (`hasDeep`), (б) задан
  env-конфиг `GRFT_LLM_BASE_URL`/`GRFT_LLM_MODEL`. Только изменившиеся bodyHash перечитываются;
  **без дрейфа — 0 LLM-вызовов** (весь кэш). `deepCfgFromEnv()` в deep.ts, ветка в `build()`
  index.ts. Отключение: `autoDeep: false` (API) или `GRFT_AUTO_DEEP=0` (env).
- CLI `watch`: после каждого rebuild auto-deep включён автоматически; строка отчёта
  показывает `+N файлов/+M символов (кэш a/b)`.
- Semантика: auto-deep — «тихое» обновление по дрейфу; `build deep` остаётся явным
  (первый запуск / полный аудит). Концепты при auto-deep пересобираются (кэш по hash summaries).
### 2g. v1.6 (2026-09-24, бэклог-итерация 5: дженерики — финальная)
- **Дженерики в возвратных типах**: `typeOfAnnotation` — `Promise<T>`/`PromiseLike<T>` →
  первый не-примитивный аргумент T (`Promise<string>` → null, `Foo<T>` → Foo как и раньше).
- **Типизированные локальные**: `const x: Foo = …` — аннотация переменной (authoritative,
  перекрывает инференс из value); параметры функций/методов/стрелок `function f(o: Foo)` →
  `collectParamTypes` (required/optional/formal_parameter, type_annotation child);
  PendingVia + kind "type" (resolveVia: сразу класс).
- **await**: `const p = await f()` — value-unwrap await_expression → вызов под ним
  (f → fnReturns, т.е. Promise-unwrapped тип).
- Сценарии: `async function use(): Promise<Pair> { const p = await mkPair(); p.get(); }`
  → edge use→Pair.get; `function greet(g: Greeter) { g.hi(); }` → greet→Greeter.hi.
- Ограничения (осознанные): vars — file-уровень (не per-function scope); return-цепи ≤3 хопов;
  Array/Map-элементы не инферятся (semантика: значение выражения — не элемент).
- **Бэклог графта закрыт** (итерации v1.1–v1.6); остаток — только «ещё языки» по спросу.
- `parse/` — загрузка web-tree-sitter + wasm (deps: `web-tree-sitter`, `tree-sitter-wasm`);
  парсинг → дерево; кэш парсинга в памяти на сессию.
- `symbols.ts` — узлы: функции/классы/методы/типы/константы-экспорты, span, signature,
  exported. Импорты: разрешение относительных спецификаторов → file (TS/JS); Python —
  relative imports (черепов, `from .x import y`).
- `edges.ts` — call sites: identifier → разрешение в скоупе файла + по импортам;
  relation calls/imports. Точность v1: именовые вызовы (не member-chain через this/obj —
  только `name(` и `obj.name(`, где obj-тип разрешим локально; недоразрешённые — не пишем).
- `store.ts` — запись/чтение graph.json+deep.json+cards+index.md; fingerprint по
  sha1(content) каждого файла.
- `query/` —
  - `skeleton(file)` — сигнатуры файла;
  - `callers(sym, {direction, depth})` — обход рёбер (out — транзитивно);
  - `map({maxDirs})` — кластеры каталогов + хабы (in-degree) + hotspots; формат как у
    текущего `<graft>`-блока (совместимый с промптом модели);
  - `ask(query)` — ранжирование: точные/частичные имена символов + файла, бонус за
    связанность (in-degree), топ-N с file:line и snippet;
  - `grep(pattern, {scope, fixed, ignoreCase})` — regex по исходникам из скана,
    хиты группированы по замыкающему символу, ранжированы по в-степени файла;
  - `check()` — дрейф: added/removed/changed (по fingerprint) → JSON {ok, stale…};
  - `blast(base?)` — `git diff -U0 [base]` → затронутые файлы/строки → nodes в span →
    транзитивные зависимые (in-рёбра).
- `deep.ts` — LLM-проход: `build deep`:
  - конфиг (обязательный): env `GRFT_LLM_BASE_URL`, `GRFT_LLM_MODEL`, `GRFT_LLM_API_KEY`
    (openai-chat-формат; fetch, без SDK); без baseUrl/model — ошибка с инструкцией;
  - на файл: prompt «что делает файл» (сkeleton + размер) → summary;
  - на символ: prompt «summary + crux» (исходник символа) → JSON {summary, crux:[строки
    дословно из исходника]} — валидация, что crux ⊆ исходника (иначе crux=undefined);
  - кэш: только символы/файлы с изменившимся bodyHash (инкрементально);
  - лимиты: таймаут/запрос, retry 1, прогресс в stdout (для CLI-прогона /graft build deep).

### 2h. v2.0 (2026-09-25, программа A: автоматизация)
- **refresh.ts**: fingerprint `graft/.engine/fingerprint.json` (size+mtime, ~мс);
  `driftReport()` — added/removed/changed; `ensureFresh()` — тихая пересборка при дрейфе
  (вызывается в каждом query-инструменте: расширение/MCP/CLI; env `GRFT_NO_REFRESH=1` —
  отключить). Без TTL-кэша (кэш глотал дрейф — баг v2.0, исправлено).
- **Auto-rebuild после правок кода**: расширение — хук `tool_result` (write/edit) →
  `enableAutoRebuild(build)` (дебаунс 4с, coalescing); флаг `--graft-auto-rebuild`;
  badge «syncing…» → «graft: synced · N% deep» / «⚠ N stale · N% deep» (deepCoverage()).
- **check exit-code**: дрейф → `process.exitCode = 1` (CI-friendly); `check --json` то же.
- `scan.ts`: единый `isIndexablePath()` для скана и fingerprint.

### 2i. v2.1 (монорепо-скупы, D10)
- `detectScopes(paths)` — подпроекты по маркерам (package.json, pyproject.toml,
  Cargo.toml, go.mod, pom.xml, build.gradle*); `Graph.meta.scopes` (имя → файлы).
- ask: scope-fusion — глобальный топ-6 + топ-3 по каждому затронутому скупу, метка
  `[scope]`; map: блок `scopes:`; grep: фильтр по именованному скупу.

### 2j. v2.2 (+7 языков, D9)
- R, Elixir, Solidity, OCaml, Zig, Clojure, Nix (итого 25 расширений/семейств).
- extractOther-правила: R (name = LHS `<-`), Elixir (def/defmodule через call-ноды),
  OCaml (value_name в let_binding, вложенные), Zig (callee — plain identifier),
  Clojure (head = sym_lit, fn.type), Nix (binding в attrset; top-level в этом wasm-бUILDe
  ломается — ERROR-ноды, учитывается только attrset).

### 2k. v2.3 (full-fidelity B6)
- Go/Java/Kotlin/PHP/Swift — полные правила: member-вызовы obj.m() → pending
  (ident), type-hints локальных переменных (varAssigns), конструкторы new T/&T{}.
- `build.ts`: globalMethods теперь включает kind "method" И "function"
  (Kotlin/Swift-методы — kind function).
- extractOther возвращает реальные vars+pending (были пустыми).

### 2l. B5 (LSP-синхронизация)
- **Кандидаты**: сборка пишет `graft/.engine/unresolved.json` — нерешённые member-вызовы
  (метод не найден статически: наследование, duck-typing, динамика) с file/line/col/caller.
- **lsp.ts**: stdio LSP-клиент (JSON-RPC 2.0, Content-Length-фрейминг): initialize →
  initialized → didOpen (на файл) → textDocument/definition на позицию имени метода →
  target node (по строке) → рёбра `confidence: "lsp"` (merge в graph.json, дедуп).
- Серверы (LSP_SERVERS, опциональны): ts/js→typescript-language-server,
  py→pyright-langserver, go→gopls, rust→rust-analyzer, c/cpp→clangd. Без бинаря —
  честный отчёт + инструкция установки.
- CLI: `lsp-status` (какие серверы есть/нет, сколько кандидатов), `lsp-sync` (прогон).
- Живая проверка: pyright — `b.inherited()` (Box(Base), Base в др. файле) →
  edge `use → Base` (lsp). Статический путь при этом уже резолвит прямые методы.

### 2m. C7/C8 (концепты, карточки, viz)
- **C7 Notes**: в карточках блок между маркерами
  `<!-- graft:notes:begin -->…<!-- graft:notes:end -->` — сохраняется при регенерации
  writeCards (read → rm → rewrite + Notes).
- **C7 concept-links**: типизованные связи между темами (детерминированные, по рёбрам
  графа): файл→тема (part_of уже в topics.files), тема→тема «uses» — счётчик рёбер между
  файлами тем (топ-20). deep.concepts.links; вывод в map (deep).
- **C8 viz serve**: `graft viz --serve [порт]` — HTTP: `/` (viz.html + live-reload:
  fetch /api/graph каждые 5с, по изменению — reload), `/api/graph` (текущий graph.json).
  Без флага — как раньше (writeViz → graft/viz.html).

### 2n. E11/E12 (CLI UX, init/uninstall)
- `ask --json` (askScore/askJson: результаты с полями).
- `blast`: `--format text|json|markdown`, `--no-owners` (owner — git log -1 на файл),
  `--name` (LLM-имена зон, нужен LLM-конфиг), `--export-viz <dir>` (writeBlastViz —
  сабграф зон + зависимостей в dir/index.html).
- `init` / `uninstall` (wiring.ts): секция AGENTS.md между маркерами graft:begin/end
  (идемпотентная; dry-run) + mcpServers.graft в .mcp.json (merge, удаляем только graft).
  graft/ не трогает. uninstall без -y — dry-run.

## CLI (утилита для рук) — `engine/graft/bin/graft.mjs`
`build [--deep] [dir]`, `map`, `ask`, `grep`, `callers`, `skeleton`, `check [--json]`,
`blast`. Тонкая обёртка над API (человеческий вывод). Не обязателен для расширения.

## Расширение `extensions/graft/index.ts` (переписать)
- `import { engine } from "../../engine/graft/src/index.ts"` (jiti компилирует TS).
- Те же имена/схемы тулзов: graft_ask, graft_grep, graft_callers, graft_skeleton, graft_map,
  graft_check, graft_blast (семантика как сейчас; параметры те же).
- Секция `<graft>`: engine.map(root) на before_agent_start (TTL-кэш 120s, инвалидация
  после edit/write); push-режим `--graft-push` = engine.ask(prompt), топ-4000.
- Blast-хук: после write/edit → engine.blastFile(path) → дописанный блок «🌿 blast».
- Бейдж: engine.check(root) → `graft: synced` / `⚠ N stale` / `нет графа — build`.
- Корень: ближайший каталог вверх с `graft/.engine/graph.json` (маркер нашего формата).
- `/graft` — статус; `/graft build` / `/graft build deep` (deep — с конфигом из env;
  при отсутствии — ошибка с подсказкой).
- Убирается: runGraft/spawn, resolveGraftCommand, npx, DO_NOT_TRACK (чужого нет).

## Тесты
- `test/graft-engine.test.mjs` (node, без pi): фикстуры TS/JS/PY → parse (узлы/рёбра),
  skeleton/callers/map/ask/grep/check/blast на in-memory-скане; deep — с фейк-LLM
  (локальный http-стаб, openai-chat); store roundtrip; drift.
- smoke.test.mjs: секция «graft-engine: расширение грузится, тулзы регистрируются,
  engine импортируется».
- tsc --strict --noUnusedLocals по engine/ и extensions/graft.

## package.json
- deps: `web-tree-sitter`, `tree-sitter-wasm` (локально, lock-файл).
- `pi.extensions[]` без изменений (extensions/graft/*).
- Удалить упоминания @nanonets/graft (доки, README) после миграции.

## Вне v1 (бэклог)
- (v1.1–v1.3 выполнено: 15 языков, MCP, viz, concept-ноды + fallback, deep в ask/map, member-цепочки, watch, return-типы + return-выражения)
- Полная типизация (return-вызовы, дженерики), авто-refresh deep, прочие языки (100+ грамматик в tree-sitter-wasm)
  (сверх per-file/per-symbol), авто-refresh по watch, scorecard качества.

## 5b. Конфигурация deep (как запускать)

Конфиг — ТОЛЬКО env (явный; без `GRFT_LLM_BASE_URL`/`GRFT_LLM_MODEL` deep отказывается
запускаться с понятной ошибкой; дефолтных эндпоинтов в коде нет):

| env | значение |
|---|---|
| `GRFT_LLM_BASE_URL` | корень openai-chat-совместимого API (запрос уходит на `$BASE_URL/chat/completions`; обычно `http://<host>:8000/v1`) |
| `GRFT_LLM_MODEL` | имя модели (как в `/v1/models`) |
| `GRFT_LLM_API_KEY` | опц.; отправляется как `Authorization: Bearer <key>` (локальные vLLM часто принимают любой) |

Запуск:
- В pi: `GRFT_LLM_BASE_URL=... GRFT_LLM_MODEL=... pi` (или env в shell) → `/graft build deep` (или `/graft build` — только структура).
- Консоль: `GRFT_LLM_BASE_URL=... GRFT_LLM_MODEL=... node engine/graft/bin/graft.mjs build deep .` (или `--deep`).

Параметры прохода (зашиты): температура 0.2; таймаут запроса 90s, 2 попытки; файл —
первые 6000 символов + список символов, summary ≤40 слов одним предложением; символ
(function/method/class) — тело ≤4000 символов, ответ строго JSON
`{"summary": ≤30 слов, "crux": [1-3 строки КОДА ДОСЛОВНО]}` (строки крупнее 4000 —
summary без crux); crux валидируется дословно по исходнику (до 3 строк).
Кэш — по bodyHash: повторный проход пересчитывает только изменившееся/упавшее
(упавшие легко перепопытать: `build deep` ещё раз — инкрементально).

Проверенный прогон (2026-09-24): cat-vllm `qwen3.8-27b-dflash2`, 28 файлов + 303 символа,
586s, 3 упавших JSON-ответа перепопало вторым проходом за 6s (итог: 0 ошибок,
286 символов с валидным crux). Qwen3-ответы приходят с полем `reasoning` — на парсинг
не влияет (читается `choices[0].message.content`).
