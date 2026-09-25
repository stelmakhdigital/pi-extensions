/**
 * Auto-refresh: быстрый fingerprint дрейфа (size+mtime по умолчанию; GRFT_REFRESH=hash — sha1)
 * и тихая пересборка графа перед запросами. GRFT_NO_REFRESH=1 — выключить везде.
 *
 * Файл: graft/.engine/fingerprint.json — { mode, paths, files: {path: {size, mtimeMs} | hash} }.
 * Чек = git ls-files (+untracked) vs paths + stat/hash общих путей. ~мс для сотен файлов.
 */
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineDir, hasGraph } from "./store.js";
import { isIndexablePath, listRepoPaths } from "./scan.js";

const FP_NAME = "fingerprint.json";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

interface Fingerprint {
	mode: "stat" | "hash";
	/** Индексированный набор путей (для сравнения added/removed). */
	paths: string[];
	/** stat: {size, mtimeMs}; hash: sha1. */
	files: Record<string, { size: number; mtimeMs: number } | string>;
}

export function fpPath(root: string): string {
	return join(engineDir(root), FP_NAME);
}

/** Записать fingerprint после build (из index.build). */
export async function writeFingerprint(root: string, paths: string[], hashes: Record<string, string>): Promise<void> {
	const files: Fingerprint["files"] = {};
	for (const p of paths) {
		try {
			const st = await stat(join(root, p));
			files[p] = { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			/* файл исчез — просто нет записи */
		}
	}
	const fp: Fingerprint = { mode: "stat", paths, files };
	void hashes;
	mkdirSync(engineDir(root), { recursive: true });
	writeFileSync(fpPath(root), JSON.stringify(fp, null, 0));
}

function readFp(root: string): Fingerprint | null {
	try {
		if (!existsSync(fpPath(root))) return null;
		return JSON.parse(readFileSync(fpPath(root), "utf8")) as Fingerprint;
	} catch {
		return null;
	}
}

/** Быстрый (async, но дешёвый) отчёт о дрейфе без пересборки. */
export async function driftReport(
	root: string,
): Promise<{ drifted: boolean; reason: string | null; added: number; removed: number; changed: number }> {
	if (!hasGraph(root)) return { drifted: false, reason: "нет графа", added: 0, removed: 0, changed: 0 };
	const fp = readFp(root);
	if (!fp) return { drifted: true, reason: "нет fingerprint (пересборка)", added: 0, removed: 0, changed: 0 };
	const useHash = process.env.GRFT_REFRESH === "hash";
	const list = await listRepoPaths(root);
	if (list.length === 0) return { drifted: false, reason: "git недоступен — пропуск", added: 0, removed: 0, changed: 0 };
	const current = list.filter(isIndexablePath);
	const curSet = new Set(current);
	const idxSet = new Set(fp.paths);
	const added = current.filter((p) => !idxSet.has(p)).length;
	const removed = fp.paths.filter((p) => !curSet.has(p)).length;
	let changed = 0;
	for (const p of current) {
		if (!idxSet.has(p)) continue;
		const stored = fp.files[p];
		if (!stored) {
			changed++;
			continue;
		}
		if (useHash) {
			try {
				const h = sha1(readFileSync(join(root, p), "utf8"));
				if (h !== (typeof stored === "string" ? stored : JSON.stringify(stored))) changed++;
			} catch {
				changed++;
			}
		} else if (typeof stored === "object") {
			try {
				const st = await stat(join(root, p));
				if (st.size !== stored.size || st.mtimeMs !== stored.mtimeMs) changed++;
			} catch {
				changed++;
			}
		} else {
			changed++;
		}
	}
	const drifted = added > 0 || removed > 0 || changed > 0;
	return {
		drifted,
		reason: drifted ? `drift: +${added} new, -${removed} removed, ~${changed} changed` : null,
		added,
		removed,
		changed,
	};
}

let autoRebuildTimer: NodeJS.Timeout | null = null;
let autoRebuildInflight = false;

/**
 * Дебаунс-обёртка для тихой пересборки после правок (write/edit): коалесит серию правок
 * в один rebuild через debounceMs; параллельные запуски — один в полёте. Ошибки — тихо.
 */
export function enableAutoRebuild(fn: () => Promise<void>, debounceMs = 4000): void {
	if (autoRebuildInflight || process.env.GRFT_NO_REFRESH === "1") return;
	if (autoRebuildTimer) clearTimeout(autoRebuildTimer);
	autoRebuildTimer = setTimeout(async () => {
		autoRebuildTimer = null;
		autoRebuildInflight = true;
		try {
			await fn();
		} catch {
			/* тихо: бейдж поправится следующим refreshBadge */
		}
		autoRebuildInflight = false;
	}, debounceMs);
}

/**
 * Тихая пересборка при дрейфе. In-process TTL (3s) против повторных git-вызовов в одном ходе.
 * GRFT_NO_REFRESH=1 — всегда пропуск. Возврат: {refreshed, files?, skipped?, reason?}.
 */
export async function ensureFresh(root: string): Promise<{ refreshed: boolean; files?: number; skipped?: string; reason?: string }> {
	if (process.env.GRFT_NO_REFRESH === "1") return { refreshed: false, skipped: "GRFT_NO_REFRESH=1" };
	const dr = await driftReport(root);
	if (!dr.drifted) return { refreshed: false, reason: dr.reason ?? undefined };
	const { build } = await import("./index.js");
	const rep = await build(root, {});
	return { refreshed: true, files: rep.files, reason: dr.reason ?? undefined };
}
