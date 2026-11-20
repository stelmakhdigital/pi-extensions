import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

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
 * - каждая команда цепочки (`;`, `&&`) после отбрасывания присваиваний
 *   VAR=value начинается на probe-утилиту (grep/egrep/fgrep/rg/diff/cmp/comm/
 *   pgrep); в пайпе смотрим на последнюю команду — её код и есть код пайпа.
 * - всё сходится → isError:false + строка-пояснение в конце вывода.
 *
 * Сознательно НЕ трогаем exit >= 2 и произвольные скрипты: у них non-zero без
 * белого списка кодов — реальный сбой, его прятать нельзя.
 */

const PROBES = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "comm", "pgrep"]);
const NOTE =
	"\n[exit 1 — штатный код: «нет совпадений» (grep/rg/pgrep) или «файлы различаются» (diff/cmp/comm). " +
	"Это не ошибка: продолжай без ретрая, при необходимости переформулируй запрос.]";

/** Первая команда пайп-сегмента — утилита (после `VAR=value`-префиксов). */
function headUtility(segment: string): string | null {
	const parts = segment.trim().split(/\s+/);
	for (const tok of parts) {
		if (!tok || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // присваивание окружения
		return tok.replace(/^\/usr\/bin\//, "");
	}
	return null;
}

/** Код каждой `;`/`&&`-цепочки исполняется последней командой — проверяем все. */
function isProbeChain(command: string): boolean {
	const segments = command.split(/&&|;/).filter((s) => s.trim());
	if (segments.length === 0) return false;
	return segments.every((seg) => {
		const lastPipe = seg.split("|").filter((s) => s.trim()).pop();
		if (!lastPipe) return false;
		const head = headUtility(lastPipe);
		return head !== null && PROBES.has(head);
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (event.toolName !== "bash" || !event.isError) return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!command || !isProbeChain(command)) return;
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
