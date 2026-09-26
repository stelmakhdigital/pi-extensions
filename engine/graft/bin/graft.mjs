#!/usr/bin/env node
/**
 * graft (pi-graft-engine) — CLI для рук.
 *
 *   node engine/graft/bin/graft.mjs build [--deep] [--follow-submodules | --no-follow-submodules] [--dir <dir>]
 *   node engine/graft/bin/graft.mjs map [--dir <dir>]
 *   node engine/graft/bin/graft.mjs ask <query> [--dir <dir>]
 *   node engine/graft/bin/graft.mjs grep <pattern> [--scope <p>] [--fixed] [-i] [--dir <dir>]
 *   node engine/graft/bin/graft.mjs callers <symbol> [--direction in|out] [-d N] [--dir <dir>]
 *   node engine/graft/bin/graft.mjs skeleton <file> [--dir <dir>]
 *   node engine/graft/bin/graft.mjs check [--json] [--dir <dir>]   # exit 1 при дрейфе (CI)
 *   node engine/graft/bin/graft.mjs blast [base] [--dir <dir>]
 *   node engine/graft/bin/graft.mjs concepts [--dir <dir>]     # темы (LLM, fallback по каталогам)
 *   node engine/graft/bin/graft.mjs watch [--dir <dir>]       # авто-пересборка при изменениях
 *   node engine/graft/bin/graft.mjs viz [--dir <dir>]         # graft/viz.html
 *
 * Auto-refresh: ask/grep/callers/skeleton/map/blast тихо пересобирают граф при дрейфе
 * (fingerprint: size+mtime; GRFT_REFRESH=hash — sha1; GRFT_NO_REFRESH=1 — выкл).
 * check НЕ пересобирает — только отчёт (и exit 1 при дрейфе).
 *
 * Deep-конфиг (явный): GRFT_LLM_BASE_URL, GRFT_LLM_MODEL, GRFT_LLM_API_KEY.
 */
import { createJiti } from "jiti";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jiti = createJiti(fileURLToPath(import.meta.url));
const engine = jiti("../src/index.ts");

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

function optFlag(name) {
	const i = rest.indexOf(name);
	return i >= 0;
}
function optVal(name) {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
}

function deepConfig() {
	const soft = deepConfigSoft();
	if (!soft.baseUrl || !soft.model) {
		console.error("deep: нет конфига. Задайте GRFT_LLM_BASE_URL и GRFT_LLM_MODEL (опц. GRFT_LLM_API_KEY).");
		process.exit(2);
	}
	return soft;
}
function deepConfigSoft() {
	return { baseUrl: process.env.GRFT_LLM_BASE_URL, model: process.env.GRFT_LLM_MODEL, apiKey: process.env.GRFT_LLM_API_KEY };
}

const dirArg = (a) => (a && !a.startsWith("-") && ["ask", "grep", "callers", "skeleton"].includes(cmd) ? a : undefined);

function renderBlastMarkdown(data, base) {
	const lines = [`## Blast radius${base ? ` — \`${base}\`` : " — working tree"}`];
	for (const f of data.files) {
		lines.push(``, `### ${f.path}${f.owner ? ` _(owner: ${f.owner})_` : ""}`);
		for (const sym of f.symbols) {
			lines.push(`- \`${sym.name}\` (L${sym.start})${sym.dependents.length ? ` ← ${sym.dependents.join(", ")}` : ""}`);
		}
	}
	return lines.join("\n");
}
async function nameBlastAreas(data) {
	const cfg = deepConfigSoft();
	if (!cfg.baseUrl || !cfg.model) {
		console.error("blast --name: нет LLM-конфига (GRFT_LLM_BASE_URL/MODEL)");
		return;
	}
	const list = data.files.map((f) => `- ${f.path}: ${f.symbols.map((x) => x.name).join(", ")}`).join("\n");
	const raw = await engine.llmChat(cfg, "Ты — ревьюер. Верни ТОЛЬКО JSON-массив коротких имён зон (по одному на строку списка, в том же порядке).", `Имёнуй зоны изменения (по файлам) одной-двумя словами. Список:\n${list}\nВерни JSON-массив.`);
	let names = [];
	try {
		names = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
	} catch {
		console.error("blast --name: не удалось разобрать ответ LLM");
		return;
	}
	if (Array.isArray(names)) for (const f of data.files) f.area = names[data.files.indexOf(f)];
	console.log("зоны (LLM):", data.files.map((f) => `${f.path} → ${f.area ?? "—"}`).join("; "));
}
const root = resolve(process.cwd(), optVal("--dir") ?? ".");

