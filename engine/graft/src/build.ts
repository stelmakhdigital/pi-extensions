/** Сборка графа: scan → extract → разрешение импортов → Graph. */
import { extractFile, resolveImport, resolvePyImport, type ExtractedFile } from "./extract.js";
import { scanRepo } from "./scan.js";
import type { Graph, GraphEdge } from "./types.js";

export async function buildGraph(root: string): Promise<Graph> {
	const files = await scanRepo(root);
	if (files.length === 0) {
		throw new Error("graft-engine: нет файлов для индексации (git ls-files пуст или git недоступен)");
	}
	const knownPaths = new Set(files.map((f) => f.path));
	const extracted: ExtractedFile[] = [];
	for (const f of files) extracted.push(await extractFile(f));

	const edges: GraphEdge[] = [];
	const fileById = new Map<string, Graph["nodes"][number]>(extracted.flatMap((e) => e.nodes).map((n) => [n.id, n]));

	// Файловые import-рёбра + символ-импорты (named → target symbol).
	for (const e of extracted) {
		for (const imp of e.imports) {
			const targetFile =
				e.file.lang === "py"
					? resolvePyImport(e.file.path, imp.specifier, knownPaths)
					: resolveImport(e.file.path, imp.specifier, knownPaths);
			if (!targetFile) continue; // внешний пакет
			edges.push({ source: e.file.path, target: targetFile, relation: "imports", confidence: "extracted" });
			// named-импорт → символ целевого файла (если экспортируется).
			const targets = e.exports; // локальные имена == имена символов своего файла
			void targets;
			const targetExports = new Map<string, unknown>();
			const targetExtracted = extracted.find((t) => t.file.path === targetFile);
			if (targetExtracted) for (const [name, node] of targetExtracted.exports) targetExports.set(name, node);
			for (const name of imp.names) {
				if (name === "*" || name === "default") continue;
				const sym = targetExports.get(name);
				if (sym) edges.push({ source: e.file.path, target: (sym as { id: string }).id, relation: "references", confidence: "extracted" });
			}
		}
	}
	for (const e of extracted) edges.push(...e.edges);

	const nodes = extracted.flatMap((e) => e.nodes);
	// Уникализация рёбер.
	const dedup = new Set<string>();
	const uniqueEdges = edges.filter((ed) => {
		const k = `${ed.source}->${ed.target}:${ed.relation}`;
		if (dedup.has(k)) return false;
		dedup.add(k);
		return true;
	});

	void fileById;
	return {
		version: 1,
		meta: { builtAt: new Date().toISOString(), root, files: files.map((f) => ({ path: f.path, hash: f.hash })) },
		nodes,
		edges: uniqueEdges,
	};
}
