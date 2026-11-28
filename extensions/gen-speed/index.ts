/**
 * gen-speed: скорость генерации токенов и TTFT в строке статусов футера.
 *
 * Бейдж: 41t/s (0.8s)
 * - скорость: EMA по завершённым ассистент-ответам (alpha 0.4, полупериод ~3);
 * - TTFT: EMA времени до первого токена;
 * - aborted/error-ответы и ответы короче MIN_DT_MS в статистику не входят.
 *
 * Механика: ctx.ui.setStatus — общей строкой статусов, как у остальных
 * расширений. Раньше здесь лежала копия дефолтного футера pi, чтобы бейдж попал
 * в строку токенов; копия разошлась с pi (нет `(provider)` и `(sub)`, `(auto)`
 * печаталось всегда) и расходилась бы дальше с каждым релизом.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const STATUS_KEY = " a-gen-speed";
const EMA_ALPHA = 0.4;
// Ответы короче не считаются: при близком к нулю делителе скорость выдуманная.
// 300ms а не 800ms — быстрая модель генерит 100+ токенов быстрее.
const MIN_DT_MS = 300;

export default function (pi: ExtensionAPI) {
	let t0 = 0; // старт текущего ассистент-сообщения
	let firstTokenAt: number | null = null;
	let emaSpeed: number | null = null; // токены/с
	let emaTtft: number | null = null; // сек

	const asAssistant = (m: unknown): m is AssistantMessage =>
		!!m && (m as { role?: string }).role === "assistant";

	const badge = (): string => {
		if (emaSpeed == null) return "";
		const ttft = emaTtft == null ? "" : emaTtft < 1 ? `${(emaTtft * 1000).toFixed(0)}ms` : `${emaTtft.toFixed(1)}s`;
		return `${Math.round(emaSpeed)}t/s${ttft ? ` (${ttft})` : ""}`;
	};

	pi.on("session_start", async (_event, ctx) => {
		emaSpeed = null;
		emaTtft = null;
		t0 = 0;
		firstTokenAt = null;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("message_start", async (event) => {
		if (!asAssistant(event.message)) return;
		t0 = Date.now();
		firstTokenAt = null;
	});

	pi.on("message_update", async (event) => {
		if (!t0 || !asAssistant(event.message)) return;
		if ((event.message.usage?.output ?? 0) > 0 && firstTokenAt == null) firstTokenAt = Date.now();
	});

	pi.on("message_end", async (event, ctx) => {
		const m = event.message;
		if (!t0 || !asAssistant(m)) {
			t0 = 0;
			firstTokenAt = null;
			return;
		}
		const dt = Date.now() - t0;
		const tokens = Math.max(0, m.usage?.output ?? 0); // output уже включает reasoning
		const failed = m.stopReason === "error" || m.stopReason === "aborted";
		if (dt >= MIN_DT_MS && tokens > 0 && !failed) {
			const speed = tokens / (dt / 1000);
			emaSpeed = emaSpeed == null ? speed : emaSpeed + (speed - emaSpeed) * EMA_ALPHA;
			if (firstTokenAt != null) {
				const ttft = (firstTokenAt - t0) / 1000;
				emaTtft = emaTtft == null ? ttft : emaTtft + (ttft - emaTtft) * EMA_ALPHA;
			}
			ctx.ui.setStatus(STATUS_KEY, badge());
		}
		t0 = 0;
		firstTokenAt = null;
	});
}
