import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadGuard, saveGuard, shouldResetGuards } from "../guard-state.ts";

/**
 * text-guard: контроль текста, который пишет модель (документация, комментарии,
 * коммиты, чат) — без эмодзи, стрелок, чек-маркеров, слов-маркеров ИИ-стиля и
 * «умных названий». Цель — понятный краткий человеческий текст.
 *
 * Три уровня:
 * - Профилактика: before_agent_start добавляет в системный промпт секцию
 *   <writing-style> (краткие правила стиля) — снимает большую часть проблем
 *   до того, как текст написан.
 * - Контроль записи: tool_call для write/edit/bash. Текст, уходящий в файлы
 *   (write.content, edit.newText, heredoc/echo в bash, git commit -m),
 *   сканируется; в strict-режиме вызов блокируется с конкретной причиной
 *   (модель переписывает сама); механически исправимое (эмодзи/стрелки) при
 *   включённом автофиксе правится мутацией event.input in place.
 * - Мониторинг чата: message_end считает маркеры в ответах модели (блокировать
 *   текст чата нельзя), счётчик — в бейдже и /text-guard:stats.
 *
 * Режимы: off / warn (по умолчанию) / strict. Персистентны через guard-state.
 * RU+EN списки слов с самого старта; настройка — .text-guard.json в CWD.
 *
 * Сознательные компромиссы (см. README):
 * - В коде сканируем только комментарии (эвристика по началу строки: //, /*, #),
 *   содержимое строк внутри кода не трогаем — строки vs комментарии надёжно
 *   не различить простыми средствами, поэтому allow/skip-глобы путей.
 * - Переписывание текста через LLM не делаем: блок с конкретной причиной
 *   дешевле и детерминированнее.
 */

// Ключ с пробелом в начале: футер сортирует статусы по алфавиту, бейдж не
// обрезается (см. аналогичный комментарий в bash-guard/dir-guard).
const STATUS_KEY = " z-text-guard"; // "z-": бейдж после иконок graft/ponytail

type Mode = "off" | "warn" | "strict";
const DEFAULT_MODE: Mode = "warn";

const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

/**
 * Символы-маркеры: стрелки (2190–21FF), декоративные символы и чек-маркеры
 * (2600–27BF: ✓ ✔ ✅ ➜ ⚠), стрелки/звёзды (2B00–2BFF: ⭐ ⬆), эмодзи
 * (1F000–1FAFF), variation selector FE0F. Всё это — механически исправимое.
 */
const SYMBOLS_SRC = "\\u2190-\\u21FF\\u2600-\\u27BF\\u2B00-\\u2BFF\\u{1F000}-\\u{1FAFF}\\u{FE0F}";
const SYMBOLS_RE = new RegExp(`[${SYMBOLS_SRC}]`, "gu");
/** Для автофикса: символ вместе со следующим пробелом («🎉 Release» → «Release»). */
const AUTOFIX_RE = new RegExp(`[${SYMBOLS_SRC}][ \\t]?`, "gu");

/** Слова-маркеры, RU. */
const WORDS_RU = [
	"давайте",
	"давай",
	"итак",
	"простыми словами",
	"на самом деле",
	"стоит отметить",
	"важно понимать",
	"подводя итог",
	"в целом",
	"кстати",
	"надеюсь",
	"с удовольствием",
	"конечно!",
];

/** Слова-маркеры, EN. */
const WORDS_EN = [
	"delve",
	"moreover",
	"furthermore",
	"leverage",
	"seamless",
	"robust",
	"comprehensive",
	"cutting-edge",
	"elevate",
	"journey",
	"realm",
	"showcase",
	"let's",
	"sure!",
	"great!",
	"in conclusion",
	"tl;dr",
];

/**
 * «Умные названия»: сканируются только заголовки документов и коммиты —
 * в обычном тексте/комментариях эти слова часто легитимны (magic number и т.п.).
 */
const NAMING = ["wizard", "magic", "awesome", "ultimate", "ninja", "rockstar", "магия", "волшебный"];

