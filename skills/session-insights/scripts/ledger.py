#!/usr/bin/env python3
"""Журнал вмешательств в harness: что заметили, что поменяли, помогло ли.

Один файл (по умолчанию ~/.pi/agent/session-insights/ledger.md, перекатывается
SESSION_INSIGHTS_LEDGER). Запись заводится ДО правки, verdict выставляется
после замера. Формат — markdown, чтобы читался глазами и правил руками.

Запись:

    ### <id> (<дата>)
    cue:        форма ситуации, по которой срабатывает (не факты одной задачи)
    component:  agents-md | skill | snippet | script | tool | guard | subagent
    lesson:     что именно сделано с harness
    evidence:   сессии/числа из digest, на которые это опирается
    confidence: high | medium | low (+ почему)
    check:      pattern="<regex>" scope=<подстрока cwd> window=14d
    verdict:    adopted <дата> | helped | hurt | no observed effect | confounded

Правила (из практики контрастных прогонов, см. SKILL.md):
- evidence обязателен: без ссылки на сессии/числа запись не заводится;
- verdict `confounded` предпочитать, когда за то же окно принято несколько
  записей или наблюдений меньше 5 на сторону;
- «нет записи» — легальный исход, выдуманная атрибуция отравляет журнал.

Команды:
  ledger.py list
  ledger.py add --id ... --cue ... --component ... --lesson ... --evidence ... \
                [--confidence ...] [--check ...] [--scope ...] [--window 14d]
  ledger.py adopt --id ...            # фиксирует дату принятия
  ledger.py verdict --id ... --verdict helped [--note ...]
  ledger.py check [--id ...] [--json] # частота паттерна до/после даты принятия
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sessions as S

LEDGER = Path(os.environ.get("SESSION_INSIGHTS_LEDGER")
              or (S.AGENT_DIR / "session-insights" / "ledger.md"))

HEADER = """# Журнал вмешательств в harness

