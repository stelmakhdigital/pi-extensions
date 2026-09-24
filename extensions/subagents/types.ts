/**
 * Shared types for the subagents extension (parent, child, tmux backend).
 */

/** A controllable terminal surface in the multiplexer. */
export interface SurfaceRef {
	kind: "pane" | "window";
	/** tmux target: pane id (%N) or window id (@N). */
	target: string;
	/** Owning tmux session name (when known). */
	session?: string;
}

export interface MuxProbe {
	ok: boolean;
	detail?: string;
}

/**
 * Backend contract. v1 ships a single tmux implementation; future multiplexers
 * plug in here and are selected through configuration.
 */
export interface MuxBackend {
	id: string;
	probe(): Promise<MuxProbe>;
	createSurface(opts: { name: string }): Promise<SurfaceRef>;
	/** Type a pre-built launch script path into the surface and press Enter. */
	sendCommand(surface: SurfaceRef, scriptPath: string): Promise<void>;
	sendEscape(surface: SurfaceRef): Promise<void>;
	isAlive(surface: SurfaceRef): Promise<boolean>;
	captureTail(surface: SurfaceRef, lines?: number): Promise<string>;
	rename(surface: SurfaceRef, title: string): Promise<void>;
	close(surface: SurfaceRef): Promise<void>;
	/** One batched probe for all surfaces (single multiplexer call). */
	batchStatus(surfaces: SurfaceRef[]): Promise<Map<string, boolean>>;
}

export type SubagentPhase = "starting" | "active" | "waiting" | "stalled";

/** Activity snapshot written by the child extension (throttled, atomic). */
export interface ActivitySnapshot {
	v: 1;
	childId: string;
	seq: number;
	ts: number;
	agentActive: boolean;
	turnActive: boolean;
	providerActive: boolean;
	toolActive: boolean;
	toolName?: string;
}

/** Exit sidecar written by the child next to its session file. */
export type ExitSidecar =
	| { type: "done"; exitCode: number }
	| { type: "ping"; exitCode: number; name?: string; message: string }
	| { type: "error"; exitCode: number; errorMessage?: string };

export interface RunningSubagent {
	id: string;
	name: string;
	agent?: string;
	task: string;
	surface: SurfaceRef;
	sessionFile: string;
	activityFile: string;
	launchScript: string;
	startTime: number;
	autoExit: boolean;
	interactive: boolean;
	phase: SubagentPhase;
	lastSnapshot?: ActivitySnapshot;
	stallPingSent: boolean;
	/** Timestamp of the last stall notification (for reping). */
	lastStallPingTs?: number;
	finished: boolean;
	/** Cumulative child token usage, read incrementally from the session jsonl. */
	usage?: { input: number; output: number; cacheRead: number; total: number; cost: number; offset: number };
}

export type ResultStatus = "done" | "ping" | "error";

/** Structured result delivered to the parent as a custom message. */
export interface SubagentResultDetails {
	status: ResultStatus;
	name: string;
	id: string;
	agent?: string;
	exitCode: number;
	elapsedMs: number;
	sessionFile: string;
	summary?: string;
	/** done but the child wrote no final text answer (use resume_agent to ask for a report). */
	noSummary?: boolean;
	tokens?: { input: number; output: number; total: number };
	costUsd?: number;
	ping?: { message: string };
	errorMessage?: string;
}

/** Frontmatter subset supported for `.pi/agents/*.md` definitions. */
export interface AgentDefinition {
	name: string;
	description?: string;
	body: string;
	model?: string;
	thinking?: string;
	tools?: string;
	skills?: string;
	sessionMode: "standalone" | "lineage" | "fork";
	autoExit: boolean;
	interactive: boolean;
	cwd?: string;
	/** Comma-separated tools to exclude from the child (--exclude-tools). */
	denyTools?: string;
	/** Allow this agent to spawn sub-agents itself (recursive spawning, opt-in). */
	spawning?: boolean;
	source: "project" | "global" | "bundled";
	file: string;
}

export type SessionMode = "standalone" | "lineage" | "fork";
