import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * dir-guard: жёсткий блок tool-вызовов (read/write/edit/bash), чьи пути уходят
 * ВНЕ рабочей директории сессии (CWD) и её allowlist'а.
 *
 * Механика:
 * - CWD берётся из ExtensionContext (ctx.cwd), канонизируется (realpath) и
 *   pin'ится на сессию (пересчёт один раз, не на каждый tool call).
 * - Каждый проверяемый путь: resolve против CWD → canonical (realpath; для
 *   несуществующего пути — realpath ближайшего существующего родителя + хвост).
 *   Это закрывает symlink-escape: symlink внутри CWD, указывающий наружу,
 *   разрешается в реальный внешний путь и блокируется.
 * - Bash: эвристика, НЕ полный shell-парсинг. Извлекаются path-подобные токены
 *   (абсолютные пути, ~/…, относительные с ..) и проверяются теми же правилами.
 *   Неразрешимые токены ($VAR, глобы `*`, обратные кавычки) сознательно НЕ
 *   блокируются — осознанный компромисс, см. README.
 * - Allowlist — корневые директории (сам путь и всё в нём): дефолт $HOME/.pi,
 *   флаг --dir-guard-allow (коммат-список) и файл .dir-guard.json в CWD.
 *   Symlink-escape блокируется ВСЕГДА: проверка идёт по canonical (realpath)
 *   пути, а не по строковому виду.
 *
 * Субагент (PI_SUBAGENT_DEPTH >= 1): те же правила, жёсткий блок, без UI.
 */

// Ключ с пробелом в начале: футер сортирует статусы по алфавиту, и предупреждение
// не обрезается truncateToWidth (см. аналогичный комментарий в bash-guard).
const STATUS_KEY = " dir-guard";

const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

