import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { chainHeads } from "../shell-parse.ts";

/**
 * bash-exit-hint: снимает флаг ошибки с bash-вызовов, где exit 1 — штатный
 * результат, а не падение.
 *
 * Мотивация: grep/rg/pgrep с кодом 1 = «нет совпадений», diff/cmp с кодом 1 =
 * «файлы различаются». pi помечает такой результат isError, модель видит
 * «ошибку» и ретраит тот же вызов (71 ретрай за месяц поdigest-сессий).
 *
 * Механика (только tool_result):
 * - isError && в выводе есть "Command exited with code 1";
 * - головная утилита каждой цепочки (`;`, `&&`, `||`) и каждой последней стадии
 *   конвейера — probe-утилита (grep/egrep/fgrep/rg/diff/cmp/comm/pgrep). Разбор
 *   общий с остальными guard'ами (extensions/shell-parse.ts): `grep "a && b" f`
 *   остаётся одной командой, а не двумя.
 * - код каждой цепочки исполняется последней командой, поэтому `||` тоже
 *   разделитель: иначе `grep a f || make deploy` сошёл бы «grep-цепочкой» и
 *   спрятал падение make. exit >= 2 и произвольные скрипты не трогаем.
 * - всё сходится → isError:false + строка-пояснение в конце вывода.
 *
 * Сознательно НЕ трогаем exit >= 2 и произвольные скрипты: у них non-zero без
 * белого списка кодов — реальный сбой, его прятать нельзя.
 */

const PROBES = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "comm", "pgrep"]);
const NOTE =
	"\n[exit 1 — штатный код: «нет совпадений» (grep/rg/pgrep) или «файлы различаются» (diff/cmp/comm). " +
	"Это не ошибка: продолжай без ретрая, при необходимости переформулируй запрос.]";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (event.toolName !== "bash" || !event.isError) return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const heads = command ? chainHeads(command) : null;
		if (!heads || !heads.every((head) => PROBES.has(head))) return;
		const text = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		if (!/Command exited with code 1\s*$/.test(text)) return;
		return {
			isError: false,
			content: [...event.content, { type: "text" as const, text: NOTE }],
		};
	});
}
