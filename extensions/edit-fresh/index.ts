import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { isYolo } from "../yolo-mode.ts";

/**
 * edit-fresh: блокирует вызовы `edit`, если файл не читали в этой сессии или
 * он изменился после последнего read/write/edit.
 *
 * Мотивация: ~60 ошибок «Could not find the exact text» за месяц — модель
 * правит по oldText «по памяти» (из вывода grep или read десятиходовой
 * давности). Правило в AGENTS.md мягкое, здесь оно же — детерминированно.
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
 * Флаг: --edit-fresh-disabled (boolean) — запустить сессию без блокировок.
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

export default function (pi: ExtensionAPI) {
	// yolo: edit без свежего read разрешён (см. extensions/yolo).
	if (isYolo()) return;
	pi.registerFlag("edit-fresh-disabled", {
		description: "Запустить сессию без edit-fresh (блокировки edit без свежего read).",
		type: "boolean",
		default: false,
	});
	const disabled = pi.getFlag("edit-fresh-disabled") === true;

	const resolve = (ctx: ExtensionContext, p: string) => path.resolve(ctx.cwd || process.cwd(), p);

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (disabled) return;
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

	const onToolResult = async (event: ToolResultEvent, ctx: ExtensionContext): Promise<undefined> => {
		if (disabled) return;
		const raw = String((event.input as { path?: unknown }).path ?? "");
		if (!raw) return;
		const abs = resolve(ctx, raw);
		if (event.isError) {
			// Неудавшийся write не делает файл свежим — снимаем пендинг.
			if (event.toolName === "write" && fresh.get(abs) === PENDING_WRITE) fresh.delete(abs);
			return;
		}
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
		const mt = mtimeMs(abs);
		if (mt !== null) fresh.set(abs, mt);
	};

	if (!disabled) {
		pi.on("tool_call", onToolCall);
		pi.on("tool_result", onToolResult);
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", " edit-fresh "));
		});
	}
}
