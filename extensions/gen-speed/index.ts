/**
 * gen-speed: скорость генерации токенов и TTFT в футере.
 *
 * Бейдж: 41 t/s · ⌀ 0.8s
 * - скорость: EMA по завершённым ассистент-ответам (alpha 0.4, полупериод ~3);
 *   на лету (message_update) — инстантная скорость текущей генерации
 * - TTFT: EMA времени до первого токена
 * - aborted/error-ответы и ответы короче 800ms не участвуют в статистике
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const STATUS_KEY = "gen-speed";
const EMA_ALPHA = 0.4;
const MIN_DT_MS = 800; // ответы короче этого не считаются (шум)
const PAINT_INTERVAL_MS = 250; // троттлинг обновления бейджа во время стрима

export default function (pi: ExtensionAPI) {
	let t0 = 0; // старт текущего ассистент-сообщения
	let firstTokenAt: number | null = null;
	let emaSpeed: number | null = null; // токены/с
	let emaTtft: number | null = null; // сек
	let lastPaint = 0;
	let ui: ExtensionAPI["ui"] | null = null;

	const genTokens = (m: AssistantMessage): number =>
		Math.max(0, m?.usage?.output ?? 0); // output уже включает reasoning

	const paint = (speed: number) => {
		if (!ui) return;
		const ttft =
			emaTtft == null
				? ""
				: ` · ⌀ ${emaTtft < 1 ? (emaTtft * 1000).toFixed(0) + "ms" : emaTtft.toFixed(1) + "s"}`;
		ui.setStatus(STATUS_KEY, `${Math.round(speed)} t/s${ttft}`);
	};

	const asAssistant = (m: unknown): m is AssistantMessage =>
		!!m && (m as { role?: string }).role === "assistant";

	pi.on("message_start", async (event, ctx) => {
		ui = ctx.ui;
		if (!asAssistant(event.message)) return;
		t0 = Date.now();
		firstTokenAt = null;
	});

	pi.on("message_update", async (event, ctx) => {
		ui = ctx.ui;
		if (!t0 || !asAssistant(event.message)) return;
		const tokens = genTokens(event.message);
		const now = Date.now();
		if (tokens > 0 && firstTokenAt == null) firstTokenAt = now;
		if (now - lastPaint < PAINT_INTERVAL_MS) return;
		lastPaint = now;
		const dt = now - t0;
		if (dt < 1200 || tokens === 0) return;
		paint(tokens / (dt / 1000)); // на лету: инстантная скорость
	});

	pi.on("message_end", async (event, ctx) => {
		ui = ctx.ui;
		const m = event.message;
		if (!t0 || !asAssistant(m)) {
			t0 = 0;
			firstTokenAt = null;
			return;
		}
		const dt = Date.now() - t0;
		const tokens = genTokens(m);
		const failed = m.stopReason === "error" || m.stopReason === "aborted";
		if (dt >= MIN_DT_MS && tokens > 0 && !failed) {
			const speed = tokens / (dt / 1000);
			emaSpeed = emaSpeed == null ? speed : emaSpeed + (speed - emaSpeed) * EMA_ALPHA;
			if (firstTokenAt != null) {
				const ttft = (firstTokenAt - t0) / 1000;
				emaTtft = emaTtft == null ? ttft : emaTtft + (ttft - emaTtft) * EMA_ALPHA;
			}
			if (emaSpeed != null) paint(emaSpeed);
		}
		t0 = 0;
		firstTokenAt = null;
	});

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		emaSpeed = null;
		emaTtft = null;
		ui?.setStatus(STATUS_KEY, undefined);
		t0 = 0;
		firstTokenAt = null;
	});
}
