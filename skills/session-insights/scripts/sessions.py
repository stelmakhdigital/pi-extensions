"""Библиотека для анализа pi session-файлов (JSONL).

Сессии лежат в ~/.pi/agent/sessions/<encoded-cwd>--/<timestamp>_<uuid>.jsonl,
subagent-транскрипты — вложеннее (>=2 уровней под encoded-cwd каталогом).

Типы записей:
  session               — header: id, cwd, timestamp (ISO str)
  model_change          — {modelId, provider}
  thinking_level_change
  message               — {role: user|assistant|toolResult|system|bashExecution,
                           timestamp: int ms, content: [...]}
    assistant: model, provider, usage {input,output,reasoning,totalTokens,
              cacheRead,cacheWrite, cost {input,output,cacheRead,cacheWrite,total}}
    toolResult: toolCallId, toolName, isError
    bashExecution: command, output, exitCode, excludeFromContext
  custom                — служебные события (om и т.п.), data
  compaction            — {summary} — происходило уплотнение контекста
  context_edit

Контракт проверен на реальных сессиях (python 3.14, stdlib only, read-only).
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator, Optional

SESSIONS_ROOT = Path(os.path.expanduser("~/.pi/agent/sessions"))

_REL_RE = re.compile(r"^(\d+)([dwhm])$")


def parse_when(value: str) -> datetime:
    """'7d'/'2w'/'3h'/'30m' (назад от сейчас) или ISO дата/датевремя -> aware UTC."""
    m = _REL_RE.match(value.strip())
    if m:
        n, unit = int(m.group(1)), m.group(2)
        delta = {"d": timedelta(days=n), "w": timedelta(weeks=n),
                 "h": timedelta(hours=n), "m": timedelta(minutes=n)}[unit]
        return datetime.now(timezone.utc) - delta
    v = value.strip().replace(" ", "T")
    if "T" not in v:
        v += "T00:00:00"
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# Первый user-промпт автоматических (не человек) сессий — обычно OM-роли:
# OBSERVER / EXTRACTOR / REFLECTOR / consolidator и т.п.
AUTOMATION_RE = re.compile(
    r"^you are (an|a|the) \w+ (for|of) "
    r"|^you are a consolidator"
    r"|^your job: fold the oldest observations")



def is_subagent_path(path: Path) -> bool:
    try:
        rel = path.relative_to(SESSIONS_ROOT)
    except ValueError:
        return False
    return len(rel.parts) > 2


def iter_session_files(include_subagents: bool = False) -> Iterator[Path]:
    if not SESSIONS_ROOT.exists():
        return
    for p in sorted(SESSIONS_ROOT.rglob("*.jsonl")):
        if not include_subagents and is_subagent_path(p):
            continue
        yield p


def iter_records(path: Path) -> Iterator[dict]:
    try:
        f = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


@dataclass
class SessionSummary:
    path: Path
    id: str = ""
    cwd: str = ""
    started_at: Optional[datetime] = None
    last_at: Optional[datetime] = None
    is_subagent: bool = False

    models: set = field(default_factory=set)
    user_count: int = 0
    assistant_count: int = 0
    tool_call_count: int = 0
    tool_result_count: int = 0
    error_count: int = 0
    bash_exec_count: int = 0
    bash_fail_count: int = 0
    compaction_count: int = 0
    is_automation: bool = False  # первый промпт — известный авто-ран (OM-извлечение и т.п.)

    cost_total: float = 0.0
    cost_cache_read: float = 0.0
    cost_cache_write: float = 0.0
    tok_input: int = 0
    tok_output: int = 0
    tok_cache_read: int = 0
    tok_cache_write: int = 0

    errors_by_tool: dict = field(default_factory=dict)   # tool -> count
    tool_output_max: dict = field(default_factory=dict)  # tool -> max len(content)
    tool_call_total: int = 0
    retries: int = 0  # повтор вызова с теми же аргументами сразу после его ошибки
    _failed_key: Optional[tuple] = None  # (name, args[:100]) упавшего вызова

    user_texts: list = field(default_factory=list)

    @property
    def message_count(self) -> int:
        return self.user_count + self.assistant_count + self.tool_result_count

    @property
    def short_id(self) -> str:
        return self.id[:8] if self.id else ""


def _extract_text(content) -> str:
    if not isinstance(content, list):
        return ""
    return "\n".join(c.get("text") or ""
                     for c in content
                     if isinstance(c, dict) and c.get("type") == "text")


def summarize_session(path: Path) -> Optional[SessionSummary]:
    s = SessionSummary(path=path)
    s.is_subagent = is_subagent_path(path)
    calls: dict = {}  # toolCallId -> (name, args[:100])
    for rec in iter_records(path):
        t = rec.get("type")
        if t == "session":
            s.id = rec.get("id", "")
            s.cwd = rec.get("cwd", "")
            ts = rec.get("timestamp")
            if isinstance(ts, str):
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    s.started_at = dt.astimezone(timezone.utc)
                    s.last_at = s.started_at
                except ValueError:
                    pass
        elif t == "compaction":
            s.compaction_count += 1
        elif t == "message":
            m = rec.get("message") or {}
            role = m.get("role")
            mts = m.get("timestamp")
            if isinstance(mts, (int, float)):
                s.last_at = datetime.fromtimestamp(mts / 1000.0, tz=timezone.utc)
            if role == "user":
                s.user_count += 1
                text = _extract_text(m.get("content"))
                if text:
                    s.user_texts.append(text)
                    if len(s.user_texts) == 1 and AUTOMATION_RE.match(
                            re.sub(r"\s+", " ", s.user_texts[0].lower())):
                        s.is_automation = True
            elif role == "assistant":
                s.assistant_count += 1
                if m.get("model"):
                    s.models.add(m["model"])
                u = m.get("usage") or {}
                cost = u.get("cost") or {}
                s.cost_total += float(cost.get("total") or 0)
                s.cost_cache_read += float(cost.get("cacheRead") or 0)
                s.cost_cache_write += float(cost.get("cacheWrite") or 0)
                s.tok_input += int(u.get("input") or 0)
                s.tok_output += int(u.get("output") or 0)
                s.tok_cache_read += int(u.get("cacheRead") or 0)
                s.tok_cache_write += int(u.get("cacheWrite") or 0)
                for c in m.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        s.tool_call_count += 1
                        s.tool_call_total += 1
                        key = (c.get("name", "?"), str(c.get("arguments") or "")[:100])
                        if c.get("id"):
                            calls[c["id"]] = key
                        if key == s._failed_key:
                            s.retries += 1
                            s._failed_key = None
            elif role == "toolResult":
                s.tool_result_count += 1
                tool = m.get("toolName", "?")
                text = _extract_text(m.get("content"))
                s.tool_output_max[tool] = max(s.tool_output_max.get(tool, 0), len(text))
                if m.get("isError"):
                    s.error_count += 1
                    s.errors_by_tool[tool] = s.errors_by_tool.get(tool, 0) + 1
                    s._failed_key = calls.get(m.get("toolCallId"))
            elif role == "bashExecution":
                s.bash_exec_count += 1
                if (m.get("exitCode") or 0) != 0 or m.get("cancelled"):
                    s.bash_fail_count += 1
    if not s.id:
        return None
    return s


@dataclass
class Filters:
    since: Optional[datetime] = None
    until: Optional[datetime] = None
    cwd_substrs: list = field(default_factory=list)
    min_cost: Optional[float] = None
    errors_only: bool = False
    include_subagents: bool = True
    include_automation: bool = False

    def matches(self, s: SessionSummary) -> bool:
        if self.since and s.started_at and s.started_at < self.since:
            return False
        if self.until and s.started_at and s.started_at > self.until:
            return False
        if self.cwd_substrs:
            cwd = (s.cwd or "").lower()
            if not any(sub.lower() in cwd for sub in self.cwd_substrs):
                return False
        if self.min_cost is not None and s.cost_total < self.min_cost:
            return False
        if self.errors_only and s.error_count == 0:
            return False
        if not self.include_automation and s.is_automation:
            return False
        return True

    @classmethod
    def from_args(cls, args) -> "Filters":
        f = cls()
        f.since = parse_when(args.since) if getattr(args, "since", None) else None
        f.until = parse_when(args.until) if getattr(args, "until", None) else None
        f.cwd_substrs = list(getattr(args, "cwd", []) or [])
        f.min_cost = getattr(args, "min_cost", None)
        f.errors_only = bool(getattr(args, "errors_only", False))
        f.include_automation = bool(getattr(args, "all", False))
        return f


def load_summaries(filters: Filters) -> list:
    out = []
    for path in iter_session_files(include_subagents=filters.include_subagents):
        s = summarize_session(path)
        if s and filters.matches(s):
            out.append(s)
    out.sort(key=lambda x: x.started_at or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    return out


def fmt_money(x: float) -> str:
    return f"${x:.4f}" if 0 < x < 0.01 else (f"${0:.2f}" if x == 0 else f"${x:,.2f}")


def fmt_ts(dt) -> str:
    return "?" if not dt else dt.astimezone().strftime("%Y-%m-%d %H:%M")
