#!/usr/bin/env python3
"""Digest pi-сессий для анализа harness и генерации рекомендаций.

Собирает cross-session метрики: стоимость (или токены, когда cost = 0), ошибки
инструментов с сигнатурами, ретраи, поправки пользователя, объёмы tool output и
повторяющиеся строки промптов, РАЗДЕЛЯЯ их на три корзины:

  noise  — вставленные логи/выводы (error, fatal, sqlstate, таймстемпы, hex):
           это следствие аварии, а не правило поведения; в AGENTS.md не идёт;
  rule   — короткая императивная строка пользователя («не пиши», «всегда ...»):
           кандидат в AGENTS.md или в guard;
  fact   — строка с конкретикой проекта (роль, хост, имя сервиса): кандидат в
           факты проекта (AGENTS.md репозитория), а не в глобальное правило.

Plus частотные токены проекта (роли, хосты, имена сервисов) — их и стоит
записывать как проверенные факты, а не пересказывать логи.

Вывод — markdown (по умолчанию) или --json. Read-only.

Примеры:
  python3 insights.py --since 30d
  python3 insights.py --since 60d --cwd pi-extensions
  python3 insights.py --errors-only --top 20
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter

import sessions as S


STOPWORDS = set("""
a an and are as at be but by for from has have if in into is it its me my not of
on or so that the this to was were will with you your i we our us he she they
i'm it's don't can't won't
a al are as at be but by for from has have if in is it me my not of on so that
the this to was with you your i we our us
в во не и и ли или ни о об на по за от до у из как что это тот такой надо нужно
можешь сделай сделать сделай сделаем да нет не просто тоже еще вот тут там там
"""
                 .split())

_WORD_RE = re.compile(r"[a-zа-яё0-9_]{4,}")

# Вставленные логи и вывод команд = данные, а не instructions для harness.
LOG_RE = re.compile(
    r"\b(error|errors|fatal|warn(?:ing)?|exception|traceback|panic|sqlstate \d+|"
    r"failed to connect|status is pending|exit code \d+|refused|denied|unauthorized)\b"
    r"|\"level\"\s*:\s*\"(error|info|warn|debug)\""
    r"|^\s*[{\[]|^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|^\s*\d{4}/\d{2}/\d{2}",
    re.IGNORECASE,
)
# Изменчивое: hex/uuid/ip/таймстемп/путь. Две и более метки = вставленный вывод.
VOLATILE_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}|0x[0-9a-f]+|\b\d{1,3}(\.\d{1,3}){3}\b|"
    r"\b\d{2}:\d{2}:\d{2}\b|(?:/\w[\w.\-]*){2,}",
    re.IGNORECASE,
)
# Вывод команд (go/git/docker/psql/k8s) — тоже данные, а не текст пользователя.
CMD_OUTPUT_RE = re.compile(
    r"^(?:go: |ok\s+\S+\s+\d|--- (?:FAIL|PASS)|=== (?:RUN|PAUSE|CONT)|FAIL\s\S+\s"
    r"|Initialized empty Git|Receiving objects|Resolving deltas|Cloning into|HEAD is now"
    r"|Running with |Using (?:Kubernetes|Docker|image )|Executing \"|=> => |Step \d+/"
    r"|\(no output\)|\$ |\(setsid\)|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+\.go:\d+"
    r"|[\w./-]+\.go:\d+|\s*SELECT\s|\s*\|.*\|\s*$|^=> "
    r"|^\s*#\d+\s|\[no test files\]|^\s*\S+\s{2,}\||^\s*(?:✔|✓|✗)"
    r"|^(?:Attaching to|Container |Network |Volume |Checking out|Creating |Created |Pulling )"
    r"|ContainersNot\w+|Readiness probe failed|exited with code \d"
    r"|^on shared \S+, system ID:|^If this is a private repository|^\S+@\S+:\S*\$"
    r")",
    re.IGNORECASE,
)
# Колонки из 3+ пробелов — выравнивание вывода (go test, docker compose, kubectl get).
PADDING_RE = re.compile(r"\S\s{3,}\S")
# Императивная правка пользователя (только начало строки).
RULE_RE = re.compile(
    r"^(добавь|используй|проверь|всегда|никогда|помни|правило|делай|пиши|читай|"
    r"запускай|сначала|необходимо|нельзя|нужно|перед тем|если |смотри|не |не надо|"
    r"always|never|don't|do not|use |add |remember|rule:|prefer|check |run |must )",
    re.IGNORECASE,
)
# Конкретика проекта: snake_case идентификатор, домен/хост, k8s-имя, DSN.
TOKEN_RE = re.compile(
    r"\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+\b"
    r"|\b[a-z0-9][\w-]*(?:\.[\w-]+){2,}\b"
    r"|\b\w+@[a-z0-9.-]+:\d+\b",
    re.IGNORECASE,
)
MIN_SIGNAL_CHARS = 20


def normalize_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip()).lower()


def classify(line: str) -> str:
    """noise | rule | fact | other — по первой же подействовавшей проверке."""
    if len(line) < MIN_SIGNAL_CHARS:
        return "other"
    if len(line) > 300 or LOG_RE.search(line) or CMD_OUTPUT_RE.match(line) \
            or len(VOLATILE_RE.findall(line)) >= 2:
        return "noise"
    # выравнивание вывода без кириллицы — почти всегда вывод, а не правка
    if PADDING_RE.search(line) and not re.search(r"[а-яё]", line, re.IGNORECASE):
        return "noise"
    if RULE_RE.match(line):
        return "rule"
    if TOKEN_RE.search(line):
        return "fact"
    return "other"


def prompt_lines(s) -> list[str]:
    out = []
    for text in s.user_texts:
        for line in text.splitlines():
            line = line.strip()
            if line and re.search(r"[\wа-яё]", line):
                out.append(line)
    return out


def _signal_rows(counter: Counter, samples: dict, limit: int, min_count: int = 2) -> list[dict]:
    rows = []
    for key, n in counter.most_common(limit * 3):
        if n < min_count:
            break
        rows.append({
            "line": samples.get(key, key)[:200],
            "count": n,
            "projects": sorted(samples.setdefault(f"{key}:projects", set())),
        })
        if len(rows) >= limit:
            break
    return rows


def build_digest(summaries, args) -> dict:
    total_cost = sum(s.cost_total for s in summaries)
    total_cache_w = sum(s.cost_cache_write for s in summaries)
    total_tokens = sum(s.tok_input + s.tok_output for s in summaries)
    per_session_tokens = sorted(s.tok_input + s.tok_output for s in summaries)

    errors_by_tool: Counter = Counter()
    error_sessions: dict[str, set] = {}
    error_sig: dict[str, Counter] = {}
    retries_total = 0
    corrections_total = 0
    correction_lines: Counter = Counter()
    correction_projects: dict[str, set] = {}
    max_tool_output: dict[str, int] = {}
    compactions = 0
    models: set = set()
    inj_count: Counter = Counter()
    inj_chars: Counter = Counter()
    for s in summaries:
        for name, chars in s.skill_injections:
            inj_count[name] += 1
            inj_chars[name] += chars
        errors_by_tool.update(s.errors_by_tool)
        for t, n in s.errors_by_tool.items():
            error_sessions.setdefault(t, set()).add(s.short_id)
            sig = error_sig.setdefault(t, Counter())
            for signature, c in (s.error_sig_by_tool.get(t) or {}).items():
                sig[signature] += c
        retries_total += s.retries
        compactions += s.compaction_count
        models |= s.models
        for line in s.corrections:
            corrections_total += 1
            k = normalize_line(line)
            correction_lines[k] += 1
            correction_projects.setdefault(k, set()).add((s.cwd or "?").rsplit("/", 1)[-1])
        for t, ln in s.tool_output_max.items():
            max_tool_output[t] = max(max_tool_output.get(t, 0), ln)

    # Повторяющиеся строки промптов: три корзины + отдельные сессии-проекты.
    buckets: dict[str, Counter] = {"rule": Counter(), "fact": Counter(), "noise": Counter()}
    samples: dict = {}
    tokens: Counter = Counter()
    token_projects: dict[str, set] = {}
    for s in summaries:
        project = (s.cwd or "?").rsplit("/", 1)[-1]
        for line in prompt_lines(s):
            kind = classify(line)
            if kind == "other":
                continue
            key = S.redact(line, 160)
            buckets[kind][key] += 1
            proj_set = samples.setdefault(f"{key}:projects", set())
            proj_set.add(project)
            samples.setdefault(key, line.strip())
            if kind in ("fact", "noise"):
                for tok in TOKEN_RE.findall(line):
                    tok = tok.lower()
                    if len(tok) < 6 or tok in STOPWORDS:
                        continue
                    tokens[tok] += 1
                    token_projects.setdefault(tok, set()).add(project)

    # Топ сессий: когда провайдер не отдаёт цены (cost == 0), сортировка по
    # стоимости вырождается в произвольную — падаем на токены.
    sort_by_cost = total_cost > 0
    sessions_rows = []
    for s in summaries:
        sessions_rows.append({
            "id": s.short_id,
            "started": S.fmt_ts(s.started_at),
            "cwd": (s.cwd or "?").rsplit("/", 1)[-1] or s.cwd,
            "messages": s.message_count,
            "calls": s.tool_call_count,
            "errors": s.error_count,
            "retries": s.retries,
            "corrections": s.correction_count,
            "compactions": s.compaction_count,
            "cost": s.cost_total,
            "tokens": s.tok_input + s.tok_output,
            "cacheW": s.cost_cache_write,
        })
    sessions_rows.sort(key=lambda r: (r["cost"] if sort_by_cost else r["tokens"]), reverse=True)

    by_project: dict[str, dict] = {}
    for r in sessions_rows:
        p = by_project.setdefault(r["cwd"], {"project": r["cwd"], "sessions": 0,
                                             "tokens": 0, "errors": 0, "retries": 0,
                                             "corrections": 0})
        p["sessions"] += 1
        p["tokens"] += r["tokens"]
        p["errors"] += r["errors"]
        p["retries"] += r["retries"]
    for s in summaries:
        pr = (s.cwd or "?").rsplit("/", 1)[-1]
        if pr in by_project:
            by_project[pr]["corrections"] += s.correction_count

    word_counter: Counter = Counter()
    for s in summaries:
        for line in prompt_lines(s):
            for w in _WORD_RE.findall(line.lower()):
                if w not in STOPWORDS:
                    word_counter[w] += 1

    return {
        "window": {"since": str(args.since or "all"), "until": str(args.until or "now")},
        "totals": {
            "sessions": len(summaries),
            "cost": total_cost,
            "cost_is_proxy": not sort_by_cost,
            "cache_write": total_cache_w,
            "tokens": total_tokens,
            "median_tokens_per_session": per_session_tokens[len(per_session_tokens) // 2] if per_session_tokens else 0,
            "models": sorted(models),
            "compactions": compactions,
            "retries": retries_total,
            "corrections": corrections_total,
            "skill_injections": sum(inj_count.values()),
            "skill_injection_chars": sum(inj_chars.values()),
            "representative": len(summaries) >= 10,
        },
        "sort": "cost" if sort_by_cost else "tokens",
        "sessions_top": sessions_rows[: args.top],
        "tool_errors": {
            "by_tool": dict(errors_by_tool.most_common(15)),
            "sessions_affected": {t: len(ids) for t, ids in error_sessions.items()},
            "signatures": {
                t: [{"sig": sig, "count": n} for sig, n in sig.most_common(5)]
                for t, sig in sorted(error_sig.items(),
                                     key=lambda kv: -sum(kv[1].values()))[:8]
            },
        },
        "max_tool_output_chars": dict(
            sorted(max_tool_output.items(), key=lambda kv: -kv[1])[:15]),
        "corrections": [{"line": k, "count": n,
                         "projects": sorted(correction_projects.get(k, set()))[:5]}
                        for k, n in correction_lines.most_common(12)],
        "skill_injections": [
            {"skill": n, "count": inj_count[n], "chars": inj_chars[n]}
            for n in sorted(inj_count, key=lambda k: -inj_chars[k])[:10]
        ],
        "signals": {
            kind: _signal_rows(buckets[kind], samples, 12)
            for kind in ("rule", "fact", "noise")
        },
        "project_tokens": [
            {"token": t, "count": n, "projects": sorted(token_projects.get(t, set()))[:5]}
            for t, n in tokens.most_common(25) if n >= 3
        ],
        "by_project": sorted(by_project.values(),
                             key=lambda p: -(p["errors"] + p["retries"] + p["corrections"]))[:12],
        "prompt_keywords": dict(word_counter.most_common(40)),
    }


def render_markdown(d: dict) -> str:
    out: list[str] = []
    t = d["totals"]
    out.append("# Session Insights — digest")
    out.append("")
    out.append(f"- Период: {d['window']['since']} → {d['window']['until']}")
    skip = t.get("automation_skipped")
    if skip:
        out.append(f"- Автоматических сессий пропущено: {skip}")
    cost_line = (f"стоимость: **{S.fmt_money(t['cost'])}** (cacheWrite {S.fmt_money(t['cache_write'])})"
                 if not t["cost_is_proxy"] else
                 "стоимость: **$0.00** — провайдер не отдаёт цены, сортировка по токенам")
    out.append(f"- Сессий: **{t['sessions']}**, {cost_line}, "
               f"токенов: {t['tokens']:,}, медиана на сессию: {t['median_tokens_per_session']:,}")
    out.append(f"- Ретраев: **{t['retries']}**, поправок пользователя: **{t['corrections']}**, "
               f"компактаций: {t['compactions']}, инжектов тел скиллов: {t['skill_injections']} "
               f"({t['skill_injection_chars']:,} символов)")
    out.append(f"- Модели: {', '.join(t['models']) or '?'}")
    if not t["representative"]:
        out.append("")
        out.append(f"- Выборка маленькая ({t['sessions']} сессий): выводы только как "
                   f"`confounded`, черновики не писать")
    out.append("")

    out.append(f"## Топ сессий (сортировка: {d['sort']})")
    out.append("")
    out.append("| id | дата | проект | msg | calls | err | retr | corr | compact | cost | tokens |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    corr_by_id = {r["id"]: r["corrections"] for r in d["sessions_top"]}
    for r in d["sessions_top"]:
        out.append(f"| {r['id']} | {r['started']} | {r['cwd']} | {r['messages']} "
                   f"| {r['calls']} | {r['errors']} | {r['retries']} | {corr_by_id.get(r['id'], '')} "
                   f"| {r['compactions']} | {S.fmt_money(r['cost'])} | {r['tokens']:,} |")
    out.append("")

    out.append("## По проектам")
    out.append("")
    out.append("| проект | сессий | токены | ошибки | ретраи | поправки |")
    out.append("|---|---|---|---|---|---|")
    for p in d["by_project"]:
        out.append(f"| {p['project']} | {p['sessions']} | {p['tokens']:,} "
                   f"| {p['errors']} | {p['retries']} | {p['corrections']} |")
    out.append("")

    te = d["tool_errors"]
    out.append("## Ошибки инструментов")
    out.append(f"- Всего ретраев (вызов сразу после ошибки того же инструмента): **{t['retries']}**")
    if te["by_tool"]:
        for tool, n in te["by_tool"].items():
            out.append(f"- `{tool}`: {n} ошибок в {te['sessions_affected'].get(tool, 0)} сессиях")
            for row in te["signatures"].get(tool, []):
                out.append(f"    - {row['count']}x: {row['sig'][:120]}")
    else:
        out.append("- Ошибок нет")
    out.append("")

    cr = d["corrections"]
    out.append("## Поправки пользователя (ближайшее к «поведение разошлось»)")
    if cr:
        for row in cr:
            out.append(f"- {row['count']}x: {row['line']} ({', '.join(row['projects'])})")
    else:
        out.append("- Не найдено (маркеры: «нет,», «не надо», «я же просил», don't, stop, again)")
    out.append("")

    out.append("## Максимальный размер tool output (символы)")
    for tool, ln in d["max_tool_output_chars"].items():
        out.append(f"- `{tool}`: {ln:,}")
    out.append("")

    si = d["skill_injections"]
    out.append("## Инжекты тел скиллов (пи разворачивает /скилл в user-сообщение целиком)")
    if si:
        for row in si:
            out.append(f"- `{row['skill']}`: {row['count']}x, {row['chars']:,} символов "
                       f"(≈{row['chars'] // 4:,} токенов в контексте на каждый вызов)")
        out.append("- Тело скилла платится целиком на каждый вызов: если вызовов много, а нужен")
        out.append("  только раздел — разрезать скилл или вынести разделы в отдельные файлы.")
    else:
        out.append("- Нет")
    out.append("")

    sig = d["signals"]
    out.append("## Правила из промптов (кандидаты в AGENTS.md / guard)")
    if sig["rule"]:
        for row in sig["rule"]:
            out.append(f"- {row['count']}x: {row['line']} ({', '.join(row['projects'])})")
    else:
        out.append("- Нет")
    out.append("")

    out.append("## Факты проекта (кандидаты в AGENTS.md репозитория, не в глобальное правило)")
    if sig["fact"]:
        for row in sig["fact"]:
            out.append(f"- {row['count']}x: {row['line']} ({', '.join(row['projects'])})")
    else:
        out.append("- Нет")
    out.append("")

    out.append("## Шум: вставленные логи (НЕ кандидаты в правила)")
    if sig["noise"]:
        for row in sig["noise"][:8]:
            out.append(f"- {row['count']}x: {row['line'][:140]} ({', '.join(row['projects'])})")
        out.append("- Это вывод команд и логи аварий. Как правило в AGENTS.md бесполезно,")
        out.append("  как повтор одной аварии — сигнал, что не хватает инструмента/скилла.")
    else:
        out.append("- Нет")
    out.append("")

    out.append("## Токены проекта (что именно стоит записать фактом)")
    if d["project_tokens"]:
        out.append(", ".join(f"`{r['token']}` ({r['count']})" for r in d["project_tokens"][:25]))
        out.append("- Записывать проверенной формулировкой («в этом репо роль X = Y»),")
        out.append("  с id сессий, где факт наблюдался; угаданный факт хуже отсутствия.")
    else:
        out.append("- Нет")
    out.append("")

    out.append("## Частые слова в промптах (кандидаты в темы)")
    kw = d["prompt_keywords"]
    out.append(", ".join(f"{w} ({n})" for w, n in list(kw.items())[:30]))
    out.append("")
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--since", default="30d", metavar="WHEN",
                   help="7d/2w/ISO-дата (default 30d)")
    p.add_argument("--until", metavar="WHEN")
    p.add_argument("--cwd", action="append", default=[], metavar="SUBSTR",
                   help="Подстрока в cwd, повторяемо")
    p.add_argument("--min-cost", type=float, metavar="USD")
    p.add_argument("--errors-only", action="store_true")
    p.add_argument("--all", action="store_true", dest="all",
                   help="Включать автоматические сессии (OM-извлечения и т.п.)")
    p.add_argument("--top", type=int, default=15, help="Сколько строк сессий в топ (default 15)")
    p.add_argument("--json", action="store_true", help="JSON вместо markdown")
    args = p.parse_args()

    filters = S.Filters.from_args(args)
    all_summaries = S.load_summaries(filters)
    summaries = [s for s in all_summaries if s.is_automation] if args.all else \
        [s for s in all_summaries if not s.is_automation]
    skipped = len(all_summaries) - len(summaries)
    if not summaries:
        print("Нет подходящих сессий.", file=sys.stderr)
        return 1
    digest = build_digest(summaries, args)
    if not args.all:
        digest["totals"]["automation_skipped"] = skipped
    if args.json:
        print(json.dumps(digest, ensure_ascii=False, indent=1))
    else:
        print(render_markdown(digest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
