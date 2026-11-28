import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { isYolo, onYoloChange } from "../yolo-mode.ts";
import { resolvePath } from "../paths.ts";

/**
 * edit-fresh: две ответственности вокруг одного промаха.
 *
 * 1. Блокирует вызовы `edit`, если файл не читали в этой сессии или он
 *    изменился после последнего read/write/edit.
 *
 * Мотивация: ~60 ошибок «Could not find the exact text» за месяц — модель
 * правит по oldText «по памяти» (из вывода grep или read десятиходовой
 * давности). Правило в AGENTS.md мягкое, здесь оно же — детерминированно.
 *
 * 2. Когда `edit` всё-таки упал на «не нашёл oldText» (файл был прочитан
 *    свежо, но модель потеряли табы/переносы), дописывает в тот же ответ
 *    ближайший реальный фрагмент файла или номера вхождений, если oldText не
 *    уникален. Без него модель идёт за текстом сама: 81 случай `sed -n`/
 *    `grep -n` следующим вызовом и 7 правил через `sed -i` в обход guard'ов.
 *
 * Механика:
 * - tool_result(read|write|edit) без ошибки → запоминаем mtime файла (Map в
 *   памяти процесса; не персистится — после рестарта первый edit на файл
 *   блокируется один раз и разблокируется read'ом).
 * - tool_call(edit) → если файл не в списке или mtime отличается — блок с
 *   указанием, что сделать.
 * - tool_call(write) не блокируется: write — легитимный способ создать файл.
 * - Несуществующий файл не блокируется: edit сам честно сообщит о отсутствии.
 *
 * Флаг: --edit-fresh-disabled (boolean) — запустить сессию без блокировок и
 * без подсказок (подсказка привязана к тому же хендлеру).
 */

// Ключ с пробелом: футер сортирует статусы по алфавиту (см. комментарий в dir-guard).
const STATUS_KEY = " a-edit-fresh";

const fresh = new Map<string, number>(); // канон. путь → mtimeMs на момент read/write/edit
const PENDING_WRITE = -1; // write вызван, tool_result ещё не обработан

function mtimeMs(abs: string): number | null {
	try {
		return fs.statSync(abs).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Подсказка при промахе oldText. Модель переносит oldText «по смыслу»: табы
 * схлопываются в пробелы, строка копируется из grep с префиксом «NN:», теряется
 * висячий пробел. В ответе `edit` реальных байтов нет, и модель идёт за ними
 * сама: за 90 сессий 81 раз следующим вызовом был `sed -n`/`grep -n`, 45 раз —
 * слепой повтор того же edit, а в 7 случаях файл правили `sed -i`/python-скриптом,
 * минуя text-guard и без diff'а в интерфейсе. Отдаём фрагмент в том же ответе.
 */
const MISS_RE = /Could not find (?:the exact text|edits\[)|occurrences of edits/;
const NOT_UNIQUE_RE = /occurrences of edits/;
const MAX_HINT_LINES = 40;
const MAX_HINT_CHARS = 2000;
const MAX_HINT_FILE = 2_000_000; // файлы больше — не наш случай, ищем дорого

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Стартовый oldText в вызове edit: список edits или одиночные поля. */
function oldTextOf(input: Record<string, unknown>): string {
	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const e of edits) {
			const t = (e as { oldText?: unknown } | null)?.oldText;
			if (typeof t === "string" && t) return t;
		}
	}
	return typeof input.oldText === "string" ? input.oldText : "";
}

/** Номера строк точных вхождений oldText — для ошибки «oldText не уникален». */
function occurrences(text: string, needle: string): number[] {
	const out: number[] = [];
	for (let i = text.indexOf(needle); i !== -1 && out.length < 10; i = text.indexOf(needle, i + 1)) {
		out.push(text.slice(0, i).split("\n").length);
	}
	return out;
}

/**
 * Ближайший фрагмент файла: окно той же высоты, чей «нормальный» вид (табы,
 * последовательности пробелов, регистр) совпал лучше всех. Отдаём реальные
 * байты — их и надо копировать в oldText, а не нормализованный вид.
 */
function nearest(lines: string[], oldText: string): { start: number; text: string } | null {
	const needles = oldText.split("\n").map(norm);
	if (!needles.some((n) => n)) return null;
	const hay = lines.map(norm);
	let best = -1;
	let bestScore = 0;
	for (let i = 0; i + needles.length <= lines.length; i++) {
		let score = 0;
		for (let k = 0; k < needles.length; k++) {
			if (!needles[k]) continue;
			if (hay[i + k] === needles[k]) score += 1;
			else if (hay[i + k].includes(needles[k]) || needles[k].includes(hay[i + k])) score += 0.5;
		}
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	if (best < 0 || bestScore < 1) return null;
	const slice = lines.slice(best, Math.min(best + needles.length + 2, best + MAX_HINT_LINES));
	return { start: best + 1, text: slice.join("\n").slice(0, MAX_HINT_CHARS) };
}

/** Что дописать к упавшему edit: номера вхождений или ближайший реальный фрагмент. */
function hintOnMiss(event: ToolResultEvent, abs: string): ToolResultEventResult | undefined {
	const errText = event.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (!MISS_RE.test(errText)) return;
	const oldText = oldTextOf(event.input);
	if (!oldText) return;
	let text: string;
	try {
		text = fs.readFileSync(abs, "utf8");
	} catch {
		return;
	}
	if (text.length > MAX_HINT_FILE) return;
	const path = String(event.input.path ?? abs);

	if (NOT_UNIQUE_RE.test(errText)) {
		const where = occurrences(text, oldText);
		if (!where.length) return; // oldText другого edits[N] или файл уже изменён
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: `edit-hint: oldText встречается в ${path} в строках ${where.join(", ")} — ` +
						"добавь контекста, чтобы он был уникален.",
				},
			],
		};
	}

	const near = nearest(text.split("\n"), oldText);
	if (!near) return;
	return {
		content: [
			...event.content,
			{
				type: "text" as const,
				text:
					`edit-hint: ближайший реальный фрагмент ${path}, строки ${near.start}+ ` +
					`(копируй oldText отсюда, включая табы):\n${near.text}`,
			},
		],
	};
}

