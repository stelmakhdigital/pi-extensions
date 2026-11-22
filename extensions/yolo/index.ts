/**
 * yolo — автономный режим: агент стартует с максимальными правами, ни один
 * guard и ни один стартовый вопрос его не останавливает.
 *
 * Включается `pi --yolo` или `PI_YOLO=1` (наследуется дочерними pi). Для
 * Orca-автоматизаций, CI и любых запусков, где в TUI никто не ответит.
 *
 * Что делает это расширение:
 * - регистрирует флаг `--yolo` (сам режим реализуют остальные расширения,
 *   они спрашивают isYolo() из ../yolo-mode.ts и рано выходят из factory);
 * - отвечает за pi на «Trust project folder?» — доверяет, ничего не забывая
 *   в trust.json (решение живёт только в этом процессе);
 * - ставит PI_YOLO=1 в окружение процесса и бейдж в футер, чтобы режим было
 *   видно.
 *
 * Что выключается (см. README): sandbox-изоляция и её вопрос о доверии,
 * tmux-handoff у субагентов, bash-guard (включая «пол»), dir-guard,
 * edit-fresh, text-guard, confirm-гейт браузера в agents-web-search.
 * Ничего не отменяется решением пользователя: выбор в диалоге, который
 * модель вызвала сама (ask_user_question), остаётся диалогом.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isYolo } from "../yolo-mode.ts";

// Ведущий пробел: не обрезается футером; "z-": бейдж после иконок guard'ов
// (футер сортирует ключи по localeCompare).
const STATUS_KEY = " z-yolo";

export default function (pi: ExtensionAPI) {
	// Флаг регистрируется всегда — иначе `pi --help` про него молчит.
	pi.registerFlag("yolo", {
		description:
			"Автономный режим: без стартовых вопросов (доверие проекту, tmux-handoff) и без блокировок guard'ов, включая «пол» bash-guard.",
		type: "boolean",
		default: false,
	});

	if (!isYolo()) return;
	process.env.PI_YOLO = "1";

	// pi спрашивает про доверие проекту до загрузки project-ресурсов. Первый
	// вернувший yes/no забирает решение и гасит встроенный промпт; расширение
	// стоит первым в pi.extensions, поэтому доверяем здесь.
	pi.on("project_trust", async () => ({ trusted: "yes" as const }));

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const t = ctx.ui.theme;
		ctx.ui.setStatus(STATUS_KEY, t.bg("toolErrorBg", t.bold(t.fg("error", " ⚠ YOLO "))));
		ctx.ui.notify("yolo: guard'ы выключены, доверие проекту дано автоматически.", "warning");
	});
}
