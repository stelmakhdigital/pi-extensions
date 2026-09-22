/**
 * Graft — интеграция кодового графа Graft (@nanonets/graft) в pi.
 *
 * Глубокая интеграция, аналог «deep integration» для Claude Code:
 *
 * - Нативные инструменты: graft_ask, graft_grep, graft_callers,
 *   graft_skeleton, graft_map, graft_check, graft_blast (обёртки над CLI,
 *   без шелла — аргументы передаются массивом).
 * - `<graft>`-секция системного промпта: вывод `graft map` (ориентация в
 *   репо, $0, детерминированный) обновляется при каждом промпте
 *   (событие before_agent_start).
 * - Push-режим (флаг --graft-push): при каждом промпте дополнительно
 *   прогоняется `graft ask "<промпт>"` и топ-хиты попадают в секцию.
 * - Blast radius: после успешных write/edit к результату тула дописывается
 *   блок «кто зависит от изменённых символов» (graft skeleton + callers).
 * - Бейдж свежести в футере: `graft: synced` / `graft: ⚠ N stale`
 *   (graft check --json), обновляется при старте сессии и после хуков.
 * - Команда /graft: статус + `graft build` / `graft build deep`.
 *
 * Расширение работает только в репозиториях, где построен граф
 * (каталог `graft/` где-то выше cwd); в остальных — тихий no-op.
 * CLI ищется в PATH (`graft`), иначе используется `npx -y @nanonets/graft`.
 * В дочерние процессы ставится DO_NOT_TRACK=1 (без телеметрии).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NPM_PKG = "@nanonets/graft";
const STATUS_KEY = " graft"; // ведущий пробел: бейдж сортируется раньше буквенных ключей

/** Результат запуска CLI */
interface GraftRun {
	code: number;
	out: string;
}

function runGraft(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<GraftRun> {
	const cmd = resolveGraftCommand();
	const argv = cmd === "graft" ? ["graft", ...args] : ["npx", "-y", NPM_PKG, ...args];
	return new Promise((res) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const child = spawn(argv[0], argv.slice(1), {
			cwd,
			env: { ...process.env, DO_NOT_TRACK: "1", NO_COLOR: "1" },
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d) => (stdout += String(d)));
		child.stderr.on("data", (d) => (stderr += String(d)));
		child.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			res({ code: -1, out: `ошибка запуска graft CLI: ${e.message}` });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			res({ code: code ?? -1, out: (stdout + (stderr ? `\n${stderr}` : "")).trim() });
		});
	});
}

let graftCmdCache: string | undefined;
function resolveGraftCommand(): string {
	if (graftCmdCache) return graftCmdCache;
	const envCmd = process.env.GRAFT_CMD?.trim();
	if (envCmd) {
		graftCmdCache = envCmd;
		return graftCmdCache;
	}
	graftCmdCache = "npx";
	try {
		const which = process.platform === "win32" ? "where" : "which";
		const r = spawnSync(which, ["graft"], { stdio: ["ignore", "pipe", "ignore"] });
		if (r.status === 0 && String(r.stdout).trim()) graftCmdCache = "graft";
	} catch {
		// оставляем npx
	}
	return graftCmdCache;
}

/** Ищет корень графа: ближайший каталог выше cwd, содержащий подкаталог `graft/`. */
const graphRootCache = new Map<string, string | null>();
function findGraphRoot(cwd: string): string | null {
	const cached = graphRootCache.get(cwd);
	if (cached !== undefined) return cached;
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, "graft");
		if (existsSync(candidate) && statSync(candidate).isDirectory()) {
			graphRootCache.set(cwd, dir);
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	graphRootCache.set(cwd, null);
	return null;
}

function cap(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + `\n…[обрезано до ${max} символов; для полного вывода запусти CLI вручную]`;
}

/** Разбор `graft skeleton <file>`: имена символов по строкам `- L1-L1  function auth  ...` */
function parseSkeletonSymbols(out: string, max: number): string[] {
	const names: string[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^-\s+L\d+(?:-L\d+)?\s+\w+\s+(\S+)/);
		if (m && m[1]) names.push(m[1]);
	}
	return names.slice(0, max);
}

