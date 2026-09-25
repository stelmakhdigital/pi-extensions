/**
 * pi-graft-engine — собственный движок кодового графа (замена @nanonets/graft).
 *
 * Публичный API:
 *   findGraphRoot(cwd) — ближайший корень с graft/.engine/graph.json
 *   build(root, opts)  — сборка графа (опционально deep: {deep: DeepConfig})
 *   makeQueries(root)  — skeleton/callers/map/ask/grep/check/blast/blastFile
 *
 * Движок — чистый TS без pi-API; расширение extensions/graft — тонкий адаптер.
 */
import { buildGraph } from "./build.js";
import { deepBuild } from "./deep.js";
import { hasGraph, readDeep, writeCards, writeGraph, writeIndex } from "./store.js";
import { makeQueries } from "./query.js";
import type { DeepConfig, Graph } from "./types.js";

export { findGraphRoot, hasGraph } from "./store.js";
export { makeQueries } from "./query.js";
export type { Queries } from "./query.js";
export type { DeepConfig, Graph, GraphNode, DeepStore } from "./types.js";
export { scanRepo } from "./scan.js";

export interface BuildOptions {
	deep?: DeepConfig;
	onProgress?: (msg: string) => void;
}

export interface BuildReport {
	files: number;
	nodes: number;
	edges: number;
	cards: number;
	deep?: { filesDone: number; filesCached: number; symbolsDone: number; symbolsCached: number; symbolsFailed: number };
}

/** Пересобрать граф: структурный слой (+ deep при opts.deep). */
export async function build(root: string, opts: BuildOptions = {}): Promise<BuildReport> {
	const g: Graph = await buildGraph(root);
	writeGraph(root, g);

	let deepReport: BuildReport["deep"];
	if (opts.deep) {
		const rep = await deepBuild(root, g, opts.deep, opts.onProgress);
		deepReport = rep;
		// deep.json уже записан внутри deepBuild; пересобираем карточки/index с суммари.
	}
	const deep = readDeep(root);
	const cards = writeCards(root, g, deep);
	const queries = makeQueries(root);
	const mapText = queries.map();
	writeIndex(root, g, mapText);
	return { files: g.meta.files.length, nodes: g.nodes.length, edges: g.edges.length, cards, deep: deepReport };
}

/** Быстрый статус для бейджа: {ok, stale, added, counts}. */
export async function checkStatus(root: string): Promise<{ ok: boolean; stale: number; added: number; text: string }> {
	if (!hasGraph(root)) return { ok: false, stale: 0, added: 0, text: "нет графа" };
	const q = makeQueries(root);
	const { text, json } = await q.check();
	const j = json as { ok: boolean; added: string[]; stale: string[] };
	return { ok: j.ok, stale: j.stale.length, added: j.added.length, text };
}

/** Blast radius для write/edit-хука (синхронно, дешёво; пусто — нет зависимых). */
export function blastFileText(root: string, path: string): string {
	if (!hasGraph(root)) return "";
	try {
		return makeQueries(root).blastFile(path);
	} catch {
		return "";
	}
}

