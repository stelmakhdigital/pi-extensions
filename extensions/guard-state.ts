/**
 * Персистентность состояния guard-расширений (bash-guard / dir-guard).
 *
 * Один файл `<agentDir>/guard-state.json` (agent dir — из SDK, уважает
 * $PI_CODING_AGENT_DIR), ключ на каждое расширение:
 *   { "bash-guard": { "disabled": false, "rmAllowed": true }, "dir-guard": { ... } }
 *
 * Состояние переживает /reload (factory перезапускается и перечитывает файл)
 * и перезапуск сессии. В субагентах файл сознательно НЕ читается — свежее
 * включённое состояние (fail-safe по умолчанию).
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type GuardState = Record<string, Record<string, unknown>>;

function stateFile(): string {
	return path.join(getAgentDir(), "guard-state.json");
}

function readAll(): GuardState {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		return (parsed && typeof parsed === "object" ? parsed : {}) as GuardState;
	} catch {
		return {};
	}
}

/** Состояние одного расширения ({} при отсутствии файла/ключа). */
export function loadGuard(key: string): Record<string, unknown> {
	return readAll()[key] ?? {};
}

/** Записать patch состояния расширения (read-modify-write, другие ключи не трогаем). */
export function saveGuard(key: string, patch: Record<string, unknown>): void {
	const all = readAll();
	all[key] = { ...(all[key] ?? {}), ...patch };
	fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
	fs.writeFileSync(stateFile(), JSON.stringify(all, null, 2));
}
