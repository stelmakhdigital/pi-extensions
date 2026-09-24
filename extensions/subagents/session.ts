/**
 * Child session file management: deterministic paths (the parent creates the
 * file before launch, so parallel spawns never race) and seeding for the
 * standalone / lineage / fork session modes.
 *
 * Session layout (verified against pi 0.87.0):
 *   ~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl
 * Header v3: {"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}
 */
import { existsSync, openSync, fstatSync, readSync, closeSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
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
			.filter((block: any) => {
				if (block?.type !== "text" || typeof block.text !== "string") return false;
				// pi writes "  (no response)" when the assistant produced no text.
				const t = block.text.trim();
				return t !== "" && t !== "(no response)";
			})
			.map((block: any) => block.text)
			.join("\n")
			.trim();
		if (texts) found = texts;
	}
	return found;
}

/** Cumulative token usage/cost accumulated from a child session file. */
export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	total: number;
	cost: number;
}

export const EMPTY_CHILD_USAGE: ChildUsage = { input: 0, output: 0, cacheRead: 0, total: 0, cost: 0 };

/**
 * Incrementally read assistant `usage` records from a pi session jsonl.
 * Only the file tail after `fromOffset` is parsed; the returned offset is the
 * last consumed newline (a partial trailing line is re-read next time).
 */
export function readChildUsage(file: string, fromOffset: number): { usage: ChildUsage; offset: number } {
	const usage: ChildUsage = { ...EMPTY_CHILD_USAGE };
	if (!existsSync(file)) return { usage, offset: fromOffset };
	let offset = fromOffset;
	let size = 0;
	try {
		const fd = openSync(file, "r");
		try {
			size = fstatSync(fd).size;
			if (size < offset) offset = 0; // file recreated/truncated
			const len = size - offset;
			if (len <= 0) return { usage, offset };
			const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
			const read = readSync(fd, buf, 0, buf.length, offset);
			const text = buf.toString("utf8", 0, read);
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline < 0) return { usage, offset }; // partial line, wait for more
			offset += lastNewline + 1;
			for (const line of text.slice(0, lastNewline).split("\n")) {
				if (!line || !line.includes("\"usage\"")) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				const u = entry?.type === "message" && entry.message?.role === "assistant" ? entry.message.usage : undefined;
				if (!u || typeof u !== "object") continue;
				usage.input += Number(u.input) || 0;
				usage.output += Number(u.output) || 0;
				usage.cacheRead += Number(u.cacheRead) || 0;
				usage.total += Number(u.totalTokens) || 0;
				usage.cost += Number(u.cost?.total) || 0;
			}
		}
		finally {
			closeSync(fd);
		}
	} catch {
		// Unreadable file: keep the old offset, try again next tick.
		return { usage: EMPTY_CHILD_USAGE, offset: fromOffset };
	}
	return { usage, offset };
}
