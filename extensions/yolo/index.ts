/**
 * yolo — автономный режим: агент работает с максимальными правами, ни один
 * guard и ни один стартовый вопрос его не останавливает.
 *
 * Включается `pi --yolo`, `PI_YOLO=1` (наследуется дочерними pi) или командой
 * `/yolo` в уже идущей сессии. Для Orca-автоматизаций, CI и любых запусков,
 * где в TUI никто не ответит.
 *
 * Что делает это расширение:
 * - регистрирует флаг `--yolo` и команду `/yolo` (сам режим реализуют остальные
 *   расширения: они спрашивают isYolo() из ../yolo-mode.ts в момент блокировки);
 * - отвечает за pi на «Trust project folder?» — доверяет, ничего не забывая
 *   в trust.json (решение живёт только в этом процессе);
 * - ставит PI_YOLO=1 в окружение процесса и бейдж в футер, чтобы режим было
 *   видно.
 *
 * Что выключается (см. README): sandbox-изоляция и её вопрос о доверии проекту,
 * tmux-handoff у субагентов, bash-guard (включая «пол»), dir-guard, edit-fresh,
 * text-guard, confirm-гейт браузера в agents-web-search. Ничего не отменяется
 * решением пользователя: выбор в диалоге, который модель вызвала сама
 * (ask_user_question), остаётся диалогом.
 *
 * Чего `/yolo` не делает: вопросы старта («Trust project folder?», tmux-handoff)
 * он не отменяет — они случаются раньше, чем в сессии можно ввести команду.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isYolo, setYolo } from "../yolo-mode.ts";

// Ведущий пробел: не обрезается футером; "z-": бейдж после иконок guard'ов
// (футер сортирует ключи по localeCompare).
const STATUS_KEY = " z-yolo";

export default function (pi: ExtensionAPI) {
	// Флаг и команда регистрируются всегда — иначе `pi --help` про флаг молчит,
	// а в не-yolo сессии нечем было бы включить режим.
	pi.registerFlag("yolo", {
		description:
			"Автономный режим: без стартовых вопросов (доверие проекту, tmux-handoff) и без блокировок guard'ов, включая «пол» bash-guard.",
		type: "boolean",
		default: false,
	});

	if (isYolo()) process.env.PI_YOLO = "1";

	// pi спрашивает про доверие проекту до загрузки project-ресурсов. Первый
	// вернувший yes/no забирает решение и гасит встроенный промпт; расширение
	// стоит первым в pi.extensions, поэтому доверяем здесь. Без режима отдаём
	// решение дальше (sandbox спрашивает свой уровень).
	pi.on("project_trust", async () =>
		isYolo() ? ({ trusted: "yes" as const }) : ({ trusted: "undecided" as const })
	);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		refreshBadge(ctx);
		if (isYolo()) ctx.ui.notify("yolo: guard'ы выключены, доверие проекту дано автоматически.", "warning");
	});

	pi.registerCommand("yolo", {
		description:
			"Переключить автономный режим для этой сессии: блокировки guard'ов сняты/вернуты, дочерние агенты наследуют состояние. Стартовые вопросы (доверие проекту, tmux-handoff) переключаются только флагом запуска.",
		handler: async (_args, ctx) => {
			const on = setYolo(!isYolo());
			refreshBadge(ctx);
			ctx.ui.notify(
				on
					? "yolo ВКЛЮЧЁН: guard'ы (bash-guard с «полом», dir-guard, edit-fresh, text-guard, sandbox) пропускают вызовы, дочерние pi наследуют PI_YOLO=1. Доверие проекту и tmux-handoff — только стартовым `--yolo`. Снова /yolo — вернуть защиту."
					: "yolo ВЫКЛЮЧЕН: guard'ы снова блокируют. После /reload состояние вернётся из env/argv, так что при запуске с `--yolo` нужен `pi -c` без флага.",
				on ? "warning" : "info"
			);
		},
	});
}

function refreshBadge(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const t = ctx.ui.theme;
	ctx.ui.setStatus(STATUS_KEY, isYolo() ? t.bg("toolErrorBg", t.bold(t.fg("error", " ⚠ YOLO "))) : undefined);
}
