/** Хранилище: graft/.engine/{graph.json,deep.json}, graft/cards/, graft/index.md. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DeepStore, Graph } from "./types.js";

export const ENGINE_DIR = ".engine";
export const GRAPHS_MARKER = join(ENGINE_DIR, "graph.json");

export function engineDir(root: string): string {
	return join(root, "graft", ENGINE_DIR);
}

export function hasGraph(root: string): boolean {
	return existsSync(join(engineDir(root), "graph.json"));
}

export function readGraph(root: string): Graph {
	return JSON.parse(readFileSync(join(engineDir(root), "graph.json"), "utf8")) as Graph;
}

export function readDeep(root: string): DeepStore {
	const p = join(engineDir(root), "deep.json");
	if (!existsSync(p)) return { files: {}, symbols: {} };
	return JSON.parse(readFileSync(p, "utf8")) as DeepStore;
}

export function writeGraph(root: string, g: Graph): void {
	const dir = engineDir(root);
	mkdirSync(dir, { recursive: true });
	// Чистим старый формат (nanonets: graft/wiring.json, карточки по дереву).
	rmSync(join(root, "graft", "wiring.json"), { force: true });
	writeFileSync(join(dir, "graph.json"), JSON.stringify(g, null, 1));
}

export function writeDeep(root: string, d: DeepStore): void {
	mkdirSync(engineDir(root), { recursive: true });
	writeFileSync(join(engineDir(root), "deep.json"), JSON.stringify(d, null, 1));
}

/** Per-file markdown-карточки: graft/cards/<путь-зеркало>.md */
export function writeCards(root: string, g: Graph, deep: DeepStore): number {
	const cardsRoot = join(root, "graft", "cards");
	rmSync(cardsRoot, { recursive: true, force: true });
	mkdirSync(cardsRoot, { recursive: true });
	let count = 0;
	for (const fileNode of g.nodes.filter((n) => n.kind === "file")) {
		const syms = g.nodes.filter((n) => n.path === fileNode.path && n.kind !== "file");
		const lines: string[] = [];
		lines.push(`# graft card — ${fileNode.path}`);
		lines.push("");
		const fs = deep.files[fileNode.path];
		if (fs && fs.hash === fileNode.bodyHash) lines.push(`> ${fs.summary}`);
		for (const s of syms) {
			lines.push(`- L${s.span.start}-L${s.span.end} ${s.kind} \`${s.name}\` — ${s.signature ?? ""}`);
			const d = deep.symbols[s.id];
			if (d && d.hash === s.bodyHash) {
				lines.push(`  - ${d.summary}`);
				if (d.crux?.length) lines.push(`  - crux:`, ...d.crux.map((l) => `    \`${l}\``));
			}
		}
		const out = join(cardsRoot, fileNode.path + ".md");
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, lines.join("\n") + "\n");
		count++;
	}
	return count;
}

/** graft/index.md — верхнеуровневая карта. */
export function writeIndex(root: string, g: Graph, text: string): void {
	const p = join(root, "graft", "index.md");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		`# graft — repo map (pi-graft-engine v1)\n\nСобственный движок (engine/graft): пересборка — \`/graft build\` (в pi) или \`node engine/graft/bin/graft.mjs build\`.\n\n${text}\n`,
	);
}

/** Корень графа: ближайший каталог вверх с graft/.engine/graph.json. */
export function findGraphRoot(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		if (hasGraph(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export { sep, relative };
