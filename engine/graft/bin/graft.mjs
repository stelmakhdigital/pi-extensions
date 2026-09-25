#!/usr/bin/env node
/**
 * graft (pi-graft-engine) — CLI для рук.
 *
 *   node engine/graft/bin/graft.mjs build [--deep] [dir]
 *   node engine/graft/bin/graft.mjs map [dir]
 *   node engine/graft/bin/graft.mjs ask <query> [dir]
 *   node engine/graft/bin/graft.mjs grep <pattern> [--scope <p>] [--fixed] [-i] [dir]
 *   node engine/graft/bin/graft.mjs callers <symbol> [--direction in|out] [-d N] [dir]
 *   node engine/graft/bin/graft.mjs skeleton <file> [dir]
 *   node engine/graft/bin/graft.mjs check [--json] [dir]
 *   node engine/graft/bin/graft.mjs blast [base]
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
	const baseUrl = process.env.GRFT_LLM_BASE_URL;
	const model = process.env.GRFT_LLM_MODEL;
	if (!baseUrl || !model) {
		console.error("deep: нет конфига. Задайте GRFT_LLM_BASE_URL и GRFT_LLM_MODEL (опц. GRFT_LLM_API_KEY).");
		process.exit(2);
	}
	return { baseUrl, model, apiKey: process.env.GRFT_LLM_API_KEY };
}

const dirArg = (a) => (a && !a.startsWith("-") && ["ask", "grep", "callers", "skeleton"].includes(cmd) ? a : undefined);

const root = resolve(process.cwd(), optVal("--dir") ?? ".");

switch (cmd) {
	case "build": {
		const withDeep = optFlag("--deep") || optFlag("--deep-llm") || rest.includes("deep");
		console.log(`graft build: ${root}${withDeep ? " (+deep LLM)" : ""}`);
		const t0 = Date.now();
		const rep = await engine.build(root, {
			deep: withDeep ? deepConfig() : undefined,
			onProgress: (m) => console.log("  …", m),
		});
		console.log(
			`готово за ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер, ${rep.cards} карточек` +
				(rep.deep ? `, deep: ${rep.deep.filesDone}+${rep.deep.symbolsDone} новых, ${rep.deep.filesCached}+${rep.deep.symbolsCached} из кэша, ошибок ${rep.deep.symbolsFailed}` : ""),
		);
		break;
	}
	case "map": {
		const q = engine.makeQueries(root);
		console.log(q.map({ maxDirs: Number(optVal("--max-dirs")) || undefined }));
		break;
	}
	case "ask": {
		const query = rest.find((a) => !a.startsWith("-"));
		if (!query) throw new Error("usage: graft ask <query>");
		const q = engine.makeQueries(root);
		console.log(q.ask(query));
		break;
	}
	case "grep": {
		const pattern = rest.find((a) => !a.startsWith("-"));
		if (!pattern) throw new Error("usage: graft grep <pattern>");
		const q = engine.makeQueries(root);
		console.log(q.grep(pattern, { scope: optVal("--scope"), fixed: optFlag("--fixed"), ignoreCase: optFlag("-i") }));
		break;
	}
	case "callers": {
		const symbol = rest.find((a) => !a.startsWith("-"));
		if (!symbol) throw new Error("usage: graft callers <symbol>");
		const q = engine.makeQueries(root);
		const d = optVal("-d") ?? optVal("--depth");
		console.log(q.callers(symbol, { direction: optVal("--direction") ?? "in", depth: d ? Number(d) : undefined }));
		break;
	}
	case "skeleton": {
		const file = rest.find((a) => !a.startsWith("-"));
		if (!file) throw new Error("usage: graft skeleton <file>");
		console.log(engine.makeQueries(root).skeleton(file));
		break;
	}
	case "check": {
		const status = await engine.checkStatus(root);
		if (optFlag("--json")) {
			const q = engine.makeQueries(root);
			console.log(JSON.stringify((await q.check()).json, null, 1));
		} else {
			console.log(status.text);
		}
		break;
	}
	case "blast": {
		const base = rest.find((a) => !a.startsWith("-"));
		console.log(await engine.makeQueries(root).blast(base));
		break;
	}
	default:
		console.log("pi-graft-engine CLI — см. шапку файла engine/graft/bin/graft.mjs");
		process.exit(cmd ? 1 : 0);
}