/** Структурный маркер: жирная «метка» в буллете (`**Note:** …`). */
const STRUCTURE_RE = /^\s*[-*+]\s+\*\*[^*\n]{1,60}:\*\*/gm;

/** Категории проверки (id для конфига и статистики). */
const ALL_CATEGORIES = ["symbols", "words-ru", "words-en", "naming", "structure"] as const;
type Category = (typeof ALL_CATEGORIES)[number];

type Scope = "markdown" | "commit" | "code" | "plain" | "chat";

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"]);
const CODE_EXTS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
	".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".php", ".sh", ".bash", ".zsh", ".lua", ".sql",
	".html", ".vue", ".svelte", ".css", ".scss", ".less", ".toml", ".yaml", ".yml", ".ini", ".cfg",
	".conf", ".pl", ".ex", ".exs", ".erl", ".hrl", ".scala", ".clj", ".dart",
]);

/** Глобы путей, которые не сканируем никогда (данные, артефакты, бинарное). */
const DEFAULT_SKIP = [
	"**/*.json", "**/*.jsonc", "**/*.lock", "**/*.svg", "**/*.snap", "**/*.min.*",
	"**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lockb", "**/*.ico", "**/*.png", "**/*.jpg", "**/*.gif",
];

/** Правила стиля в системный промпт (профилактика важнее блокировок). */
const STYLE_SECTION = [
	"Write plain, human text everywhere: docs, comments, commit messages, answers.",
	"- No emoji, arrows (→, ⇒), checkmarks (✓, ✔) or any decorative unicode.",
	'- No filler openers: «давайте», «итак», «стоит отметить», "let\'s", "sure!", "great!", "in conclusion".',
	"- No AI-flavored vocabulary: delve, leverage, seamless, robust, comprehensive, and similar.",
	"- No clever names (wizard, magic, awesome, ultimate, ninja) in titles and commits.",
	"- Short declarative sentences. Concrete over generic. No bold label in every bullet.",
].join("\n");

// ---------------------------------------------------------------------------
// Компиляция словарей
// ---------------------------------------------------------------------------

/**
 * Строка словаря → regex с границами слова (\p{L} — работает и для кириллицы).
 * Апострофы учитывают типографику (let's / let’s), пробелы — любую длину.
 */
function wordRegex(entry: string): RegExp {
	const body = entry
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/'/g, "['’]")
		.replace(/\s+/g, "\\s+");
	return new RegExp(`(?<!\\p{L})${body}(?!\\p{L})`, "giu");
}

const RU_RES = WORDS_RU.map(wordRegex);
const EN_RES = WORDS_EN.map(wordRegex);
const NAMING_RES = NAMING.map(wordRegex);

function lineOf(text: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Конфиг (.text-guard.json в CWD)
// ---------------------------------------------------------------------------

type Config = {
	allow: RegExp[]; // пути, которые не сканируем (поверх skip-глобов)
	skip: RegExp[]; // пути, которые не сканируем (дефолт + пользовательские)
	words: Array<{ word: string; re: RegExp }>; // пользовательские слова-маркеры
	ignore: Set<string>; // слова/токены, исключённые из проверки
	categories: Set<string>; // включённые категории
};

function globToRegExp(glob: string): RegExp {
	const body = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "::")
		.replace(/\*/g, "[^/]*")
		.replace(/::/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`(?:^|/)${body}$`, "i");
}

function readConfig(cwd: string, ctx?: ExtensionContext): Config {
	const cfg: Config = {
		allow: [],
		skip: DEFAULT_SKIP.map(globToRegExp),
		words: [],
		ignore: new Set(),
		categories: new Set<string>(ALL_CATEGORIES),
	};
	const file = path.join(cwd, ".text-guard.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		if (fs.existsSync(file) && ctx?.hasUI) {
			ctx.ui.notify(`text-guard: невалидный JSON в ${file} — файл проигнорирован`, "warning");
		}
		return cfg;
	}
	const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
	const asStrings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	for (const g of asStrings(o.allow)) cfg.allow.push(globToRegExp(g));
	for (const g of asStrings(o.skip)) cfg.skip.push(globToRegExp(g));
	for (const w of asStrings(o.words)) cfg.words.push({ word: w, re: wordRegex(w) });
	for (const w of asStrings(o.ignore)) cfg.ignore.add(w.toLowerCase());
	const cats = asStrings(o.categories);
	if (cats.length) cfg.categories = new Set(cats.filter((c) => (ALL_CATEGORIES as readonly string[]).includes(c)));
	return cfg;
}