/** Разбор `graft callers <sym>`: зависимые «имя (файл:строки)» */
function parseDependents(out: string, max: number): string[] {
	const seen = new Set<string>();
	const deps: string[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\s+(?:calls|imports|uses|extends|implements|depends_on)\s+←\s+(\S+)\s+\((.+?)\)\s*$/);
		if (m && !seen.has(m[1])) {
			seen.add(m[1]);
			deps.push(`${m[1]} (${m[2]})`);
		}
	}
	return deps.slice(0, max);
}

export default function (pi: ExtensionAPI) {
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
		description: "Лимит вывода graft-инструментов в символах",
		type: "number",
		default: 16000,
	});

	// Кэш карты репо (TTL), инвалидируется после правок файлов.
	let mapCache: { text: string; at: number } | null = null;
	const MAP_TTL_MS = 120_000;
	function invalidateMap() {
		mapCache = null;
	}

	function enabled(ctx: ExtensionContext): boolean {
		if (pi.getFlag("--graft") === false) return false;
		return findGraphRoot(ctx.cwd) !== null;
	}

	function maxOut(): number {
		const v = Number(pi.getFlag("--graft-max-output"));
		return Number.isFinite(v) && v > 0 ? v : 16000;
	}

	function refreshBadge(ctx: ExtensionContext, root: string | null) {
		if (!ctx.hasUI) return;
		if (!root) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		void (async () => {
			const r = await runGraft(["check", "--json"], root, 15_000);
			if (r.code !== 0) return;
			try {
				const j = JSON.parse(r.out);
				const stale = j?.graph?.stale?.length ?? 0;
				const missing = j?.graph?.missing === true || j?.context?.missing === true;
				if (missing) {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "graft: нет графа — graft build"));
				} else if (stale > 0) {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `graft: ⚠ ${stale} stale`));
				} else {
					ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "graft: synced"));
				}
			} catch {
				// не JSON — бейдж не трогаем
			}
		})();
	}

	// ---------- Инструкции для модели ----------

	const commonHint = (root: string | null, tool: string) =>
		root === null
			? "В этом каталоге нет графа Graft (каталог graft/ не найден выше cwd). Построй его: `graft build` (CLI @nanonets/graft), затем вызови инструмент снова."
			: `Граф Graft: ${root}. Использование: сначала ориентироваться — graft_map; точечные вопросы — graft_ask; исчерпывающий поиск — graft_grep; «кто использует» — graft_callers; API файла — graft_skeleton. ${tool}`;

	function toolResult(text: string, details: Record<string, unknown>) {
		return {
			content: [{ type: "text" as const, text }],
			details,
		};
	}

	pi.registerTool({
		name: "graft_ask",
		label: "graft_ask",
		description:
			"Ранжированный запрос к графу Graft: подходящие символы/ноды с точными file:line и кодом (детерминированный поиск, без LLM). Для понимания «как это работает / где это лежит». Для исчерпывающего «все вхождения» используй graft_grep.",
		promptSnippet: "Ranked lookup in the local Graft code graph (nodes with file:line, $0, deterministic).",
		parameters: Type.Object({
			query: Type.String({ description: "Вопрос или набор идентификаторов (символ, строка ошибки, имя файла)" }),
			source: Type.Optional(Type.Boolean({ description: "Включить кодовые пролёты (crux) в выдачу" })),
			full: Type.Optional(Type.Boolean({ description: "Полные определения вместо crux (если crux недостаточно)" })),
			scope: Type.Optional(Type.String({ description: "Ограничить подпроектом монорепо (метка [scope/] из результатов)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const args = ["ask", params.query];
			if (params.source) args.push("--source");
			if (params.full) args.push("--full");
			if (params.scope) args.push("--in", params.scope.endsWith("/") ? params.scope : `${params.scope}/`);
			const r = await runGraft(args, root ?? ctx.cwd, 60_000, signal);
			if (r.code !== 0 && !r.out) {
				return toolResult(`graft ask завершился с кодом ${r.code}. ${commonHint(root, "")}`, { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
			}
			return toolResult(cap(r.out, maxOut()), { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const args = ["grep", params.pattern];
			if (params.scope) args.push("--in", params.scope);
			if (params.ignoreCase) args.push("-i");
			if (params.fixed) args.push("--fixed");
			const r = await runGraft(args, root ?? ctx.cwd, 60_000, signal);
			return toolResult(cap(r.out || `graft grep: нет результата (код ${r.code})`, maxOut()), { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
		},
	});

	pi.registerTool({
		name: "graft_callers",
		label: "graft_callers",
		description:
			"Точные предвычисленные рёбра графа Graft: кто вызывает/импортирует/использует символ (direction: \"in\", по умолчанию) или на что сам ссылается символ (direction: \"out\"). depth — транзитивное обхождение (blast radius).",
		promptSnippet: "Exact dependency edges from the Graft graph (callers/callees, transitive depth).",
		parameters: Type.Object({
			symbol: Type.String({ description: "Имя символа (функция, класс, метод)" }),
			direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")], { description: "in (по умолчанию): кто зависит; out: на что зависит" })),
			depth: Type.Optional(Type.Number({ description: "Глубина транзитивного обхода (blast radius)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const args = ["callers", params.symbol];
			if (params.direction === "out") args.push("--direction", "out");
			if (params.depth !== undefined) args.push("-d", String(params.depth));
			const r = await runGraft(args, root ?? ctx.cwd, 60_000, signal);
			return toolResult(cap(r.out || `graft callers: нет результата (код ${r.code})`, maxOut()), { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const r = await runGraft(["skeleton", params.file], root ?? ctx.cwd, 60_000, signal);
			return toolResult(cap(r.out || `graft skeleton: нет результата (код ${r.code})`, maxOut()), { cmd: `graft skeleton ${params.file}`, exitCode: r.code });
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const args = ["map"];
			if (params.maxDirs !== undefined) args.push("--max-dirs", String(params.maxDirs));
			const r = await runGraft(args, root ?? ctx.cwd, 60_000, signal);
			invalidateMap();
			return toolResult(cap(r.out || `graft map: нет результата (код ${r.code})`, maxOut()), { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
		},
	});

	pi.registerTool({
		name: "graft_check",
		label: "graft_check",
		description:
			"Отчёт о свежести графа Graft: дрейф graft/ относительно кода (добавлено/удалено/изменено/stale), JSON. Не пересобирает граф — только сообщает.",
		promptSnippet: "Freshness/drift report of the local Graft graph (JSON).",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const r = await runGraft(["check", "--json"], root ?? ctx.cwd, 30_000, signal);
			refreshBadge(ctx, root);
			return toolResult(cap(r.out || `graft check: нет результата (код ${r.code})`, maxOut()), { cmd: "graft check --json", exitCode: r.code });
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
		async execute(_id, params, signal, _onUpdate, ctx) {
			const root = findGraphRoot(ctx.cwd);
			const args = ["blast"];
			if (params.base) args.push("--base", params.base);
			const r = await runGraft(args, root ?? ctx.cwd, 120_000, signal);
			return toolResult(cap(r.out || `graft blast: нет результата (код ${r.code})`, maxOut()), { cmd: `graft ${args.join(" ")}`, exitCode: r.code });
		},
	});

	// ---------- Хуки ----------

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled(ctx)) return;
		refreshBadge(ctx, findGraphRoot(ctx.cwd));
	});

	/** Секция <graft> в системном промпте: карта репо (+ топ-хиты ask при push-режиме). */
	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled(ctx)) return;
		const wantMap = pi.getFlag("--graft-map") !== false;
		const wantPush = pi.getFlag("--graft-push") === true;
		if (!wantMap && !wantPush) return;

		const root = findGraphRoot(ctx.cwd)!;
		const parts: string[] = [];

		if (wantMap) {
			if (!mapCache || Date.now() - mapCache.at > MAP_TTL_MS) {
				const r = await runGraft(["map"], root, 8_000, ctx.signal);
				if (r.code === 0 && r.out) {
					mapCache = { text: r.out, at: Date.now() };
				} else if (mapCache) {
					// граф недоступен — используем устаревший кэш, бейдж подсветит проблему
				} else {
					return;
				}
			}
			parts.push(mapCache.text);
		}

		if (wantPush) {
			const r = await runGraft(["ask", event.prompt], root, 8_000, ctx.signal);
			if (r.code === 0 && r.out) {
				parts.push(`## Top-хиты графа под текущий промпт\n${cap(r.out, 4000)}`);
			}
		}

		if (parts.length > 0) {
			event.systemPromptOptions.sections["graft"] =
				`Нижележащий локальный граф кодовой базы Graft (graft/) — используй его ПЕРЕД grep/чтениями файлов. ` +
				`Для уточнения есть инструменты graft_ask/graft_grep/graft_callers/graft_skeleton.\n\n` +
				parts.join("\n\n");
		}
	});

	/** Blast radius после успешных write/edit. */
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (!enabled(ctx)) return;
		if (pi.getFlag("--graft-blast") === false) return;

		const path = event.input?.path;
		if (typeof path !== "string" || path.length === 0) return;
		const root = findGraphRoot(ctx.cwd)!;

		invalidateMap();
		const blast = await withTimeout(
			(async () => {
				const sk = await runGraft(["skeleton", path], root, 4_000);
				if (sk.code !== 0) return "";
				const symbols = parseSkeletonSymbols(sk.out, 3);
				if (symbols.length === 0) return "";
				const all: string[] = [];
				for (const sym of symbols) {
					const c = await runGraft(["callers", sym], root, 3_000);
					if (c.code !== 0) continue;
					const deps = parseDependents(c.out, 5);
					if (deps.length > 0) all.push(`${sym}: ${deps.join(", ")}`);
				}
				return all.join("\n");
			})(),
			6_000,
		);
		if (!blast) return; // зависимых нет — тихо

		const note = `🌿 Graft blast radius по ${path}:\n${blast}`;
		if (ctx.hasUI) ctx.ui.notify(note, "info");
		refreshBadge(ctx, root);
		return {
			content: [...event.content, { type: "text" as const, text: note }],
		};
	});

	function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
		return new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error("timeout")), ms);
			p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
		}).catch(() => undefined as T);
	}

	// ---------- Команда /graft ----------

	pi.registerCommand("graft", {
		description: "Статус Graft: /graft — сводка; /graft build [, deep] — пересобрать граф",
		handler: async (args: string, ctx) => {
			const root = findGraphRoot(ctx.cwd);
			const cmd = resolveGraftCommand();
			const parts = [
				`Graft-CLI: ${cmd === "graft" ? "graft (PATH)" : `npx -y ${NPM_PKG}`}`,
				`Граф: ${root ?? "не найден (запусти graft build в корне репо)"}`,
			];
			if (root) {
				const r = await runGraft(["check", "--json"], root, 15_000);
				if (r.code === 0) {
					try {
						const j = JSON.parse(r.out);
						parts.push(
							`Свежесть: ${j?.graph?.missing ? "ГРАФ НЕ СОБРАН" : `ok, stale: ${j?.graph?.stale?.length ?? 0}, pending: ${j?.graph?.pending ?? 0}`}`,
						);
					} catch {
						parts.push(`Свежесть: ${cap(r.out, 500)}`);
					}
				} else {
					parts.push(`Свежесть: ошибка (${r.code}): ${cap(r.out, 300)}`);
				}
			}
			parts.push(`Флаги: map=${pi.getFlag("--graft-map") !== false} push=${pi.getFlag("--graft-push") === true} blast=${pi.getFlag("--graft-blast") !== false}`);

			const arg = args.trim();
			if (arg.startsWith("build")) {
				const deep = arg.includes("deep");
				const bargs = deep ? ["build", "--deep"] : ["build"];
				ctx.ui.notify(`Запускаю: graft ${bargs.join(" ")}… (${deep ? "LLM-суммаризация, нужен ключ GRAFT_API_KEY" : "$0, tree-sitter"})`, "info");
				const r = await runGraft(bargs, root ?? ctx.cwd, 30 * 60_000);
				ctx.ui.notify(r.code === 0 ? `graft build завершён` : `graft build: код ${r.code}`, r.code === 0 ? "info" : "error");
				ctx.ui.notify(cap(r.out, 2000), r.code === 0 ? "info" : "warning");
				refreshBadge(ctx, root);
				return;
			}

			ctx.ui.notify(parts.join("\n"), "info");
		},
	});
}
