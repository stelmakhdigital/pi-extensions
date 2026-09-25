/** Загрузка web-tree-sitter + wasm-грамматики (ts/tsx/js/py). */
import { Parser, Language, type Tree } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import type { Lang } from "./types.js";

let initPromise: Promise<void> | null = null;
const languages = new Map<Lang, Language>();

export function ensureParsers(): Promise<void> {
	if (!initPromise) {
		initPromise = (async () => {
			await Parser.init();
		})();
	}
	return initPromise;
}

export async function getLanguage(lang: Lang): Promise<Language> {
	let l = languages.get(lang);
	if (!l) {
		await ensureParsers();
		const grammar = lang === "ts" ? "typescript" : lang === "tsx" ? "tsx" : lang === "js" ? "javascript" : "python";
		l = await Language.load(getWasmPath(grammar));
		languages.set(lang, l);
	}
	return l;
}

const parsers = new Map<Lang, Parser>();

export async function parseSource(lang: Lang, source: string): Promise<Tree> {
	await ensureParsers();
	let p = parsers.get(lang);
	if (!p) {
		p = new Parser();
		p.setLanguage(await getLanguage(lang));
		parsers.set(lang, p);
	}
	const t = p.parse(source);
	if (!t) throw new Error("graft-engine: parse failed");
	return t;
}
