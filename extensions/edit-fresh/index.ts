import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

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

function mtimeMs(abs: string): number | null {
	try {
		return fs.statSync(abs).mtimeMs;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("edit-fresh-disabled", {
		description: "Запустить сессию без edit-fresh (блокировки edit без свежего read).",
		type: "boolean",
		default: false,
	});
	const disabled = pi.getFlag("edit-fresh-disabled") === true;

	const resolve = (ctx: ExtensionContext, p: string) => path.resolve(ctx.cwd || process.cwd(), p);

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		if (disabled) return;
		if (!isToolCallEventType("edit", event)) return;
		const abs = resolve(ctx, String(event.input.path ?? ""));
		const mt = mtimeMs(abs);
		if (mt === null) return; // файла нет — пусть edit сообщит об этом сам
		const seen = fresh.get(abs);
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
		if (disabled || event.isError) return;
		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
		const raw = String((event.input as { path?: unknown }).path ?? "");
		if (!raw) return;
		const abs = resolve(ctx, raw);
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