function isSkipped(p: string, cfg: Config): boolean {
	const norm = p.replace(/\\/g, "/");
	if (/(^|\/)(node_modules|\.git|\.next|dist|build|coverage)(\/|$)/.test(norm)) return true;
	return cfg.skip.some((re) => re.test(norm)) || cfg.allow.some((re) => re.test(norm));
}

function scopeForPath(p: string): Scope {
	const ext = path.extname(p).toLowerCase();
	if (DOC_EXTS.has(ext)) return "markdown";
	if (CODE_EXTS.has(ext)) return "code";
	return "plain";
}

// ---------------------------------------------------------------------------
// Извлечение текста
// ---------------------------------------------------------------------------

/**
 * Код → текст «только комментарии»: длина и число строк сохраняются (важно для
 * номеров строк в причинах), всё вне комментариев скрывается. Эвристика по
 * началу строки (//, /*, #) — содержимое строк не анализируется, поэтому URL
 * в коде («https://…») не даёт ложных «комментариев».
 */
function codeToCommentsOnly(text: string): string {
	const out: string[] = [];
	let inBlock = false;
	for (const line of text.split(/\r?\n/)) {
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) {
				out.push(line);
				continue;
			}
			out.push(line.slice(0, end + 2));
			inBlock = false;
			continue;
		}
		const trimmed = line.trimStart();
		const offset = line.length - trimmed.length;
		if (trimmed.startsWith("/*")) {
			const body = trimmed.slice(2);
			const end = body.indexOf("*/");
			if (end === -1) {
				inBlock = true;
				out.push(line.slice(0, offset) + body);
			} else {
				out.push(line.slice(0, offset) + body.slice(0, end + 2));
			}
			continue;
		}
		if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
			out.push(line);
			continue;
		}
		out.push("");
	}
	return out.join("\n");
}

type Fragment = { text: string; scope: Scope; what: string };

/**
 * Извлекает «текстовые» фрагменты bash-команды:
 * - сообщения `git commit -m` (и `gh pr/issue create --title/--body`);
 * - содержимое heredoc (cat/tee/… > file <<EOF);
 * - `echo/printf … > file`.
 * Целевой файл определяет scope (по расширению); без цели — plain.
 */
