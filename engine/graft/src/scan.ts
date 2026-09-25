/** Обход репо: git ls-files (+ untracked), фильтрация, языки. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang, RepoFile } from "./types.js";

const LANG_BY_EXT: Record<string, Lang> = {
	".ts": "ts",
	".tsx": "tsx",
	".mts": "ts",
	".cts": "ts",
	".js": "js",
	".jsx": "js",
	".mjs": "js",
	".cjs": "js",
	".py": "py",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".sh": "sh",
	".bash": "sh",
	".java": "java",
	".cs": "csharp",
	".kt": "kotlin",
	".kts": "kotlin",
};

const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|out|\.memory|__pycache__|artifacts)(\/|$)/;

function sha1(s: string): string {
	return createHash("sha1").update(s).digest("hex");
}

function gitLines(root: string, args: string[]): Promise<string[]> {
	return new Promise<string[]>((res) => {
		execFile("git", ["-C", root, "ls-files", ...args], { maxBuffer: 16 * 1024 * 1024 }, (err: Error | null, stdout: string) => {
			res(err ? [] : stdout.split("\n").map((l) => l.trim()).filter(Boolean));
		});
	});
}

export function langOf(path: string): Lang | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return null;
	return LANG_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

/** Список путей исходников (tracked + untracked, не ignored). */
export async function listRepoPaths(root: string): Promise<string[]> {
	const tracked = await gitLines(root, []);
	const untracked = await gitLines(root, ["--others", "--exclude-standard"]);
	return [...new Set([...tracked, ...untracked])];
}

/**
 * Файлы для индексации. `git ls-files` (tracked) + `--others --exclude-standard` (untracked,
 * не ignored). git недоступен — пустой список (build отвалится с понятной ошибкой).
 */
export async function scanRepo(root: string): Promise<RepoFile[]> {
	const paths = await listRepoPaths(root);
	const seen = new Set<string>();
	const tracked: string[] = paths;
	void tracked;
	const out: RepoFile[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		const lang = langOf(path);
		if (!lang) continue;
		if (SKIP_RE.test(path)) continue;
		if (path === "graft" || path.startsWith("graft/")) continue; // кэш графа (только в корне)
		if (path.endsWith(".min.js") || path.includes("node_modules/")) continue;
		let content: string;
		try {
			content = readFileSync(join(root, path), "utf8");
		} catch {
			continue; // файл исчез/нечитаемый
		}
		if (content.length > 400_000) continue; // аномально большой — не индексим
		out.push({ path, lang, content, hash: sha1(content) });
	}
	return out;
}
