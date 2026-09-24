/**
 * Child extension: loaded into subagent sessions via `pi -e child.ts`.
 *
 * Responsibilities:
 * - activity snapshots (throttled JSON next to the parent's artifact dir) so
 *   the parent can classify starting/active/waiting/stalled;
 * - `agent_done` tool: explicit completion (autonomous agents);
 * - `agent_ping` tool: ask the parent for help (session exits, parent resumes);
 * - auto-exit: when the agent definition sets auto-exit, the session closes
 *   itself after a completed turn — any manual input disables auto-exit.
 *
 * Child mode is detected via PI_SUBAGENTS_CHILD_ID; outside of it the module
 * registers nothing (defense in depth: the package never loads this file).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CHILD_ID = process.env.PI_SUBAGENTS_CHILD_ID ?? "";
const ACTIVITY_FILE = process.env.PI_SUBAGENTS_ACTIVITY_FILE ?? "";
const AUTO_EXIT = process.env.PI_SUBAGENTS_AUTO_EXIT === "1";
const SNAPSHOT_THROTTLE_MS = 500;

function sessionFile(ctx: ExtensionContext): string | undefined {
	return process.env.PI_SUBAGENTS_SESSION_FILE ?? ctx.sessionManager.getSessionFile() ?? undefined;
}

function writeSidecar(ctx: ExtensionContext, payload: Record<string, unknown>): void {
	const file = sessionFile(ctx);
	if (!file) return;
	const exitFile = `${file}.exit`;
	try {
		writeFileSync(exitFile, JSON.stringify(payload), "utf8");
	} catch {
		// Parent falls back to the terminal sentinel.
	}
}

function summarizeLastAssistantError(messages: Array<Record<string, any>>): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "error") {
			return typeof msg.errorMessage === "string" && msg.errorMessage.trim() !== ""
				? msg.errorMessage
				: "Sub-agent turn ended with an error (provider/stop reason).";
		}
		return undefined;
	}
	return undefined;
}

/** Temporary integration debug: append handled event names to a file. */
const DEBUG_LOG = process.env.PI_SUBAGENTS_DEBUG_LOG ?? "";
function dbg(label: string, extra = ""): void {
	if (!DEBUG_LOG) return;
	try {
		writeFileSync(DEBUG_LOG, `${new Date().toISOString()} ${label} ${extra}\n`, { flag: "a" });
	} catch {}
}

export default function subagentsChild(pi: ExtensionAPI): void {
	if (!CHILD_ID) return;

	let autoExitEnabled = AUTO_EXIT;
	let sawAgentStart = false;
	let seq = 0;
	let lastWrite = 0;

	const state = {
		agentActive: false,
		turnActive: false,
		providerActive: false,
		toolActive: false,
		toolName: undefined as string | undefined,
	};

	function writeSnapshot(force = false): void {
		if (!ACTIVITY_FILE) return;
		const now = Date.now();
		if (!force && now - lastWrite < SNAPSHOT_THROTTLE_MS) return;
		lastWrite = now;
		seq += 1;
		const payload = JSON.stringify({
			v: 1,
			childId: CHILD_ID,
			seq,
			ts: now,
			agentActive: state.agentActive,
			turnActive: state.turnActive,
			providerActive: state.providerActive,
			toolActive: state.toolActive,
			...(state.toolName ? { toolName: state.toolName } : {}),
		});
		try {
			mkdirSync(dirname(ACTIVITY_FILE), { recursive: true });
			const tmp = `${ACTIVITY_FILE}.tmp`;
			writeFileSync(tmp, payload, "utf8");
			renameSync(tmp, ACTIVITY_FILE);
		} catch {
			// Snapshots are best-effort; the parent watchdog copes.
		}
	}

	function lastAssistantStopReason(messages: Array<Record<string, any>>): string | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") return messages[i].stopReason;
		}
		return undefined;
	}

	pi.on("session_start", () => {
		writeSnapshot(true);
	});

	pi.on("input", () => {
		// Manual input after the agent started: the user takes over — auto-exit
		// is disabled for good. The initial task prompt also arrives as input
		// before agent_start and must NOT disable auto-exit.
		if (sawAgentStart) autoExitEnabled = false;
	});

	pi.on("before_agent_start", () => {
		state.agentActive = true;
		writeSnapshot();
	});

	pi.on("agent_start", () => {
		sawAgentStart = true;
		state.agentActive = true;
		writeSnapshot();
	});

	pi.on("agent_end", (_event, ctx) => {
		state.agentActive = false;
		const messages = (_event as any).messages ?? [];
		const stopReason = lastAssistantStopReason(messages);
		writeSnapshot(true);
		dbg("agent_end", `autoExitEnabled=${autoExitEnabled} stopReason=${stopReason} messages=${messages.length}`);

		if (!autoExitEnabled) return;
		if (stopReason === "aborted") return; // User interrupted: stay open.

		const errorMessage = stopReason === "error" ? summarizeLastAssistantError(messages) : undefined;
		if (errorMessage) {
			writeSidecar(ctx, { type: "error", exitCode: 1, errorMessage });
			ctx.shutdown();
			return;
		}

		writeSidecar(ctx, { type: "done", exitCode: 0 });
		dbg("agent_end:auto-exit", "sidecar written, shutdown requested");
		ctx.shutdown();
	});

	pi.on("turn_start", () => {
		state.turnActive = true;
		writeSnapshot();
	});

	pi.on("turn_end", () => {
		state.turnActive = false;
		writeSnapshot();
	});

	pi.on("before_provider_request", () => {
		state.providerActive = true;
		writeSnapshot();
	});

	pi.on("after_provider_response", () => {
		state.providerActive = false;
		writeSnapshot();
	});

	pi.on("message_update", () => {
		writeSnapshot();
	});

	pi.on("tool_execution_start", (event) => {
		state.toolActive = true;
		state.toolName = (event as any).toolName;
		writeSnapshot();
	});

	pi.on("tool_execution_update", () => {
		writeSnapshot();
	});

	pi.on("tool_result", (event) => {
		state.toolName = (event as any).toolName;
		writeSnapshot();
	});

	pi.on("tool_execution_end", () => {
		state.toolActive = false;
		state.toolName = undefined;
		writeSnapshot();
	});

	pi.on("session_shutdown", () => {
		writeSnapshot(true);
	});

	pi.registerTool({
		name: "agent_done",
		label: "agent_done",
		description:
			"Mark this sub-agent task as complete. The session exits immediately and the parent agent receives your final summary (your last assistant message). Call it only when the task is fully done.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			writeSidecar(ctx, { type: "done", exitCode: 0 });
			ctx.shutdown();
			return { content: [{ type: "text", text: "Marked done; session is closing." }], details: { status: "done" } };
		},
	});

	pi.registerTool({
		name: "agent_ping",
		label: "agent_ping",
		description:
			"Ask the parent agent for help. The session exits; the parent is notified with your message and can resume this session with guidance (resume_agent). Use only when blocked on a decision or missing information.",
		parameters: Type.Object({
			message: Type.String({ description: "What you need help with (decision, missing info, conflict)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			writeSidecar(ctx, { type: "ping", exitCode: 0, message: params.message });
			ctx.shutdown();
			return { content: [{ type: "text", text: "Ping sent to the parent; session is closing." }], details: { status: "ping" } };
		},
	});
}
