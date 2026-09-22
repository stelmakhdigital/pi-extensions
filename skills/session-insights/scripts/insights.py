#!/usr/bin/env python3
"""Digest pi-сессий для анализа и генерации рекомендаций.

Собирает cross-session метрики: стоимость, ошибки инструментов, ретраи,
объёмы tool output, повторяющиеся строки/темы пользовательских промптов.
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
import sys
from collections import Counter
from pathlib import Path

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


def normalize_line(line: str) -> str:
    return re.sub(r"\s+", " ", line.strip()).lower()


def prompt_lines(s) -> list[str]:
    out = []
    for text in s.user_texts:
        for line in text.splitlines():
            line = line.strip()
            if line and re.search(r"[\wа-яё]", line):
                out.append(line)
    return out


def build_digest(summaries, args) -> dict:
    total_cost = sum(s.cost_total for s in summaries)
    total_cache_w = sum(s.cost_cache_write for s in summaries)
    total_tokens = sum(s.tok_input + s.tok_output for s in summaries)

    errors_by_tool: Counter = Counter()
    error_sessions: dict[str, set] = {}
    retries_total = 0
    max_tool_output: dict[str, int] = {}
    compactions = 0
    models: set = set()
    for s in summaries:
        errors_by_tool.update(s.errors_by_tool)
        for t in s.errors_by_tool:
            error_sessions.setdefault(t, set()).add(s.short_id)
        retries_total += s.retries
        compactions += s.compaction_count
        models |= s.models
        for t, ln in s.tool_output_max.items():
            max_tool_output[t] = max(max_tool_output.get(t, 0), ln)

    # повторяющиеся строки пользовательских промптов
    line_counter: Counter = Counter()
    long_lines: Counter = Counter()
    for s in summaries:
        for line in prompt_lines(s):
            norm = normalize_line(line)
            if len(norm) >= 30:
                line_counter[norm] += 1
            if len(norm) >= 200:
                long_lines[norm] += 1

    # темы: частота слов промптов
    word_counter: Counter = Counter()
    for s in summaries:
        for line in prompt_lines(s):
            for w in _WORD_RE.findall(line.lower()):
                if w not in STOPWORDS:
                    word_counter[w] += 1

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
            "compactions": s.compaction_count,
            "cost": s.cost_total,
            "cacheW": s.cost_cache_write,
        })
    sessions_rows.sort(key=lambda r: r["cost"], reverse=True)

    return {
        "window": {"since": str(args.since or "all"), "until": str(args.until or "now")},
        "totals": {
            "sessions": len(summaries),
            "cost": total_cost,
            "cache_write": total_cache_w,
            "tokens": total_tokens,
            "models": sorted(models),
            "compactions": compactions,
        },
        "sessions_top": sessions_rows[: args.top],
        "tool_errors": {
            "by_tool": dict(errors_by_tool.most_common(15)),
            "sessions_affected": {t: len(ids) for t, ids in error_sessions.items()},
            "retries": retries_total,
        },
        "max_tool_output_chars": dict(
            sorted(max_tool_output.items(), key=lambda kv: -kv[1])[:15]),
        "repeated_prompt_lines": [
            {"line": ln[:200], "count": n}
            for ln, n in line_counter.most_common(30) if n >= 2
        ][:25],
        "repeated_long_context": [
            {"line": ln[:200], "count": n}
            for ln, n in long_lines.most_common(15) if n >= 2
        ][:10],
        "prompt_keywords": dict(word_counter.most_common(40)),
    }


def render_markdown(d: dict) -> str:
    out = []
    t = d["totals"]
    out.append("# Session Insights — digest")
    out.append("")
    out.append(f"- Период: {d['window']['since']} → {d['window']['until']}")
    out.append(f"- Сессий: **{t['sessions']}**" + (f" (+{d['totals'].get('automation_skipped', 0)} автоматических пропущено)" if d['totals'].get('automation_skipped') else "") + f", стоимость: **{S.fmt_money(t['cost'])}** "
               f"(cacheWrite {S.fmt_money(t['cache_write'])}), "
               f"токенов: {t['tokens']:,}, компактаций: {t['compactions']}")
    out.append(f"- Модели: {', '.join(t['models']) or '?'}")
    out.append("")

    out.append("## Топ сессий по стоимости")
    out.append("")
    out.append("| id | дата | проект | msg | calls | err | retr | compact | cost | cacheW |")
    out.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in d["sessions_top"]:
        out.append(f"| {r['id']} | {r['started']} | {r['cwd']} | {r['messages']} "
                   f"| {r['calls']} | {r['errors']} | {r['retries']} | {r['compactions']} "
                   f"| {S.fmt_money(r['cost'])} | {S.fmt_money(r['cacheW'])} |")
    out.append("")

    te = d["tool_errors"]
    out.append("## Ошибки инструментов")
    out.append(f"- Всего ретраев (вызов сразу после ошибки того же инструмента): **{te['retries']}**")
    if te["by_tool"]:
        for tool, n in te["by_tool"].items():
            out.append(f"- `{tool}`: {n} ошибок в {te['sessions_affected'].get(tool, 0)} сессиях")
    else:
        out.append("- Ошибок нет")
    out.append("")

    out.append("## Максимальный размер tool output (символы)")
    for tool, ln in d["max_tool_output_chars"].items():
        out.append(f"- `{tool}`: {ln:,}")
    out.append("")

    out.append("## Повторяющиеся строки в пользовательских промптах")
    if d["repeated_prompt_lines"]:
        for r in d["repeated_prompt_lines"]:
            out.append(f"- {r['count']}x: {r['line']}")
    else:
        out.append("- Нет повторяющихся строк")
    out.append("")

    out.append("## Повторная инъекция длинного контекста (>=200 символов)")
    if d["repeated_long_context"]:
        for r in d["repeated_long_context"]:
            out.append(f"- {r['count']}x: {r['line']}")
    else:
        out.append("- Не обнаружена")
    out.append("")

    out.append("## Частые слова в промптах (кандидаты в темы)")
    kw = d["prompt_keywords"]
    out.append(", ".join(f"{w} ({n})" for w, n in list(kw.items())[:30]))
    out.append("")
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--since", metavar="WHEN", help="7d/2w/ISO-дата (нижняя граница)")
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