Запись заводится ДО правки (cue/lesson/evidence/confidence), `verdict` — после
замера `ledger.py check`. См. skills/session-insights/SKILL.md.
"""

FIELD_RE = re.compile(r"^(cue|component|lesson|evidence|confidence|check|verdict|note):\s*(.*)$", re.M)


def parse(text: str) -> list[dict]:
    entries = []
    for chunk in re.split(r"(?m)^### ", text)[1:]:
        head, _, body = chunk.partition("\n")
        m = re.match(r"^(\S+)(?:\s*\(([^)]*)\))?", head.strip())
        if not m:
            continue
        e = {"id": m.group(1), "date": m.group(2) or ""}
        for k, v in FIELD_RE.findall(body):
            e[k] = v.strip()
        entries.append(e)
    return entries


def load(path: Path = LEDGER) -> list[dict]:
    if not path.is_file():
        return []
    return parse(path.read_text(encoding="utf-8", errors="replace"))


def render_entry(e: dict) -> str:
    lines = [f"### {e['id']} ({e.get('date') or datetime.now(timezone.utc).strftime('%Y-%m-%d')})"]
    for key in ("cue", "component", "lesson", "evidence", "confidence", "check", "verdict", "note"):
        if e.get(key):
            lines.append(f"{key}: {e[key]}")
    return "\n".join(lines) + "\n"


def append(entry: dict, path: Path = LEDGER) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.is_file()
    with path.open("a", encoding="utf-8") as f:
        if new:
            f.write(HEADER + "\n")
        f.write("\n" + render_entry(entry))


def rewrite(entries: list[dict], path: Path = LEDGER) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(HEADER + "\n" + "\n".join(render_entry(e) for e in entries),
                    encoding="utf-8")


def _day(e: dict) -> datetime | None:
    for key in ("verdict", "date"):
        m = re.search(r"(\d{4}-\d{2}-\d{2})", e.get(key) or "")
        if m:
            return datetime.strptime(m.group(1), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return None


def _pattern_of(e: dict) -> tuple[str | None, str, int]:
    """(regex, scope, window_days) из поля check."""
    check = e.get("check") or ""
    m = re.search(r'pattern="([^"]+)"', check)
    scope = re.search(r"scope=(\S+)", check)
    win = re.search(r"window=(\d+)d", check)
    return (m.group(1) if m else None,
            scope.group(1) if scope else "",
            int(win.group(1)) if win else 14)


def measure_change(e: dict, summaries) -> dict:
    """Частота паттерна в сессиях до и после даты принятия (грубый A/B)."""
    pattern, scope, win_days = _pattern_of(e)
    day = _day(e)
    out = {"id": e["id"], "pattern": pattern, "scope": scope, "window_days": win_days,
           "since": day.strftime("%Y-%m-%d") if day else None}
    if not pattern or not day:
        out["verdict_suggested"] = "confounded"
        out["why"] = "нет поля check=\"pattern=...\" или даты принятия — мерить нечем"
        return out
    rx = re.compile(pattern, re.IGNORECASE)
    span = timedelta(days=win_days)

    def hits(path: Path) -> int:
        try:
            return len(rx.findall(path.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            return 0

    before = after = 0
    before_hits = after_hits = 0
    for s in summaries:
        cwd = (s.cwd or "").lower()
        if scope and scope.lower() not in cwd:
            continue
        if not s.started_at:
            continue
        n = hits(s.path)
        if day - span <= s.started_at < day:
            before += 1
            before_hits += n
        elif s.started_at >= day:
            after += 1
            after_hits += n
    out.update({"before_sessions": before, "before_hits": before_hits,
                "after_sessions": after, "after_hits": after_hits})
    if before < 5 or after < 5:
        out["verdict_suggested"] = "confounded"
        out["why"] = f"на одной стороне {min(before, after)} сессий (<5) — сравнение незначимо"
        return out
    rb = before_hits / before
    ra = after_hits / after
    out.update({"before_per_session": round(rb, 3), "after_per_session": round(ra, 3)})
    if rb == 0:
        out["verdict_suggested"] = "no observed effect" if ra == 0 else "hurt"
        out["why"] = "до принятия паттерн не встречался"
    elif ra <= rb * 0.7:
        out["verdict_suggested"] = "helped"
    elif ra >= rb * 1.3:
        out["verdict_suggested"] = "hurt"
    else:
        out["verdict_suggested"] = "no observed effect"
    same_window = [x["id"] for x in load()
                   if x["id"] != e["id"] and x["id"]
                   and _day(x) and abs((_day(x) - day).days) <= win_days]
    if same_window:
        out["verdict_suggested"] = "confounded"
        out["why"] = (f"за то же окно принято ещё: {', '.join(same_window)} — "
                      f"эффект не изолирован")
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("list", help="показать записи")
    sp.add_argument("--json", action="store_true")

    sp = sub.add_parser("add", help="завести запись (верификация обязательна)")
    for name in ("id", "cue", "component", "lesson", "evidence"):
        sp.add_argument(f"--{name.replace('-', '_')}", required=True)
    sp.add_argument("--confidence", default="low")
    sp.add_argument("--check", help="regex частоты, по которой потом мерим эффект")
    sp.add_argument("--scope", default="", help="подстрока cwd для замера")
    sp.add_argument("--window", type=int, default=14, help="окно замера, дней")

    sp = sub.add_parser("adopt", help="зафиксировать дату принятия")
    sp.add_argument("--id", required=True)

    sp = sub.add_parser("verdict", help="выставить verdict вручную")
    sp.add_argument("--id", required=True)
    sp.add_argument("--verdict", required=True,
                    choices=["helped", "hurt", "no observed effect", "confounded", "reverted"])
    sp.add_argument("--note")

    sp = sub.add_parser("check", help="частота паттерна до/после даты принятия")
    sp.add_argument("--id")
    sp.add_argument("--since", default="120d", help="окно сессий для сравнения (default 120d)")
    sp.add_argument("--apply", action="store_true",
                    help="записать suggested verdict в журнал")
    sp.add_argument("--json", action="store_true")

    args = p.parse_args()
    entries = load()

    if args.cmd == "list":
        if args.json:
            print(json.dumps(entries, ensure_ascii=False, indent=1))
        elif not entries:
            print(f"Журнал пуст ({LEDGER}).")
        else:
            for e in entries:
                print(render_entry(e))
        return 0

    if args.cmd == "add":
        if len(args.evidence.strip()) < 8 or not re.search(r"\d", args.evidence):
            print("evidence обязан ссылаться на числа/сессии из digest "
                  "(пример: '9 сессий 01a1f85f,43eebe34 — 74 ошибки edit').",
                  file=sys.stderr)
            return 2
        if not args.check:
            print("Без --check запись не проверяема: добавь pattern=\"<regex>\" "
                  "по которому мерим эффект (или оставь запись как note-наблюдение "
                  "в отчёте).", file=sys.stderr)
            return 2
        if any(e["id"] == args.id for e in entries):
            print(f"id {args.id} уже есть в журнале.", file=sys.stderr)
            return 2
        append({
            "id": args.id,
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "cue": args.cue,
            "component": args.component,
            "lesson": args.lesson,
            "evidence": args.evidence,
            "confidence": args.confidence,
            "check": (f'pattern="{args.check}"'
                      + (f" scope={args.scope}" if args.scope else "")
                      + f" window={args.window}d"),
            "verdict": "proposed",
        })
        print(f"записано: {args.id} -> {LEDGER}")
        return 0

    if args.cmd == "adopt":
        hit = [e for e in entries if e["id"] == args.id]
        if not hit:
            print(f"id {args.id} не найден.", file=sys.stderr)
            return 2
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        hit[0]["verdict"] = f"adopted {today}"
        rewrite(entries)
        print(f"{args.id}: adopted {today}")
        return 0

    if args.cmd == "verdict":
        hit = [e for e in entries if e["id"] == args.id]
        if not hit:
            print(f"id {args.id} не найден.", file=sys.stderr)
            return 2
        hit[0]["verdict"] = args.verdict
        if args.note:
            hit[0]["note"] = args.note
        rewrite(entries)
        print(f"{args.id}: {args.verdict}")
        return 0

    # check
    wanted = [e for e in entries if e.get("check") and (_day(e) or e.get("verdict", "").startswith("adopted"))]
    if args.id:
        wanted = [e for e in entries if e["id"] == args.id]
        if not wanted:
            print(f"id {args.id} не найден.", file=sys.stderr)
            return 2
    if not wanted:
        print("Нет записей с датой принятия и check-паттерном — мерить нечего.",
              file=sys.stderr)
        return 1

    filters = S.Filters()
    filters.since = S.parse_when(args.since)
    summaries = S.load_summaries(filters)
    results = [measure_change(e, summaries) for e in wanted]

    if args.apply:
        for e, r in zip(wanted, results):
            if r.get("verdict_suggested") and e.get("verdict", "").startswith("adopted"):
                e["verdict"] = r["verdict_suggested"]
                e["note"] = (f"check {datetime.now(timezone.utc).strftime('%Y-%m-%d')}: "
                             + json.dumps({k: v for k, v in r.items() if k != "id"},
                                          ensure_ascii=False))
        rewrite(entries)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    else:
        for r in results:
            print(f"{r['id']}: {r.get('verdict_suggested', '?')}"
                  + (f" — {r['why']}" if r.get("why") else ""))
            if "before_sessions" in r:
                bps = r.get("before_per_session", "?")
                aps = r.get("after_per_session", "?")
                print(f"    до: {r['before_hits']} заходов в {r['before_sessions']} сессиях "
                      f"({bps}/сессию), "
                      f"после: {r['after_hits']} в {r['after_sessions']} "
                      f"({aps}/сессию)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