function extractBashFragments(command: string): Fragment[] {
	const out: Fragment[] = [];
	const lines = command.split(/\r?\n/);

	const pushQuoted = (raw: string, scope: Scope, what: string) => {
		const t = raw.replace(/^['"]|['"]$/g, "").replace(/\\(["'])/g, "$1");
		if (t.trim()) out.push({ text: t, scope, what });
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// git commit -m "…" / gh pr create --title "…"
		if (/\b(?:git\s+commit|gh\s+(?:pr|issue)\s+create)\b/.test(line)) {
			for (const m of line.matchAll(/(?:-m|--message|--message=|--title=|--body=)\s*("((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s]+))/g)) {
				const raw = m[2] ?? m[3] ?? m[4] ?? "";
				pushQuoted(raw, "commit", "коммит");
			}
		}

		// heredoc: цель после > / >> (или tee file) определяет scope
		const hd = line.match(/<<-?\s*(['"]?)(\w+)\1/);
		if (hd) {
			const tag = hd[2];
			const target =
				line.match(/>?\s*([^\s"'<>|]+)\s*<</)?.[1] ??
				line.match(/\btee\b[^\s]*\s+([^\s"'<>|]+)\s*<</)?.[1];
			const scope = target ? scopeForPath(target) : "plain";
			const body: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim() === tag) {
					i = j;
					break;
				}
				body.push(lines[j]);
			}
			if (body.length) {
				out.push({ text: body.join("\n"), scope, what: target ? `heredoc → ${target}` : "heredoc" });
			}
			continue;
		}

		// echo/printf … > file
		if (/\b(?:echo|printf)\b/.test(line) && />{1,2}/.test(line)) {
			const m = line.match(/\b(?:echo|printf)\s+(.+?)\s*>{1,2}\s*([^\s"'<>|]+)\s*$/);
			if (m) pushQuoted(m[1], scopeForPath(m[2]), `echo → ${m[2]}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Скан
// ---------------------------------------------------------------------------

type Hit = { category: string; token: string; line: number };

function scanWords(text: string, res: RegExp[], words: string[], category: string, hits: Hit[], ignore: Set<string>): void {
	for (let i = 0; i < res.length; i++) {
		for (const m of text.matchAll(res[i])) {
			const token = words[i].toLowerCase();
			if (ignore.has(token)) continue;
			hits.push({ category, token, line: lineOf(text, m.index ?? 0) });
		}
	}
}

function scanScope(text: string, scope: Scope, cfg: Config): Hit[] {
	const hits: Hit[] = [];
	const on = (c: Category) => cfg.categories.has(c);
	const hasIgnore = (tok: string) => cfg.ignore.has(tok.toLowerCase());

	// В коде сканируем только комментарии (эвристика по началу строки):
	// длина и число строк сохраняются — номера строк в причинах остаются верными.
	if (scope === "code") text = codeToCommentsOnly(text);

	if (on("symbols")) {
		for (const m of text.matchAll(SYMBOLS_RE)) {
			if (hasIgnore(m[0])) continue;
			hits.push({ category: "symbols", token: m[0], line: lineOf(text, m.index ?? 0) });
		}
	}
	if (on("words-ru")) scanWords(text, RU_RES, WORDS_RU, "words-ru", hits, cfg.ignore);
	if (on("words-en")) scanWords(text, EN_RES, WORDS_EN, "words-en", hits, cfg.ignore);
	for (const w of cfg.words) {
		for (const m of text.matchAll(w.re)) hits.push({ category: "words", token: w.word.toLowerCase(), line: lineOf(text, m.index ?? 0) });
	}

	if (scope === "markdown" && on("naming")) {
		// «Умные названия» — только в заголовках документов.
		for (const h of text.matchAll(/^#{1,6}\s.*$/gm)) {
			const head = h[0];
			for (let i = 0; i < NAMING_RES.length; i++) {
				for (const m of head.matchAll(NAMING_RES[i])) {
					if (hasIgnore(NAMING[i])) continue;
					hits.push({ category: "naming", token: NAMING[i].toLowerCase(), line: lineOf(text, (h.index ?? 0) + (m.index ?? 0)) });
				}
			}
		}
	}
	if (scope === "commit" && on("naming")) {
		scanWords(text, NAMING_RES, NAMING, "naming", hits, cfg.ignore);
	}

	if (scope === "markdown" && on("structure")) {
		for (const m of text.matchAll(STRUCTURE_RE)) {
			hits.push({ category: "structure", token: "**…:** в буллете", line: lineOf(text, m.index ?? 0) });
		}
	}
	return hits;
}

/** Убирает символы-маркеры (механически исправимое). */
function stripSymbols(text: string): string {
	return text.replace(AUTOFIX_RE, "");
}

// ---------------------------------------------------------------------------
// Фабрика
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<string, string> = {
	symbols: "эмодзи/стрелки",
	"words-ru": "слова-маркеры (RU)",
	"words-en": "слова-маркеры (EN)",
	words: "слова (из конфига)",
	naming: "умные названия",
	structure: "структура",
};

/** Причина блокировки: сгруппированные находки с номерами строк. */
function describeHits(hits: Hit[], limit = 5): string {
	const byCat = new Map<string, Hit[]>();
	for (const h of hits) {
		const arr = byCat.get(h.category) ?? [];
		arr.push(h);
		byCat.set(h.category, arr);
	}
	const parts: string[] = [];
	for (const [cat, hs] of byCat) {
		const shown = hs.slice(0, limit).map((h) => `«${h.token}» (стр. ${h.line})`).join(", ");
		const rest = hs.length - Math.min(hs.length, limit);
		parts.push(`${CATEGORY_LABEL[cat] ?? cat}: ${shown}${rest > 0 ? ` …и ещё ${rest}` : ""}`);
	}
	return parts.join("; ");
}

function blockReason(subject: string, hits: Hit[]): string {
	return (
		`text-guard: в ${subject} найдены маркеры ИИ-стиля: ${describeHits(hits)}. ` +
		"Перепиши этот текст простым человеческим языком: без эмодзи, стрелок и чек-маркеров, " +
		"без вводных слов («давайте», «итак», «стоит отметить», let's, in conclusion), без " +
		"рекламной лексики (delve, leverage, seamless, robust) и без умных названий. Кратко и по делу."
	);
}

function fnv(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

function validMode(v: unknown): Mode {
	return v === "off" || v === "warn" || v === "strict" ? v : DEFAULT_MODE;
}

export default function (pi: ExtensionAPI) {
	// Состояние персистентно: <agentDir>/guard-state.json (переживает /reload и
	// продолжение pi -c; новая сессия pi стартует с дефолтом warn). В субагентах
	// файл сознательно не читается — fail-safe: strict, автофикс выключен.
	let mode: Mode = _isSubagent ? "strict" : validMode(loadGuard("text-guard").mode);
	let autofix = _isSubagent ? false : Boolean(loadGuard("text-guard").autofix);

	let cfg: Config = { allow: [], skip: [], words: [], ignore: new Set(), categories: new Set(ALL_CATEGORIES) };
	let ready = false;

	// Статистика срабатываний за сессию (для /text-guard:stats и бейджа).
	const stats = { tool: 0, chat: 0, byCategory: {} as Record<string, number>, byToken: {} as Record<string, number> };
	let lastNotifyAt = 0;
	const NOTIFY_THROTTLE_MS = 15_000;

	// Защита от петли «блок → переписать → блок»: сигнатура текста, заблокированная
	// дважды за окно, пропускается с одноразовым предупреждением пользователю.
	const LOOP_WINDOW_MS = 5 * 60_000;
	const blockMemory = new Map<string, { count: number; at: number }>();
	const passedLoops = new Set<string>();

	function ensureReady(ctx: ExtensionContext): void {
		if (ready) return;
		cfg = readConfig(ctx.cwd || process.cwd(), ctx);
		ready = true;
	}

	function countHits(hits: Hit[], kind: "tool" | "chat"): void {
		if (kind === "tool") stats.tool += hits.length;
		else stats.chat += hits.length;
		for (const h of hits) {
			stats.byCategory[h.category] = (stats.byCategory[h.category] ?? 0) + 1;
			const tok = h.token.toLowerCase();
			stats.byToken[tok] = (stats.byToken[tok] ?? 0) + 1;
		}
	}

	function badge(ctx: ExtensionContext): string {
		const { theme } = ctx.ui;
		if (mode === "off") return theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ TG OFF ")));
		if (mode === "strict") return theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ TG STRICT ")));
		if (stats.chat > 0) return theme.bg("toolErrorBg", theme.bold(theme.fg("error", ` ⚠ TG ${stats.chat} `)));
		return "";
	}

	function refreshStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, badge(ctx) || undefined);
	}

	function warnNotify(ctx: ExtensionContext, subject: string, hits: Hit[]): void {
		const now = Date.now();
		if (ctx.hasUI && now - lastNotifyAt >= NOTIFY_THROTTLE_MS) {
			lastNotifyAt = now;
			ctx.ui.notify(
				`text-guard (warn): в ${subject}: ${describeHits(hits, 3)}. Текст записан; проверь или настрой в .text-guard.json. Статистика: /text-guard:stats`,
				"warning",
			);
		}
	}

	/** true → пропустить вызов (модель дважды не исправила текст; дальше — тоже). */
	function loopGuard(key: string, ctx: ExtensionContext): boolean {
		if (passedLoops.has(key)) return true;
		const now = Date.now();
		const mem = blockMemory.get(key);
		if (mem && now - mem.at <= LOOP_WINDOW_MS) {
			mem.count++;
			mem.at = now;
			if (mem.count >= 3) {
				passedLoops.add(key);
				if (ctx.hasUI) {
					ctx.ui.notify("text-guard: модель дважды не смогла переписать текст — вызов пропущен с предупреждением. Проверь результат вручную.", "warning");
				}
				return true;
			}
			return false;
		}
		blockMemory.set(key, { count: 1, at: now });
		return false;
	}

	const injectStyle = (event: { systemPromptOptions: { sections: Record<string, string> } }) => {
		if (mode === "off") return;
		event.systemPromptOptions.sections["writing-style"] = STYLE_SECTION;
	};

	const onMessageEnd = (event: { message?: { role?: string; content?: unknown } }, ctx: ExtensionContext) => {
		if (mode === "off") return;
		ensureReady(ctx);
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const content = msg.content;
		const text = Array.isArray(content)
			? content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).join("\n")
			: typeof content === "string"
				? content
				: "";
		if (!text) return;
		const hits = scanScope(text, "chat", cfg);
		if (!hits.length) return;
		countHits(hits, "chat");
		refreshStatus(ctx); // бейдж с количеством находок в чате
	};

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (mode === "off") return;
		ensureReady(ctx);

		if (isToolCallEventType("write", event)) {
			const p = String(event.input.path ?? "");
			const content = String(event.input.content ?? "");
			if (!content.trim() || isSkipped(p, cfg)) return;
			const hits = scanScope(content, scopeForPath(p), cfg);
			if (!hits.length) return;
			countHits(hits, "tool");
			const subject = `файле ${p}`;
			if (mode === "warn") {
				warnNotify(ctx, subject, hits);
				return;
			}
			if (autofix && hits.every((h) => h.category === "symbols")) {
				event.input.content = stripSymbols(content); // механическая чистка in place
				return;
			}
			if (loopGuard(`write:${p}:${fnv(content)}`, ctx)) return;
			return { block: true, reason: blockReason(subject, hits) };
		}

		if (isToolCallEventType("edit", event)) {
			const p = String(event.input.path ?? "");
			if (isSkipped(p, cfg)) return;
			const scope = scopeForPath(p);
			const edits: Array<{ oldText?: string; newText?: string }> = Array.isArray(event.input.edits) ? event.input.edits : [];
			const perEdit: Hit[][] = [];
			const all: Hit[] = [];
			for (const e of edits) {
				// Скан только нового текста: oldText — существующее содержимое.
				const hits = String(e?.newText ?? "").trim() ? scanScope(String(e.newText), scope, cfg) : [];
				perEdit.push(hits);
				all.push(...hits);
			}
			if (!all.length) return;
			countHits(all, "tool");
			const subject = `изменении файла ${p}`;
			if (mode === "warn") {
				warnNotify(ctx, subject, all);
				return;
			}
			if (autofix && all.every((h) => h.category === "symbols")) {
				edits.forEach((e, i) => {
					if (perEdit[i].length) e.newText = stripSymbols(String(e.newText));
				});
				return;
			}
			if (loopGuard(`edit:${p}:${fnv(all.map((h) => h.token + ":" + h.line).join("|"))}`, ctx)) return;
			return { block: true, reason: blockReason(subject, all) };
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (!command.trim()) return;
			const frags = extractBashFragments(command);
			const all: Hit[] = [];
			for (const f of frags) all.push(...scanScope(f.text, f.scope, cfg));
			if (!all.length) return;
			countHits(all, "tool");
			const subject = frags.map((f) => f.what).join(", ") || "bash-команде";
			if (mode === "warn") {
				warnNotify(ctx, subject, all);
				return;
			}
			if (autofix && all.every((h) => h.category === "symbols")) {
				event.input.command = stripSymbols(command); // символы в команде — всегда текст
				return;
			}
			if (loopGuard(`bash:${fnv(command)}`, ctx)) return;
			return { block: true, reason: blockReason(subject, all) };
		}
	};

	if (_isSubagent) {
		// Режим субагента: те же проверки, strict по умолчанию, без UI и команд.
		pi.on("before_agent_start", injectStyle);
		pi.on("tool_call", onToolCall);
		pi.on("message_end", onMessageEnd);
		return;
	}

	// Режим главной сессии.
	pi.registerFlag("text-guard-strict", {
		description: "Запустить сессию в режиме strict (блокировка записи текста с маркерами ИИ-стиля).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("text-guard-off", {
		description: "Запустить сессию с выключенным text-guard.",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		// Новая сессия → дефолт (warn, автофикс выкл) + persist; продолжение
		// (pi -c / --session / resume / reload / fork) → сохранённое состояние.
		if (shouldResetGuards(event, ctx as unknown as Parameters<typeof shouldResetGuards>[1])) {
			mode = DEFAULT_MODE;
			autofix = false;
			saveGuard("text-guard", { mode, autofix });
		}
		if (event.reason === "startup") {
			if (pi.getFlag("text-guard-off") === true && mode !== "off") {
				mode = "off";
				saveGuard("text-guard", { mode });
			} else if (pi.getFlag("text-guard-strict") === true && mode !== "strict") {
				mode = "strict";
				saveGuard("text-guard", { mode });
			}
		}
		refreshStatus(ctx);
	});

	pi.registerCommand("text-guard", {
		description: "Переключить text-guard: off → warn → strict (контроль стиля текста модели).",
		handler: async (_args, ctx) => {
			mode = mode === "off" ? "warn" : mode === "warn" ? "strict" : "off";
			saveGuard("text-guard", { mode });
			refreshStatus(ctx);
			if (mode === "off") {
				ctx.ui.notify("text-guard ВЫКЛЮЧЕН (запомнено: переживёт /reload и pi -c; новая сессия pi стартует с warn). Снова выполни /text-guard, чтобы включить.", "warning");
			} else if (mode === "warn") {
				ctx.ui.notify("text-guard: режим warn — маркеры ИИ-стиля считаются и показываются, текст записывается без блокировки.", "info");
			} else {
				ctx.ui.notify(
					`text-guard: режим strict — запись текста с маркерами блокируется с конкретной причиной${autofix ? "; эмодзи/стрелки правятся автоматически" : ""}. /text-guard:fix — автофикс.`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("text-guard:fix", {
		description: "Переключить автофикс (strict): эмодзи/стрелки/чек-маркеры убираются мутацией ввода вместо блокировки.",
		handler: async (_args, ctx) => {
			autofix = !autofix;
			saveGuard("text-guard", { autofix });
			refreshStatus(ctx);
			ctx.ui.notify(
				autofix
					? "text-guard: автофикс ВКЛЮЧЁН — эмодзи/стрелки убираются автоматически (только в strict; слова правит модель по причине блокировки)."
					: "text-guard: автофикс выключен — любое найденное маркер-совпадение блокирует запись.",
				autofix ? "info" : "warning",
			);
			if (autofix && mode !== "strict") {
				ctx.ui.notify("Автофикс действует только в режиме strict (сейчас: " + mode + ").", "warning");
			}
		},
	});

	pi.registerCommand("text-guard:stats", {
		description: "Статистика срабатываний text-guard за сессию: категории и топ маркеров.",
		handler: async (_args, ctx) => {
			const cats = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
			const toks = Object.entries(stats.byToken).sort((a, b) => b[1] - a[1]).slice(0, 10);
			const lines = [
				`text-guard: режим ${mode}, автофикс ${autofix ? "вкл" : "выкл"}; срабатывания: запись ${stats.tool}, чат ${stats.chat}`,
			];
			if (cats.length) lines.push("Категории: " + cats.map(([c, n]) => `${c}=${n}`).join(", "));
			if (toks.length) lines.push("Топ маркеров: " + toks.map(([t, n]) => `«${t}»×${n}`).join(", "));
			if (!cats.length) lines.push("Маркеров пока не найдено.");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("before_agent_start", injectStyle);
	pi.on("tool_call", onToolCall);
	pi.on("message_end", onMessageEnd);
}