export default function (pi: ExtensionAPI) {
	// yolo проверяется в хендлере (см. extensions/yolo): тогда `/yolo` работает
	// и на включение, и на возврат блокировок посреди сессии.
	let lastCtx: ExtensionContext | undefined;
	pi.registerFlag("edit-fresh-disabled", {
		description: "Запустить сессию без edit-fresh (блокировки edit без свежего read).",
		type: "boolean",
		default: false,
	});
	const disabled = pi.getFlag("edit-fresh-disabled") === true;

	// Канонизация обязательна: read по symlink'у и edit по реальному пути —
	// один файл, но разные ключи, и edit ложно блокировался бы «не читан».
	const resolve = (ctx: ExtensionContext, p: string) => resolvePath(ctx.cwd, p);

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (disabled || isYolo()) return;
		// Параллельные вызовы одного ассистентского сообщения префлайтятся
		// последовательно, а tool_result'ы приходят позже всех tool_call'ов
		// (docs/extensions.md, Tool Events). Поэтому read/write из того же хода
		// помечаем здесь — иначе соседний edit ложно блокируется.
		if (isToolCallEventType("read", event)) {
			const absR = resolve(ctx, String(event.input.path ?? ""));
			const mtR = mtimeMs(absR);
			if (mtR !== null) fresh.set(absR, mtR);
			return;
		}
		if (isToolCallEventType("write", event)) {
			fresh.set(resolve(ctx, String(event.input.path ?? "")), PENDING_WRITE);
			return;
		}
		if (!isToolCallEventType("edit", event)) return;
		const abs = resolve(ctx, String(event.input.path ?? ""));
		const mt = mtimeMs(abs);
		if (mt === null) return; // файла нет — пусть edit сообщит об этом сам
		const seen = fresh.get(abs);
		if (seen === PENDING_WRITE) return; // write того же хода: mtime поставит его tool_result
		if (seen === undefined) {
			return {
				block: true,
				reason:
					`edit-fresh: файл ${event.input.path} ещё не читали в этой сессии — ` +
					"oldText «по памяти» почти всегда не совпадает. Сначала read нужной области, потом edit.",
			};
		}
		if (seen !== mt) {
			return {
				block: true,
				reason:
					`edit-fresh: ${event.input.path} изменился после последнего read — ` +
					"перечитай файл (или её нужную область) и повтори edit с oldText из свежего прочитанного.",
			};
		}
	};

	const onToolResult = async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
		if (disabled) return;
		const raw = String((event.input as { path?: unknown }).path ?? "");
		if (!raw) return;
		const abs = resolve(ctx, raw);
		if (event.isError) {
			// Неудавшийся write не делает файл свежим — снимаем пендинг.
			if (event.toolName === "write" && fresh.get(abs) === PENDING_WRITE) fresh.delete(abs);
			if (event.toolName === "edit") return hintOnMiss(event, abs);
			return;
		}
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
		const mt = mtimeMs(abs);
		if (mt !== null) fresh.set(abs, mt);
	};

	const badge = (ctx: ExtensionContext) =>
		ctx.ui.setStatus(STATUS_KEY, isYolo() ? undefined : ctx.ui.theme.fg("dim", " edit-fresh "));

	if (!disabled) {
		pi.on("tool_call", onToolCall);
		pi.on("tool_result", onToolResult);
		pi.on("session_start", async (_event, ctx) => {
			lastCtx = ctx;
			badge(ctx);
		});
		// Бейдж «edit-fresh» не должен врать, что защита стоит, когда её сняли.
		onYoloChange(() => {
			if (lastCtx) badge(lastCtx);
		});
	}
}
