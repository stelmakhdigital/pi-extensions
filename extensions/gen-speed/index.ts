/**
 * gen-speed: скорость генерации токенов и TTFT в футере — в строке токенов
 * (рядом с «↑1.6M ↓30k 24.2%/262k (auto)»), тем же dim-стилем.
 *
 * Бейдж: 41t/s (0.8s)
 * - скорость: EMA по завершённым ассистент-ответам (alpha 0.4, полупериод ~3);
 * - TTFT: EMA времени до первого токена
 * - aborted/error-ответы и ответы короче 800ms не участвуют в статистике
 *
 * Механика: ctx.ui.setFooter с копией дефолтного футера pi, в которую бейдж
 * добавляется в конец stats-блока слева. Статусы других расширений
 * (setStatus) рисуются отдельной строкой, как в дефолте. При сбое render —
 * безопасный фолбэк.
 */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const EMA_ALPHA = 0.4;
const MIN_DT_MS = 300; // ответы короче этого не считаются (защита от нуля в делителе); у быстрых моделей 100+ токенов генерится за <800ms

type Theme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

const addUsage = (totals: Totals, usage?: Usage) => {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
};

const formatTokens = (count: number): string => {
	if (count < 1e3) return count.toString();
	if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
	if (count < 1e6) return `${Math.round(count / 1e3)}k`;
	if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
	return `${Math.round(count / 1e6)}M`;
};

const formatCwd = (cwd: string): string => {
	const home = homedir();
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
		return rel === "" ? "~" : `~${sep}${rel}`;
	}
	return cwd;
};

export default function (pi: ExtensionAPI) {
	let t0 = 0; // старт текущего ассистент-сообщения
	let firstTokenAt: number | null = null;
	let emaSpeed: number | null = null; // токены/с
	let emaTtft: number | null = null; // сек
	let footerInstalled = false;
	let ctxRef: ExtensionContext | null = null;
	let tuiRef: { requestRender(): void } | null = null;

	const genTokens = (m: AssistantMessage): number =>
		Math.max(0, m?.usage?.output ?? 0); // output уже включает reasoning

	const badge = (): string => {
		if (emaSpeed == null) return "";
		const ttft =
			emaTtft == null ? "" : emaTtft < 1 ? (emaTtft * 1000).toFixed(0) + "ms" : emaTtft.toFixed(1) + "s";
		return `${Math.round(emaSpeed)}t/s${ttft ? ` (${ttft})` : ""}`;
	};

	const asAssistant = (m: unknown): m is AssistantMessage =>
		!!m && (m as { role?: string }).role === "assistant";

	// ---------- копия дефолтного футера pi (FooterComponent) ----------

	const renderStats = (width: number, theme: Theme): string[] => {
		const ctx = ctxRef;
		if (!ctx) return [];
		const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		let latestCacheHitRate: number | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsage(totals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsage(totals, entry.message.usage);
				const prompt = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate = prompt > 0 ? (entry.message.usage.cacheRead / prompt) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsage(totals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: Usage }).usage) {
				addUsage(totals, (entry as { usage?: Usage }).usage);
			}
		}

		const contextUsage = ctx.getContextUsage?.();
		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercent = contextUsage?.percent ?? null;

		const parts: string[] = [];
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}
		if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
		const myBadge = badge();
		if (myBadge) parts.push(myBadge);

		const autoIndicator = " (auto)";
		const contextDisplay =
			contextPercent === null
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
		const contextStr =
			(contextPercent ?? 0) > 90
				? theme.fg("error", contextDisplay)
				: (contextPercent ?? 0) > 70
					? theme.fg("warning", contextDisplay)
					: contextDisplay;
		parts.push(contextStr);

		const statsLeft = parts.join(" ");
		const leftWidth = visibleWidth(statsLeft);
		if (leftWidth > width) return [truncateToWidth(theme.fg("dim", statsLeft), width, "...")];

		const minPadding = 2;
		let rightSide = ctx.model?.id || "no-model";
		if (ctx.model?.reasoning) {
			const level = ctx.thinkingLevel || "off";
			rightSide = level === "off" ? `${rightSide} • thinking off` : `${rightSide} • ${level}`;
		}
		const rightWidth = visibleWidth(rightSide);
		if (leftWidth + minPadding + rightWidth <= width) {
			const padding = " ".repeat(width - leftWidth - rightWidth);
			return [theme.fg("dim", `${statsLeft}${padding}${rightSide}`)];
		}
		const availableForRight = width - leftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
			return [theme.fg("dim", `${statsLeft}${padding}${truncatedRight}`)];
		}
		return [theme.fg("dim", statsLeft)];
	};

	const installFooter = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || footerInstalled) return;
		ctxRef = ctx;
		try {
			ctx.ui.setFooter((tui, theme, footerData) => {
				tuiRef = tui as unknown as { requestRender(): void };
				const unsub = footerData.onBranchChange(() => tui.requestRender());
				return {
					invalidate() {},
					render(width: number): string[] {
						try {
							let pwd = ctxRef ? formatCwd(ctxRef.cwd) : "~";
							const branch = footerData.getGitBranch();
							if (branch) pwd = `${pwd} (${branch})`;
							try {
								const name = ctxRef?.sessionManager.getSessionName?.();
								if (name) pwd = `${pwd} • ${name}`;
							} catch {}
							let lines = [
								truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
								...renderStats(width, theme),
							];
							// строка статусов других расширений — как в дефолте
							const statuses = footerData.getExtensionStatuses();
							if (statuses.size > 0) {
								const statusLine = Array.from(statuses.entries())
									.sort(([a], [b]) => a.localeCompare(b))
									.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
									.join(" ");
								lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
							}
							return lines;
						} catch {
							return [theme.fg("dim", "(gen-speed: footer render error)")];
						}
					},
					dispose: unsub,
				};
			});
			footerInstalled = true;
		} catch {
			// setFooter недоступен (не TUI) — молча остаёмся без бейджа
		}
	};

	// ---------- события ----------

	pi.on("session_start", async (_event, ctx) => {
		emaSpeed = null;
		emaTtft = null;
		t0 = 0;
		firstTokenAt = null;
		footerInstalled = false;
		installFooter(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		installFooter(ctx);
		if (!asAssistant(event.message)) return;
		t0 = Date.now();
		firstTokenAt = null;
	});

	pi.on("message_update", async (event, ctx) => {
		installFooter(ctx);
		if (!t0 || !asAssistant(event.message)) return;
		const tokens = genTokens(event.message);
		if (tokens > 0 && firstTokenAt == null) firstTokenAt = Date.now();
	});

	pi.on("message_end", async (event, ctx) => {
		installFooter(ctx);
		const m = event.message;
		if (!t0 || !asAssistant(m)) {
			t0 = 0;
			firstTokenAt = null;
			return;
		}
		const dt = Date.now() - t0;
		const tokens = genTokens(m);
		const failed = m.stopReason === "error" || m.stopReason === "aborted";
		let changed = false;
		if (dt >= MIN_DT_MS && tokens > 0 && !failed) {
			const speed = tokens / (dt / 1000);
			emaSpeed = emaSpeed == null ? speed : emaSpeed + (speed - emaSpeed) * EMA_ALPHA;
			if (firstTokenAt != null) {
				const ttft = (firstTokenAt - t0) / 1000;
				emaTtft = emaTtft == null ? ttft : emaTtft + (ttft - emaTtft) * EMA_ALPHA;
			}
			changed = true;
		}
		t0 = 0;
		firstTokenAt = null;
		if (changed) tuiRef?.requestRender();
	});
}
