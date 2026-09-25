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
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".dart": "dart",
	".scala": "scala",
	".lua": "lua",
	".r": "r",
	".R": "r",
	".ex": "elixir",
	".exs": "elixir",
	".sol": "solidity",
	".ml": "ocaml",
	".mli": "ocaml",
	".zig": "zig",
	".clj": "clojure",
	".cljs": "clojure",
	".cljc": "clojure",
	".nix": "nix",
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

/** Путь индексации (единый фильтр scanRepo и refresh-fingerprint). */
export function isIndexablePath(path: string): boolean {
	if (!langOf(path)) return false;
	if (SKIP_RE.test(path)) return false;
	if (path === "graft" || path.startsWith("graft/")) return false; // кэш графа (только в корне)
	if (path.endsWith(".min.js") || path.includes("node_modules/")) return false;
	return true;
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
		if (!isIndexablePath(path)) continue;
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

/**
 * Monorepo-scope: сабпроекты по маркерам (package.json/pyproject.toml/Cargo.toml/go.mod/
 * pom.xml/build.gradle в каталоге ≠ корню). Возврат: scope → пути (файлы вне сабпроектов
 * — scope "(root)"). Пустой объект — скоупов нет (только корневой маркер).
 */
const SCOPE_MARKERS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"]);

export function detectScopes(paths: string[]): Record<string, string[]> {
	const markerDirs = new Set<string>();
	for (const p of paths) {
		const base = p.split("/").pop();
		if (!base || !SCOPE_MARKERS.has(base)) continue;
		markerDirs.add(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
	}
	if ([...markerDirs].every((d) => d === "")) return {}; // только корневой маркер — скоупов нет
	const out: Record<string, string[]> = {};
	for (const p of paths) {
		const parts = p.split("/");
		let scope = "(root)";
		for (let i = parts.length - 1; i > 0; i--) {
			const dir = parts.slice(0, i).join("/");
			if (markerDirs.has(dir)) {
				scope = dir;
				break;
			}
		}
		(out[scope] ??= []).push(p);
	}
	return out;
}
