/**
 * Child session file management: deterministic paths (the parent creates the
 * file before launch, so parallel spawns never race) and seeding for the
 * standalone / lineage / fork session modes.
 *
 * Session layout (verified against pi 0.87.0):
 *   ~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
 * Header v3: {"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionMode } from "./types.ts";

/** Encode a cwd into the pi session dir name: strip leading '/', replace / \ : with '-'. */
export function sessionDirNameFor(cwd: string): string {
	const stripped = cwd.replace(/^[/\\]+/, "");
	const encoded = stripped.replace(/[/\\:]/g, "-");
	return `--${encoded}--`;
}

export function sessionFileTimestamp(date = new Date()): string {
	// pi file names look like 2026-09-24T07-29-30-010Z
	const iso = date.toISOString();
	const [datePart, timePart] = iso.split("T");
	const ms = timePart.match(/\.(\d{3})/)?.[1] ?? "000";
	const hhmmss = timePart.slice(0, 8).replace(/:/g, "-");
	return `${datePart}T${hhmmss}-${ms}Z`;
}

export interface SeededChildSession {
	/** Exact session file path. */
	file: string;
	id: string;
	cwd: string;
}

export interface SeedOptions {
	mode: SessionMode;
	/** Working directory recorded in the session header. */
	cwd: string;
	/** Session storage root (~/.pi/agent/sessions). */
	sessionsRoot: string;
	/** Parent session file (lineage/fork). */
	parentSessionFile?: string;
	/** Parent session entries for fork mode (excluding the old header). */
	parentBranchEntries?: Array<Record<string, unknown>>;
	sessionId?: string;
	now?: Date;
	/** Path writer (testing). */
	writeFile?: (file: string, data: string) => void;
}

export function childSessionFile(opts: {
	sessionsRoot: string;
	cwd: string;
	sessionId?: string;
	now?: Date;
}): SeededChildSession {
	const id = opts.sessionId ?? randomUUID();
	const file = join(
		opts.sessionsRoot,
		sessionDirNameFor(opts.cwd),
		`${sessionFileTimestamp(opts.now)}_${id}.jsonl`,
	);
	return { file, id, cwd: opts.cwd };
}

function headerEntry(id: string, cwd: string, now: Date, parentSession?: string): string {
	const header: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		timestamp: now.toISOString(),
		cwd,
	};
	if (parentSession) header.parentSession = parentSession;
	return JSON.stringify(header);
}

/**
 * SessionManager.getSessionDir() returns the per-cwd subdirectory
 * (<root>/--<cwd>--), not the sessions root itself. Child session files live
 * under the same root, encoded from the CHILD cwd — so take the root once.
 */
export function sessionsRootFor(sessionDir: string): string {
	return dirname(sessionDir);
}

/**
 * Create the child session file for the given mode and return its path.
 * fork: header + copies of the parent's active branch entries (ids preserved).
 */
export function createChildSession(opts: SeedOptions): SeededChildSession {
	const now = opts.now ?? new Date();
	const session = childSessionFile({
		sessionsRoot: opts.sessionsRoot,
		cwd: opts.cwd,
		sessionId: opts.sessionId,
		now,
	});

	const lines: string[] = [headerEntry(session.id, session.cwd, now, opts.mode === "lineage" ? opts.parentSessionFile : undefined)];

	if (opts.mode === "fork") {
		for (const entry of opts.parentBranchEntries ?? []) {
			lines.push(JSON.stringify(entry));
		}
	}

	const data = `${lines.join("\n")}\n`;
	if (opts.writeFile) {
		opts.writeFile(session.file, data);
	} else {
		writeFileSync(session.file, data, "utf8");
	}
	return session;
}

/** Extract the last assistant text message from a pi session jsonl file. */
export function lastAssistantText(lines: string[]): string | undefined {
	let found: string | undefined;
	for (const line of lines) {
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const texts = (message.content ?? [])
			.filter((block: any) => block?.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text)
			.join("\n")
			.trim();
		if (texts) found = texts;
	}
	return found;
}