switch (cmd) {
	case "build": {
		const withDeep = optFlag("--deep") || optFlag("--deep-llm") || rest.includes("deep");
		// Сабмодули: явный флаг персистится в graft/.engine/config.json (авто-рефреш
		// и MCP будут вести себя так же); без флага — сохранённое (дефолт: выкл).
		const follow = optFlag("--follow-submodules") ? true : optFlag("--no-follow-submodules") ? false : undefined;
		console.log(`graft build: ${root}${withDeep ? " (+deep LLM)" : ""}${follow ? " (+сабмодули)" : ""}`);
		const t0 = Date.now();
		const rep = await engine.build(root, {
			deep: withDeep ? deepConfig() : undefined,
			followSubmodules: follow,
			onProgress: (m) => console.log("  …", m),
		});
		console.log(
			`готово за ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер, ${rep.cards} карточек` +
				(rep.deep ? `, deep: ${rep.deep.filesDone}+${rep.deep.symbolsDone} новых, ${rep.deep.filesCached}+${rep.deep.symbolsCached} из кэша, ошибок ${rep.deep.symbolsFailed}` : ""),
		);
		break;
	}
	case "map": {
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		console.log(q.map({ maxDirs: Number(optVal("--max-dirs")) || undefined }));
		break;
	}
	case "ask": {
		const query = rest.find((a) => !a.startsWith("-"));
		if (!query) throw new Error("usage: graft ask <query> [--source] [--in <scope>] [-n N] [--json]");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const scope = optVal("--in") ?? optVal("--scope");
		const n = Number(optVal("-n")) || undefined;
		if (optFlag("--json")) console.log(JSON.stringify(q.askJson(query, { scope, limit: n }), null, 2));
		else console.log(q.ask(query, { source: optFlag("--source"), scope, limit: n }));
		break;
	}
	case "grep": {
		const pattern = rest.find((a) => !a.startsWith("-"));
		if (!pattern) throw new Error("usage: graft grep <pattern>");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		console.log(q.grep(pattern, { scope: optVal("--in") ?? optVal("--scope"), fixed: optFlag("--fixed"), ignoreCase: optFlag("-i") }));
		break;
	}
	case "callers": {
		const symbol = rest.find((a) => !a.startsWith("-"));
		if (!symbol) throw new Error("usage: graft callers <symbol>");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const d = optVal("-d") ?? optVal("--depth");
		const scope = optVal("--in") ?? optVal("--scope");
		console.log(q.callers(symbol, { direction: optVal("--direction") ?? "in", depth: d === "all" ? "all" : d ? Number(d) : undefined, scope }));
		break;
	}
	case "skeleton": {
		const file = rest.find((a) => !a.startsWith("-"));
		if (!file) throw new Error("usage: graft skeleton <file>");
		await engine.ensureFresh(root);
		console.log(engine.makeQueries(root).skeleton(file));
		break;
	}
	case "stats": {
		// Метрики сессий (без графа и сети): сколько ходов шло через граф,
		// а сколько модель читала source напрямую (тул read).
		const { readdirSync, readFileSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const dir = process.env.GRFT_STATE_DIR?.trim() || resolve(homedir(), ".local", "state", "pi-graft", "metrics");
		let files = [];
		try {
			files = readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.flatMap((f) => {
					try {
						return [{ sid: f.slice(0, -5), ...JSON.parse(readFileSync(resolve(dir, f), "utf8")) }];
					} catch {
						return [];
					}
				});
		} catch { /* каталог ещё не создан */ }
		if (!files.length) {
			console.log("graft stats: метрик нет (появятся после первых graft-вызовов/source-reads; dir: " + dir + ")");
			break;
		}
		files.sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0));
		const m = files[0];
		const calls = m.calls ?? 0;
		const sr = m.sourceReads ?? 0;
		const share = calls + sr > 0 ? Math.round((calls / (calls + sr)) * 100) : 0;
		if (optFlag("--json")) {
			console.log(
				JSON.stringify(
					{
						session: m.sid,
						ts: m.ts,
						graftCalls: calls,
						tokensSaved: m.tokens ?? 0,
						sourceReads: sr,
						sourceTokensRead: m.sourceTokens ?? 0,
						graphSharePct: share,
						graftTurns: m.graftTurns ?? 0,
						reportedTurns: m.reportedTurns ?? 0,
					},
					null,
					1,
				),
			);
			break;
		}
		const tok = (n) => "≈" + Math.round(n).toLocaleString("ru-RU");
		console.log(`graft stats (сессия ${m.sid}, активность ${new Date(m.ts ?? 0).toISOString().slice(0, 16).replace("T", " ")}):`);
		console.log(`  graft-вызовы: ${calls} · сэкономлено ${tok(m.tokens ?? 0)} tok`);
		console.log(`  прямые source-reads: ${sr} (прочитано ${tok(m.sourceTokens ?? 0)} tok)`);
		console.log(`  usage mix: ${share}% граф / ${100 - share}% прямой source-read`);
		if (m.graftTurns) console.log(`  🌱-отчёт: ${m.reportedTurns ?? 0}/${m.graftTurns} graft-ходов`);
		break;
	}
	case "check": {
		const status = await engine.checkStatus(root);
		if (optFlag("--json")) {
			const q = engine.makeQueries(root);
			const { json } = await q.check();
			console.log(JSON.stringify(json, null, 1));
			process.exitCode = json.ok ? 0 : 1;
		} else {
			console.log(status.text);
			process.exitCode = status.ok ? 0 : 1;
		}
		break;
	}
	case "blast": {
		const base = rest.find((a) => !a.startsWith("-") && a !== optVal("--format"));
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const format = optVal("--format") ?? "text";
		const owners = !optFlag("--no-owners");
		const data = await q.blastData(base, { owners });
		if (format === "json") {
			console.log(JSON.stringify(data, null, 2));
		} else if (format === "markdown") {
			console.log(renderBlastMarkdown(data, base));
			if (optFlag("--name")) await nameBlastAreas(data);
		} else {
			console.log(await q.blast(base));
		}
		if (optVal("--export-viz")) {
			const out = engine.writeBlastViz(root, data, optVal("--export-viz"));
			console.log(`graft blast: viz → ${out}`);
		}
		break;
	}
	case "concepts": {
		const cfg = deepConfigSoft();
		if (!cfg.baseUrl && !cfg.model) console.log("подсказка: без GRFT_LLM_BASE_URL/MODEL темы соберутся fallback'ом по каталогам");
		const g = engine.readGraph(root);
		const topics = await engine.conceptsBuild(root, g, cfg, (m) => console.log("  …", m));
		for (const t of topics) console.log(`${t.name}: ${t.summary}\n  [${t.files.slice(0, 10).join(", ")}${t.files.length > 10 ? ", …" : ""}]`);
		break;
	}
	case "watch": {
		const { watch } = await import("node:fs");
		let timer = null;
		const w = watch(root, { recursive: true });
		w.on("change", (_ev, p) => {
			if (!p || p.startsWith("graft/") || p.includes("node_modules/")) return;
			clearTimeout(timer);
			timer = setTimeout(async () => {
				try {
					const rep = await engine.build(root);
					const deepPart = rep.deep ? `, auto-deep: +${rep.deep.filesDone} файлов/+${rep.deep.symbolsDone} символов (кэш ${rep.deep.filesCached}/${rep.deep.symbolsCached})` : "";
					console.log(`[${new Date().toLocaleTimeString()}] rebuild: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер${deepPart}`);
				} catch (e) {
					console.log("rebuild failed:", e.message);
				}
			}, 1500);
		});
		console.log(`graft watch: слежу за ${root} (дебаунс 1.5s; auto-deep при дрейфе — если задан GRFT_LLM_BASE_URL/MODEL). Ctrl+C — стоп.`);
		await new Promise(() => {});
		break;
	}
	case "prose": {
		await engine.ensureFresh(root);
		const deep = engine.readDeep(root);
		const items = Object.values(deep.prose ?? {});
		if (!items.length) { console.log("Проза-нод нет (создаются `graft build --deep`: LLM-нарратив по топ-темам концептов)."); break; }
		console.log(`graft prose: ${items.length} нод(ы)`);
		for (const n of items.sort((x, y) => y.at - x.at)) console.log(`  ${n.file} — ${n.topic} (${new Date(n.at).toISOString().slice(0, 10)})`);
		break;
	}
	case "viz": {
		const serveArg = optVal("--serve");
		if (serveArg !== undefined) {
			const port = serveArg === "" || serveArg === "true" ? 8123 : parseInt(serveArg, 10);
			if (!Number.isFinite(port) || port < 1) throw new Error("usage: graft viz --serve [порт] (по умолчанию 8123)");
			const url = engine.serveViz(root, port);
			console.log(`graft viz: ${url} (live-reload каждые 5с; Ctrl+C — стоп)`);
		} else {
			const out = engine.writeViz(root, engine.readGraph(root));
			console.log(`graft viz: ${out}`);
		}
		break;
	}
	case "lsp-status": {
		const st = engine.lspStatus(root);
		if (st.length === 0) console.log("LSP-кандидатов нет (unresolved пусто)");
		for (const row of st) console.log(`graft lsp ${row.lang}: ${row.available ? "сервер есть" : "НЕТ сервера (" + row.bin + ")"} · ${row.candidates} к. · ${row.available ? "" : "установка: " + row.install}`);
		break;
	}
	case "lsp-sync": {
		await engine.ensureFresh(root);
		const rep = await engine.lspSync(root);
		if (rep.candidates === 0) console.log("graft lsp-sync: кандидатов нет (unresolved.json пуст)");
		for (const l of rep.langs) {
			if (l.available && l.ok) console.log(`graft lsp ${l.lang} (${l.bin}): +${l.edges} рёбер (lsp)`);
			else if (l.available) console.log(`graft lsp ${l.lang} (${l.bin}): ошибка — ${l.error}`);
			else console.log(`graft lsp ${l.lang}: сервер ${l.bin} не найден (${l.candidates} к.) — установка: ${l.install}`);
		}
		console.log(`graft lsp-sync: всего +${rep.totalEdges} рёбер`);
		break;
	}
	case "init": {
		const rep = engine.initWiring(root, { dryRun: optFlag("--dry-run"), mcp: !optFlag("--no-mcp") });
		for (const f of rep.files) console.log(`graft init [${f.action}] ${f.path}`);
		if (optFlag("--dry-run")) console.log("graft init: dry-run — ничего не записано");
		break;
	}
	case "uninstall": {
		const rep = engine.uninstallWiring(root, { dryRun: !optFlag("-y") && !optFlag("--yes") });
		for (const f of rep.files) console.log(`graft uninstall [${f.action}] ${f.path}`);
		break;
	}
	default:
		console.log("pi-graft-engine CLI — см. шапку файла engine/graft/bin/graft.mjs");
		process.exit(cmd ? 1 : 0);
}
