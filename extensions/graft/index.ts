/**
 * Graft — интеграция собственного кодового графа (pi-graft-engine) в pi.
 *
 * - Движок: engine/graft/ (чистый TS: tree-sitter-wasm, без чужого runtime).
 * - Нативные инструменты: graft_ask, graft_grep, graft_callers, graft_skeleton,
 *   graft_map, graft_check, graft_blast (прямой import движка, без spawn).
 * - `<graft>`-секция системного промпта: `graft map` обновляется при каждом
 *   промпте (TTL-кэш 120s, инвалидация после правок).
 * - Push-режим (флаг --graft-push): `graft ask "<промпт>"` в секцию.
 * - Blast radius: после write/edit дописывается блок «кто зависит от изменённых
 *   символов».
 * - Бейдж свежести: `graft: synced` / `graft: ⚠ N stale` / `graft: нет графа`.
 * - Команда /graft: статус + `/graft build` / `/graft build deep`.
 * - Deep-конфиг LLM (явный, без дефолтов): GRFT_LLM_BASE_URL, GRFT_LLM_MODEL,
 *   GRFT_LLM_API_KEY (openai-chat-формат).
 *
 * Активно только в репозиториях с построенным графом (graft/.engine/graph.json).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	blastFileText,
	build,
	checkStatus,
	deepCoverage,
	enableAutoRebuild,
	ensureFresh,
	findGraphRoot,
	makeQueries,
	type DeepConfig,
} from "../../engine/graft/src/index.js";

const STATUS_KEY = " graft";

function cap(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + `\n…[обрезано до ${max} символов]`;
}

function deepConfigFromEnv(): DeepConfig | null {
	const baseUrl = process.env.GRFT_LLM_BASE_URL?.trim();
	const model = process.env.GRFT_LLM_MODEL?.trim();
	if (!baseUrl || !model) return null;
	return { baseUrl, model, apiKey: process.env.GRFT_LLM_API_KEY?.trim() || undefined };
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function graftExtension(pi: ExtensionAPI) {
	pi.registerFlag("graft", {
		description: "Включить интеграцию Graft (авто: активна, если в репо построен граф graft/)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-map", {
		description: "Подмешивать `graft map` в системный промпт (секция <graft>)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-push", {
		description: "При каждом промпте догонять `graft ask \"<промпт>\"` и класть топ-хиты в секцию <graft>",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("graft-blast", {
		description: "После write/edit дописывать blast radius (кто зависит от изменённых символов)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-max-output", {
		description: "Лимит вывода graft-инструментов в символах (число; env GRFT_MAX_OUTPUT)",
		type: "string",
		default: "16000",
	});
	pi.registerFlag("graft-auto-rebuild", {
		description: "Тихая пересборка графа после правок write/edit (дебаунс 4 c; бейдж «syncing…»)",
		type: "boolean",
		default: true,
	});

	let mapCache: { text: string; at: number } | null = null;
	const MAP_TTL_MS = 120_000;

	function enabled(ctx: ExtensionContext): boolean {
		if (pi.getFlag("--graft") === false) return false;
		return findGraphRoot(ctx.cwd) !== null;
	}

	function rootOf(ctx: ExtensionContext): string | null {
		return findGraphRoot(ctx.cwd);
	}

	function maxOut(): number {
		const raw = pi.getFlag("--graft-max-output") ?? process.env.GRFT_MAX_OUTPUT ?? "16000";
		const v = Number(typeof raw === "string" ? raw : String(raw));
		return Number.isFinite(v) && v > 0 ? v : 16000;
	}

	const noGraphHint =
		"В этом каталоге нет графа Graft (graft/.engine не найден выше cwd). Собери: `/graft build` (или `node engine/graft/bin/graft.mjs build`), затем вызови инструмент снова.";


	async function refreshBadge(ctx: ExtensionContext, root: string | null): Promise<void> {
		if (!ctx.hasUI) return;
		if (!root) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		try {
			const st = await checkStatus(root);
			if (st.text === "нет графа") {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "graft: нет графа — /graft build"));
				return;
			}
			const cov = Math.round(deepCoverage(root) * 100);
			const deepPart = cov > 0 ? ` · ${cov}% deep` : "";
			if (!st.ok) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `graft: ⚠ ${st.stale} stale${st.added ? ` +${st.added} new` : ""}${deepPart}`));
			else ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `graft: synced${deepPart}`));
		} catch {
			// тихо
		}
	}

	/** «syncing…» на время тихой пересборки (сбрасывается в refreshBadge). */
	function setSyncingBadge(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "graft: syncing…"));
	}

	// ---------- Инструменты ----------

	pi.registerTool({
		name: "graft_ask",
		label: "graft_ask",
		description:
			"Ранжированный запрос к графу Graft: подходящие символы/ноды с точными file:line и кодом (детерминированный поиск, без LLM). Для понимания «как это работает / где это лежит». Для исчерпывающего «все вхождения» используй graft_grep.",
		promptSnippet: "Ranked lookup in the local Graft code graph (nodes with file:line, $0, deterministic).",
		parameters: Type.Object({
			query: Type.String({ description: "Вопрос или набор идентификаторов (символ, строка ошибки, имя файла)" }),
			source: Type.Optional(Type.Boolean({ description: "(унаследованный флаг; выдача и так включает сниппеты) Включить кодовые пролёты" })),
			full: Type.Optional(Type.Boolean({ description: "(унаследованный флаг; без эффекта в v1) Полные определения вместо crux" })),
			scope: Type.Optional(Type.String({ description: "Ограничить подпроектом монорепо (префикс пути)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				let out = makeQueries(root).ask(params.query);
				if (params.scope) {
					const prefix = params.scope.endsWith("/") ? params.scope : `${params.scope}/`;
					out = out.split("\n").filter((l) => !l.includes(prefix) || l.includes("graft ask")).join("\n");
				}
				return toolResult(cap(out, maxOut()), { cmd: `graft ask ${params.query}` });
			} catch (e) {
				return toolResult(`graft ask: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_grep",
		label: "graft_grep",
		description:
			"Исчерпывающий regex-поиск по всем индексированным файлам графа Graft; хиты сгруппированы по замыкающему символу и ранжированы по связанности. Используй вместо grep -rn для индексированных файлов.",
		promptSnippet: "Exhaustive regex search over Graft-indexed files, grouped by enclosing symbol.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex (или литерал с fixed: true)" }),
			scope: Type.Optional(Type.String({ description: "Префикс пути (файлы под этим каталогом)" })),
			fixed: Type.Optional(Type.Boolean({ description: "Трактовать pattern как строку, не regex" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Без учёта регистра" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				const out = makeQueries(root).grep(params.pattern, { scope: params.scope, fixed: params.fixed, ignoreCase: params.ignoreCase });
				return toolResult(cap(out, maxOut()), { cmd: `graft grep ${params.pattern}` });
			} catch (e) {
				return toolResult(`graft grep: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_callers",
		label: "graft_callers",
		description:
			'Точные предвычисленные рёбра графа Graft: кто вызывает/использует символ (direction: "in", по умолчанию) или на что сам ссылается (direction: "out"). depth — транзитивное обхождение (blast radius).',
		promptSnippet: "Exact dependency edges from the Graft graph (callers/callees, transitive depth).",
		parameters: Type.Object({
			symbol: Type.String({ description: "Имя символа (функция, класс, метод)" }),
			direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")], { description: "in (по умолчанию): кто зависит; out: на что зависит" })),
			depth: Type.Optional(Type.Number({ description: "Глубина транзитивного обхода (blast radius)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				const out = makeQueries(root).callers(params.symbol, { direction: params.direction, depth: params.depth });
				return toolResult(cap(out, maxOut()), { cmd: `graft callers ${params.symbol}` });
			} catch (e) {
				return toolResult(`graft callers: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_skeleton",
		label: "graft_skeleton",
		description:
			"Все сигнатуры одного файла (без тел) из графа Graft — API-поверхность примерно в 10 раз дешевле чтения файла целиком. Используй, чтобы осмотреть файл, прежде чем открывать его.",
		promptSnippet: "Every signature in a file from the Graft graph, ~10x cheaper than reading it.",
		parameters: Type.Object({
			file: Type.String({ description: "Путь к файлу (относительно корневого каталога графа)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				const out = makeQueries(root).skeleton(params.file);
				return toolResult(cap(out, maxOut()), { cmd: `graft skeleton ${params.file}` });
			} catch (e) {
				return toolResult(`graft skeleton: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_map",
		label: "graft_map",
		description:
			"Ориентация в репо по графу Graft с бюджетом токенов: кластеры каталогов, хабы и hotspots (по in-degree). Точка входа в неизученном репо — сначала graft_map.",
		promptSnippet: "Token-budgeted repo orientation from the Graft graph (dir clusters, hubs, hotspots).",
		parameters: Type.Object({
			maxDirs: Type.Optional(Type.Number({ description: "Число каталогов в выводе (по умолчанию — авто)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				const out = makeQueries(root).map({ maxDirs: params.maxDirs });
				mapCache = { text: out, at: Date.now() };
				return toolResult(cap(out, maxOut()), { cmd: "graft map" });
			} catch (e) {
				return toolResult(`graft map: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_check",
		label: "graft_check",
		description:
			"Отчёт о свежести графа Graft: дрейф graft/ относительно кода (добавлено/удалено/изменено/stale), JSON. Не пересобирает граф — только сообщает.",
		promptSnippet: "Freshness/drift report of the Graft graph (JSON).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				const { text, json } = await makeQueries(root).check();
				void refreshBadge(ctx, root);
				return toolResult(text, json as Record<string, unknown>);
			} catch (e) {
				return toolResult(`graft check: ${(e as Error).message}`, { error: "check" });
			}
		},
	});

	pi.registerTool({
		name: "graft_blast",
		label: "graft_blast",
		description:
			"Blast radius git-диффа по графу Graft: что зависит от строк, затронутых изменениями. base — референс для diff (например origin/main); без base — индекс/stage.",
		promptSnippet: "Blast radius of a git diff from the Graft graph.",
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "Git-референс для сравнения (например origin/main)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			try {
				await ensureFresh(root);
				const out = await makeQueries(root).blast(params.base);
				return toolResult(cap(out, maxOut()), { cmd: `graft blast ${params.base ?? ""}`.trim() });
			} catch (e) {
				return toolResult(`graft blast: ${(e as Error).message}`, { error: "blast" });
			}
		},
	});

	// ---------- Хуки ----------

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled(ctx)) return;
		await refreshBadge(ctx, rootOf(ctx));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled(ctx)) return;
		const wantMap = pi.getFlag("--graft-map") !== false;
		const wantPush = pi.getFlag("--graft-push") === true;
		if (!wantMap && !wantPush) return;
		const root = rootOf(ctx);
		if (!root) return;

		const parts: string[] = [];
		if (wantMap) {
			if (!mapCache || Date.now() - mapCache.at > MAP_TTL_MS) {
				try {
					await ensureFresh(root);
					const out = makeQueries(root).map();
					mapCache = { text: out, at: Date.now() };
				} catch {
					if (!mapCache) return;
				}
			}
			parts.push(mapCache.text);
		}
		if (wantPush) {
			try {
				const out = makeQueries(root).ask(event.prompt);
				parts.push(`## Top-хиты графа под текущий промпт\n${cap(out, 4000)}`);
			} catch {
				// тихо
			}
		}
		if (parts.length > 0) {
			event.systemPromptOptions.sections["graft"] =
				`Нижележащий локальный граф кодовой базы (graft/) — собственный движок pi-graft-engine (engine/graft). Используй его ПЕРЕД grep/чтениями файлов. ` +
				`Для уточнения есть инструменты graft_ask/graft_grep/graft_callers/graft_skeleton.\n\n` +
				parts.join("\n\n");
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (!enabled(ctx)) return;
		if (pi.getFlag("--graft-blast") === false) return;
		const path = event.input?.path;
		if (typeof path !== "string" || path.length === 0) return;
		const root = rootOf(ctx);
		if (!root) return;

		mapCache = null;
		const blast = blastFileText(root, path);
		const note = blast ? `🌿 Graft blast radius по ${path}:\n${blast}` : "";
		if (note && ctx.hasUI) ctx.ui.notify(note, "info");

		// Auto-rebuild: тихая пересборка после правки (дебаунс в enableAutoRebuild).
		if (pi.getFlag("--graft-auto-rebuild") !== false) {
			setSyncingBadge(ctx);
			enableAutoRebuild(() => build(root, {}).then(() => refreshBadge(ctx, root)));
		}
		return note ? { content: [...event.content, { type: "text", text: note }] } : undefined;
	});

	// ---------- Команда /graft ----------

	pi.registerCommand("graft", {
		description: "Статус Graft: /graft — сводка; /graft build [, deep] — пересобрать граф",
		handler: async (args: string, ctx) => {
			const root = rootOf(ctx);
			const parts: string[] = [`Graft: pi-graft-engine (engine/graft, свой движок)`];
			if (root) {
				const st = await checkStatus(root);
				const cov = Math.round(deepCoverage(root) * 100);
				parts.push(
					st.text === "нет графа"
						? "Граф: НЕ СОБРАН (/graft build)"
						: `Граф: ${root} — ${st.ok ? "синхронен" : `дрейф (stale ${st.stale}, new ${st.added})`}${cov > 0 ? ` · ${cov}% deep` : ""}`,
				);
			} else {
				parts.push("Граф: не найден (запусти `/graft build` в корне репо)");
			}
			parts.push(`Флаги: map=${pi.getFlag("--graft-map") !== false} push=${pi.getFlag("--graft-push") === true} blast=${pi.getFlag("--graft-blast") !== false}`);

			const arg = args.trim();
			if (arg.startsWith("build")) {
				const withDeep = arg.includes("deep");
				const deepCfg = withDeep ? deepConfigFromEnv() : undefined;
				if (withDeep && !deepCfg) {
					ctx.ui.notify(
						"graft build deep: нет конфига LLM. Задайте GRFT_LLM_BASE_URL и GRFT_LLM_MODEL (опц. GRFT_LLM_API_KEY) и повторите.",
						"error",
					);
					return;
				}
				ctx.ui.notify(
					`Запускаю: graft build${withDeep ? " deep" : ""}… (${withDeep ? `LLM ${deepCfg!.model}` : "$0, tree-sitter-wasm"})`,
					"info",
				);
				try {
					const t0 = Date.now();
					const rep = await build(root ?? ctx.cwd, {
						deep: deepCfg ?? undefined,
						onProgress: (m) => ctx.ui.notify(`graft build: ${m}`, "info"),
					});
					mapCache = null;
					ctx.ui.notify(
						`graft build готов за ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер` +
							(rep.deep ? `, deep: +${rep.deep.filesDone}+${rep.deep.symbolsDone}, кэш ${rep.deep.filesCached}+${rep.deep.symbolsCached}, ошибок ${rep.deep.symbolsFailed}` : ""),
						"info",
					);
				} catch (e) {
					ctx.ui.notify(`graft build: ${(e as Error).message}`, "error");
				}
				await refreshBadge(ctx, root);
				return;
			}

			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

}
