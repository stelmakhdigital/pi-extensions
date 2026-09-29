/**
 * Персистентность состояния guard-расширений (bash-guard / dir-guard).
 *
 * Один файл `<agentDir>/guard-state.json` (agent dir — из SDK, уважает
 * $PI_CODING_AGENT_DIR), ключ на каждое расширение:
 *   { "bash-guard": { "disabled": false, "rmAllowed": true }, "dir-guard": { ... } }
 *
 * Состояние переживает /reload (factory перечитывает файл) и продолжение
 * сессии (pi -c). Новая сессия (pi) стартует с дефолтом — сброс делают
 * guard-расширения в session_start. В субагентах файл сознательно НЕ
 * читается — свежее включённое состояние (fail-safe по умолчанию).
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

/**
 * Сбрасывать ли guard'ы к дефолтам на этом session_start?
 *
 * pi 0.99.0: на старте ПРОЦЕССА (и `pi`, и `pi -c`) reason всегда "startup";
 * "resume" — только переключение сессии внутри процесса (TUI /resume),
 * "reload" — /reload, "new"/"fork" — внутри процесса.
 * Продолжение процесса (pi -c / --session) узнаём по непустой истории:
 * ctx.sessionManager.buildSessionContext().messages.length > 0.
 *
 * Сброс (новая сессия): startup с пустой историей и "new".
 * Восстановление (продолжение): startup с историей, resume, reload, fork.
 */
export function shouldResetGuards(
	event: { reason?: string },
	ctx?: { sessionManager?: { buildSessionContext?: () => { messages?: unknown[] } } },
): boolean {
	if (event.reason === "resume" || event.reason === "reload" || event.reason === "fork") return false;
	if (event.reason === "startup") {
		try {
			const msgs = ctx?.sessionManager?.buildSessionContext?.().messages;
			if (Array.isArray(msgs) && msgs.length > 0) return false; // pi -c / --session
		} catch {
			/* нет истории — сбрасываем (безопасный дефолт) */
		}
	}
	return true;
}
