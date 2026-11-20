#!/usr/bin/env python3
"""Вес always-on части harness (то, что лежит в контексте каждый ход).

Считает по файлам на диске (read-only):
  - глобальный AGENTS.md и AGENTS.md проектов из сессий;
  - name + description каждого SKILL.md (именно они инжектятся в список скиллов,
    тело скилла comes по запросу и сюда не входит);
  - размер тел скиллов — отдельно, как «потенциальная» стоимость вызова.

Зачем: правило в AGENTS.md и description скилла оплачиваются на КАЖДОМ ходе и
конкурируют с бюджетом ответа модели. Любая рекомендация «добавь текст» должна
называться в этих же единицах, а текст в обмен — вычтен.

  python3 surface.py            # markdown
  python3 surface.py --json
  python3 surface.py --add 180  # что даст правило в 180 символов за 30 дней
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import sessions as S

# грубая конверсия символов в токены для смешанного ru/en текста
CHARS_PER_TOKEN = 3.2

SKILL_GLOBS = [
    "skills/**/SKILL.md",              # ~/.pi/agent/skills
    "git/**/skills/**/SKILL.md",       # скиллы из git-пакетов
]
EXTRA_SKILL_ROOTS = [Path("~/.agents").expanduser()]


def _frontmatter(text: str) -> dict:
    """Поля name/description из YAML-шапки (без yaml: нужны две строки)."""
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    out = {}
    for key in ("name", "description"):
        km = re.search(rf"^{key}:\s*(.+)$", m.group(1), re.M)
        if km:
            out[key] = km.group(1).strip().strip("\"'")
    return out


def skill_entries() -> list[dict]:
    seen: dict[str, dict] = {}
    roots = [S.AGENT_DIR] + [r for r in EXTRA_SKILL_ROOTS if r.exists()]
    for root in roots:
        for glob in (SKILL_GLOBS if root == S.AGENT_DIR else ["skills/**/SKILL.md"]):
            for p in root.glob(glob):
                try:
                    body = p.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                fm = _frontmatter(body)
                name = fm.get("name") or p.parent.name
                desc = fm.get("description") or ""
                # в списке скиллов pi держит name + description + путь
                always = len(name) + len(desc) + len(str(p)) + 8
                if not desc:
                    always += 40  # описание-заглушка всё равно стоит строк
                seen[str(p)] = {
                    "name": name,
                    "path": str(p),
                    "description_chars": len(desc),
                    "always_on_chars": always,
                    "body_chars": len(body),
                }
    return sorted(seen.values(), key=lambda e: -e["always_on_chars"])


def agents_md_files(project_cwds: list[str] | None = None) -> list[dict]:
    out = []
    cands = [S.AGENT_DIR / "AGENTS.md", S.AGENT_DIR.parent / "AGENTS.md"]
    for cwd in (project_cwds or []):
        cands.append(Path(cwd) / "AGENTS.md")
    seen = set()
    for p in cands:
        if not p.is_file() or str(p) in seen:
            continue
        seen.add(str(p))
        text = p.read_text(encoding="utf-8", errors="replace")
        out.append({"path": str(p), "chars": len(text), "lines": text.count("\n") + 1})
    return sorted(out, key=lambda e: -e["chars"])


def measure(project_cwds: list[str] | None = None) -> dict:
    skills = skill_entries()
    amds = agents_md_files(project_cwds)
    skills_always = sum(s["always_on_chars"] for s in skills)
    amds_chars = sum(a["chars"] for a in amds)
    total = skills_always + amds_chars
    return {
        "agents_md": amds,
        "skills": skills,
        "totals": {
            "agents_md_chars": amds_chars,
            "skills_count": len(skills),
            "skills_always_on_chars": skills_always,
            "skills_body_chars": sum(s["body_chars"] for s in skills),
            "always_on_chars": total,
            "always_on_tokens_est": int(total / CHARS_PER_TOKEN),
        },
    }


def render(m: dict, add_chars: int | None, window_sessions: int | None) -> str:
    t = m["totals"]
    out = ["## Вес always-on", ""]
    out.append(f"- AGENTS.md: {t['agents_md_chars']:,} символов ({len(m['agents_md'])} файл(ов))")
    out.append(f"- скиллов: {t['skills_count']}, их name+description в контексте всегда: "
               f"{t['skills_always_on_chars']:,} символов")
    out.append(f"- ИТОГО always-on по файлам на диске: ~{t['always_on_chars']:,} символов "
               f"(≈{t['always_on_tokens_est']:,} токенов на каждый ход; схемы тулз и системный промпт pi сюда не входят)")
    out.append("")
    out.append("| скилл | description, символов | всегда в контексте |")
    out.append("|---|---|---|")
    for s in m["skills"][:15]:
        out.append(f"| {s['name']} | {s['description_chars']} | {s['always_on_chars']} |")
    out.append("")
    for a in m["agents_md"][:5]:
        out.append(f"- `{a['path']}`: {a['chars']:,} символов, {a['lines']} строк")
    if add_chars:
        per = int(add_chars / CHARS_PER_TOKEN)
        line = (f"\n- Правило в {add_chars} символов = ≈{per} токенов на каждый ход "
                f"каждой сессии (не только той, где оно нужно).")
        if window_sessions:
            line += (f" За окно это ≈{per * window_sessions} токенов «на ровном месте» — "
                     f"правило обязано окупить их иначе не пишем, а в обмен что-то вычёркиваем.")
        out.append(line)
    return "\n".join(out)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--json", action="store_true")
    p.add_argument("--add", type=int, metavar="CHARS",
                   help="оценить marginal cost правила из CHARS символов")
    p.add_argument("--since", default="30d", help="окно для оценки частоты (default 30d)")
    p.add_argument("--projects", action="store_true",
                   help="добавить AGENTS.md проектов, встреченных в сессиях")
    args = p.parse_args()

    cwds = None
    window_sessions = None
    if args.projects or args.add:
        try:
            summaries = S.load_summaries(S.Filters.from_args(type("A", (), {
                "since": args.since, "until": None, "cwd": [], "min_cost": None,
                "errors_only": False, "all": False})()))
        except Exception:
            summaries = []
        cwds = sorted({s.cwd for s in summaries if s.cwd})
        window_sessions = len(summaries)

    m = measure(cwds)
    if args.json:
        m["add_estimate"] = (None if not args.add else {
            "chars": args.add,
            "tokens_per_turn": int(args.add / CHARS_PER_TOKEN),
            "sessions_in_window": window_sessions,
        })
        print(json.dumps(m, ensure_ascii=False, indent=1))
    else:
        print(render(m, args.add, window_sessions))
    return 0


if __name__ == "__main__":
    sys.exit(main())