/** Раскрывает `~` и `~/...` в домашнюю директорию. */
function expandHome(p: string): string {
	p = p.trim();
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Канонизирует путь, который может ещё не существовать: realpath ближайшего
 * существующего предка + дописанный хвост. Без этого проверка несуществующего
 * пути `cat /etc/new` прошла бы по строковому виду, а symlink-escape в
 * несуществующий хвост — остался бы незамеченным.
 */
function canonical(p: string): string {
	let cur = p;
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(p, ...tail); // канонизировать нечего
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

function isInside(p: string, root: string): boolean {
	const r = root.length > 1 && root.endsWith(path.sep) ? root.slice(0, -1) : root;
	if (r === path.sep) return p === path.sep || p.startsWith(path.sep);
	return p === r || p.startsWith(r + path.sep);
}

type Verdict = { blocked: boolean; reason?: string };

/**
 * Извлекает path-подобные токены из bash-команды (эвристика).
 * Возвращает только то, что можно разрешить в конкретной файловой системе.
 */
function extractBashPaths(command: string): string[] {
	const found = new Set<string>();
	// Абсолютные пути (мульти-сегментные). Пропускаем матчи, за которыми сразу
	// идёт `$`/`*` (продолжение в переменную/глоб — неразрешимо) и матчи после
	// `:` (URL-схемы: `https://host/path`).
	for (const m of command.matchAll(/\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*/g)) {
		const idx = m.index ?? 0;
		const before = command[idx - 1];
		// URL-хост после схемы (`https://host/…`): предыдущий символ — `:` (схема)
		// или `/` (второй слэш из `//host`) — это не файловый путь. Буква/точка —
		// хвост более длинного неразрешимого токена (`$HOME/tmpdir`, `x//etc/x`).
		if (before && (before === ":" || before === "/" || /[A-Za-z0-9_.`}$]/.test(before))) continue;
		const after = command[idx + m[0].length];
		if (after === "$" || after === "*") continue;
		found.add(m[0]);
	}
	// Путь из дома: ~/… (и сам ~); только в начале токена (не `file~1`)
	for (const m of command.matchAll(/(^|\s)~(?:\/[A-Za-z0-9_.\-]+)*/g)) {
		found.add(m[0].slice(m[1].length));
	}
	// Относительные токены с .. — единственный способ уйти ВЫШЕ CWD из относительного пути
	for (const tok of command.split(/\s+/)) {
		if (!tok.includes("..")) continue;
		if (/[$`*]/.test(tok)) continue; // неразрешимо
		if (!/^[A-Za-z0-9_.\/\-]+$/.test(tok)) continue;
		found.add(tok);
	}
	return [...found];
}

export default function (pi: ExtensionAPI) {
	// Состояние сессии (in-memory, не персистент).
	let disabled = false;
	let ready = false;
	let root = "";
	let allowRoots: string[] = [];

	/** Pin'ит CWD (однократно) и собирает allowlist. */
	function ensureReady(ctx: ExtensionContext): void {
		if (ready) return;
		const cwd = ctx.cwd || process.cwd();
		root = canonical(cwd);

		const raw: string[] = [path.join(os.homedir(), ".pi")]; // встроенный дефолт
		const flagVal = pi.getFlag("--dir-guard-allow");
		// Парсер флагов pi знает только одиночные значения (Map, последнее
		// переопределяет) → поддерживаем коммат-список в одном флаге.
		if (typeof flagVal === "string" && flagVal.trim()) {
			raw.push(...flagVal.split(",").map((s) => s.trim()).filter(Boolean));
		}
		const cfgFile = path.join(cwd, ".dir-guard.json");
		if (fs.existsSync(cfgFile)) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
				const allow = (parsed as { allow?: unknown }).allow;
				if (Array.isArray(allow)) {
					raw.push(...allow.filter((x): x is string => typeof x === "string"));
				}
			} catch {
				if (ctx.hasUI) {
					ctx.ui.notify(`dir-guard: невалидный JSON в ${cfgFile} — файл проигнорирован`, "warning");
				}
			}
		}
		allowRoots = [...new Set(raw.map((p) => canonical(expandHome(p))))];
		ready = true;
	}

	/** Проверка одного пути. Возвращает verdict; reason — человекочитаемый. */
	function checkPath(raw: string): Verdict {
		const expanded = expandHome(raw);
		const abs = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
		const resolved = canonical(abs);
		if (isInside(resolved, root)) return { blocked: false };
		for (const a of allowRoots) {
			if (isInside(resolved, a)) return { blocked: false };
		}
		return {
			blocked: true,
			reason:
				`dir-guard: путь ${raw} (→ ${resolved}) вне рабочей директории ${root}. ` +
				"Действуй только внутри рабочей директории; если путь нужен легитимно — " +
				"попроси пользователя добавить его в allowlist (--dir-guard-allow или .dir-guard.json в CWD).",
		};
	}

	function offBadge(ctx: ExtensionContext): string {
		const { theme } = ctx.ui;
		return theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ DR OFF ")));
	}

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (!isToolCallEventType("read", event) && !isToolCallEventType("write", event) &&
			!isToolCallEventType("edit", event) && !isToolCallEventType("bash", event)) {
			return;
		}
		if (disabled) return;
		ensureReady(ctx);

		if (isToolCallEventType("bash", event)) {
			for (const tok of extractBashPaths(event.input.command)) {
				const v = checkPath(tok);
				if (v.blocked) return { block: true, reason: v.reason };
			}
			return;
		}

		const v = checkPath(String(event.input.path));
		if (v.blocked) return { block: true, reason: v.reason };
	};

	if (_isSubagent) {
		// Режим субагента: те же правила, жёсткий блок, без UI и команд.
		pi.on("tool_call", onToolCall);
		return;
	}

	// Режим главной сессии.
	pi.registerFlag("dir-guard-disabled", {
		description: "Запустить сессию с отключённым dir-guard (путь-блокировки не действуют).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("dir-guard-allow", {
		description: "Разрешённые пути вне CWD, список через запятую (например: ~/notes,/opt/reference).",
		type: "string",
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--dir-guard-disabled") === true) {
			disabled = true;
			ctx.ui.setStatus(STATUS_KEY, offBadge(ctx));
		}
	});

	pi.registerCommand("dir-guard", {
		description: "Переключить dir-guard (жёсткий блок путей вне рабочей директории) для этой сессии.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				ctx.ui.setStatus(STATUS_KEY, offBadge(ctx));
				ctx.ui.notify(
					"dir-guard ОТКЛЮЧЁН на эту сессию. Пути вне рабочей директории больше не блокируются. Снова выполни /dir-guard, чтобы включить.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("dir-guard снова включён.", "info");
			}
		},
	});

	pi.on("tool_call", onToolCall);
}
