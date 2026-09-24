/**
 * Subagents — asynchronous sub-agent management for pi (tmux-based).
 *
 * Parent side (this file):
 * - tools: spawn_agent, agents_list, interrupt_agent, resume_agent
 * - command: /spawn [agent] <task...>
 * - live widget with per-agent status (starting/active/waiting/stalled)
 * - watchdog driven by child-written activity snapshots
 * - completion via `.exit` sidecar (fast path) / surface loss (crash path)
 * - results steered back as a styled custom message
 * - tmux handoff at startup when pi runs outside tmux (config: ask/auto/never)
 *
 * Child side lives in child.ts (loaded with `pi -e`); the parent registers
 * nothing in child sessions (PI_SUBAGENTS_CHILD_ID guard) — recursive spawns
 * are impossible by construction.
 */
import { execFile, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	AgentDefinition,
	ActivitySnapshot,
	ExitSidecar,
	MuxBackend,
	ResultStatus,
	RunningSubagent,
	SessionMode,
	SubagentResultDetails,
	SurfaceRef,
} from "./types.ts";
import { globalConfigPath, isDisabled, loadConfig, persistHandoffPreference, projectConfigPath, SubagentsConfig } from "./config.ts";
import { createTmuxBackend } from "./tmux-backend.ts";
import {
	PARENT_TOOLS,
	buildChildToolAllowlist,
	discoverAgents,
	resolveAgent,
	resolveChildCwd,
	resolveSessionMode,
} from "./agents.ts";
import { EMPTY_CHILD_USAGE, createChildSession, lastAssistantText, readChildUsage, sessionsRootFor } from "./session.ts";

const CHILD_SCRIPT = fileURLToPath(new URL("./child.ts", import.meta.url));
const PARENT_SCRIPT = fileURLToPath(new URL("./index.ts", import.meta.url));
const WIDGET_KEY = "subagents";
const RESULT_CUSTOM_TYPE = "subagents.result";
const REPORT_CUSTOM_TYPE = "subagents.report";
const HANDOFF_GUARD_ENV = "PI_SUBAGENTS_TMUX_HANDOFF";
const EXIT_SENTINEL_RE = /__SUBAGENT_EXIT_(\d+)__/;

/** Default system prompt for /iterate without an explicit agent definition. */
const ITERATE_PROMPT =
	"You are an iteration sub-agent running in a FORKED copy of the parent session: the full parent conversation is your context. " +
	"Apply the task below on top of that context. Keep changes focused on the task, verify with tests when possible, " +
	"and finish with a short report: what changed, what was verified, what was left undone (if anything).";

const PHASE_FALLBACK_PROMPTS: Record<"planner" | "worker" | "reviewer", string> = {
	planner:
		"You are a planning sub-agent. Do not implement: explore the codebase read-only and finish with a concise plan (goal, ordered steps with file paths, risks, verification commands).",
	worker:
		"You are an implementation sub-agent. Execute the given plan precisely with minimal changes, run the relevant tests, do not commit; finish with a report of changes and verification.",
	reviewer:
		"You are a code review sub-agent. Review the recent changes (git diff) for correctness, edge cases and test coverage; run available checks; finish with a verdict, issues by severity and notes. Do not fix anything yourself.",
};

// ── module state (single pi process = one parent session at a time) ──

let latestCtx: ExtensionContext | undefined;
let configRef: SubagentsConfig | undefined;
let backend: MuxBackend | undefined;
const running = new Map<string, RunningSubagent>();
let watchTimer: NodeJS.Timeout | undefined;
let tickCount = 0;
let lastWidgetJson = "";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uniform tool-result details type so TS infers a single TDetails per tool. */
interface ToolDetails {
	status?: string;
	error?: string;
	code?: string;
	id?: string;
	name?: string;
	surface?: string;
	sessionFile?: string;
	agents?: Array<Record<string, unknown>>;
	[k: string]: unknown;
}
function td(o: Record<string, unknown> = {}): ToolDetails {
	return o as ToolDetails;
}

// ── small helpers ──

function newId(): string {
	return Math.random().toString(16).slice(2, 10);
}

function quote(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return slug || "subagent";
}

function formatElapsedMs(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatClock(startTime: number): string {
	const totalSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function formatUsage(r: RunningSubagent): string | undefined {
	const u = r.usage;
	if (!u || (u.total === 0 && u.cost === 0)) return undefined;
	const cost = u.cost > 0 ? ` $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}` : "";
	return ` · ${formatTokens(u.total)} tok${cost}`;
}

function execFileAsync(cmd: string, args: string[], timeoutMs = 3000): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	return new Promise((res) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
			if (err) res({ ok: false, error: (err as Error).message.split("\n")[0] });
			else res({ ok: true, stdout: (stdout as string).trim() });
		});
	});
}

/** Last non-empty line of a shell pane ending with a prompt marker. */
const PROMPT_TAIL_RE = /[$>❯#%]\s*$/;

/**
 * Smart shell-ready: poll capture-pane until the pane's last non-empty line
 * looks like a prompt (last char is one of $ > ❯ # %). Replaces a blind
 * fixed delay; `timeoutMs` is the MAX wait — on timeout the caller proceeds
 * anyway (launch is best-effort, the sentinel/crash path covers the rest).
 * Returns true when a prompt marker was seen.
 */
export async function waitForShellReady(
	backend: MuxBackend,
	surface: SurfaceRef,
	timeoutMs: number,
	pollMs = 125,
): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const tail = await backend.captureTail(surface, 6);
			const lines = tail.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0);
			const last = lines[lines.length - 1] ?? "";
			if (last && PROMPT_TAIL_RE.test(last)) return true;
		} catch {
			// Pane not capturable yet: keep waiting.
		}
		if (Date.now() >= deadline) return false;
		await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}

function readJsonSafe<T>(file: string): T | undefined {
	try {
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function readSnapshot(file: string, childId: string): ActivitySnapshot | undefined {
	const data = readJsonSafe<Partial<ActivitySnapshot>>(file);
	if (!data || data.v !== 1 || data.childId !== childId || typeof data.ts !== "number") return undefined;
	return data as ActivitySnapshot;
}

function readExitSidecar(sessionFile: string): ExitSidecar | undefined {
	const file = `${sessionFile}.exit`;
	const data = readJsonSafe<Partial<ExitSidecar>>(file);
	if (!data || (data.type !== "done" && data.type !== "ping" && data.type !== "error")) return undefined;
	try {
		unlinkSync(file);
	} catch {}
	return data as ExitSidecar;
}

function artifactDir(): string | undefined {
	const sm = latestCtx?.sessionManager;
	if (!sm) return undefined;
	const dir = sm.getSessionDir();
	const id = sm.getSessionId();
	if (!dir || !id) return undefined;
	return join(dir, "artifacts", id);
}

function ensureBackend(): MuxBackend {
	backend ??= createTmuxBackend();
	return backend;
}

// ── widget ──

function activityLabel(r: RunningSubagent): string {
	if (r.phase === "active") {
		const tool = r.lastSnapshot?.toolActive ? r.lastSnapshot.toolName : undefined;
		return tool ? `active · ${tool}` : "active";
	}
	return r.phase === "starting" ? "starting…" : r.phase;
}

function widgetLines(): string[] | undefined {
	const config = configRef;
	if (!config?.widget.enabled) return undefined;
	const list = [...running.values()].filter((r) => !r.finished);
	if (list.length === 0) return undefined;
	list.sort((a, b) => a.startTime - b.startTime);
	const width = 64;
	const title = ` Subagents — ${list.length} running `;
	const top = `╭─${title}${"─".repeat(Math.max(1, width - title.length - 1))}╮`;
	const lines = [top];
	for (const r of list) {
		const label = `${r.name}${r.agent ? ` (${r.agent})` : ""}`;
		const state = activityLabel(r);
		const usage = formatUsage(r) ?? "";
		const clock = formatClock(r.startTime);
		const row = ` ${clock}  ${truncateToWidth(label, Math.max(8, width - 14 - state.length - usage.length - 2))}  ${state}${usage}`;
		lines.push(truncateToWidth(row, width));
	}
	lines.push(`╰${"─".repeat(width - 2)}╯`);
	return lines;
}

function updateWidget(): void {
	const ui = latestCtx?.ui;
	if (!ui) return;
	const lines = widgetLines();
	const key = JSON.stringify(lines);
	if (key === lastWidgetJson) return;
	lastWidgetJson = key;
	ui.setWidget(WIDGET_KEY, lines);
}

// ── completion handling ──

function resultText(status: ResultStatus, name: string, summary?: string, ping?: { message: string }, errorMessage?: string, sessionFile?: string): string {
	if (status === "ping") {
		return `Sub-agent "${name}" needs help: ${ping?.message ?? ""}\nSession: ${sessionFile ?? "(unknown)"} — respond with resume_agent (sessionPath + message).`;
	}
	if (status === "error") {
		return `Sub-agent "${name}" FAILED: ${errorMessage ?? "unknown error"}. Session: ${sessionFile ?? "(unknown)"}`;
	}
	return `Sub-agent "${name}" finished (done).\nSummary:\n${summary ?? "(no output)"}\nSession: ${sessionFile ?? "(unknown)"}`;
}

async function finishSubagent(r: RunningSubagent, sidecar: ExitSidecar | { type: "error"; exitCode: number; errorMessage?: string }, via: "sidecar" | "crash" | "sentinel"): Promise<void> {
	if (r.finished) return;
	r.finished = true;
	const config = configRef;
	const status: ResultStatus = sidecar.type === "ping" ? "ping" : sidecar.type === "done" ? "done" : "error";

	const lines = readLinesSafe(r.sessionFile);
	const summary = lastAssistantText(lines);
	const errorMessage = sidecar.type === "error" ? sidecar.errorMessage : undefined;
	// Final usage read (from offset 0) — covers the last turn written between
	// the last watch tick and the exit sidecar.
	const usage = readChildUsage(r.sessionFile, 0).usage;

	let keepSurface = false;
	if (status === "error" && config?.cleanup.keepOnError) keepSurface = true;
	if (status !== "error" && config?.cleanup.killSurfaceOnExit === false) keepSurface = true;
	if (!keepSurface) {
		try {
			await ensureBackend().close(r.surface);
		} catch {}
	}

	running.delete(r.id);
	updateWidget();

	const details: SubagentResultDetails = {
		status,
		name: r.name,
		id: r.id,
		agent: r.agent,
		exitCode: sidecar.exitCode,
		elapsedMs: Date.now() - r.startTime,
		sessionFile: r.sessionFile,
		...(summary ? { summary } : {}),
		...(usage.total > 0 ? { tokens: { input: usage.input, output: usage.output, total: usage.total } } : {}),
		...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
		...(status === "ping" ? { ping: { message: (sidecar as { message?: string }).message ?? "" } } : {}),
		...(status === "error" ? { errorMessage: errorMessage ?? `Surface lost via ${via}; no completion sidecar was written.` } : {}),
	};

	latestCtx?.ui.notify(
		status === "done" ? `subagents: ${r.name} finished` : status === "ping" ? `subagents: ${r.name} pings the parent` : `subagents: ${r.name} failed`,
		status === "done" ? "info" : "warning",
	);

	// Steer the result into the parent session and wake the agent.
	piRef?.sendMessage(
		{
			customType: RESULT_CUSTOM_TYPE,
			content: resultText(status, r.name, summary, details.ping, details.errorMessage, r.sessionFile),
			display: true,
			details,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function readLinesSafe(file: string): string[] {
	try {
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8").split("\n");
	} catch {
		return [];
	}
}

// ── watch loop ──

export function classifyPhase(r: RunningSubagent, now: number, staleMs: number): RunningSubagent["phase"] {
	const snap = r.lastSnapshot;
	if (!snap) return "starting";
	const age = now - snap.ts;
	const wasBusy = snap.agentActive || snap.turnActive || snap.providerActive || snap.toolActive;
	if (age > staleMs) {
		// A stale snapshot is only alarming if the child was mid-work;
		// an idle "waiting" child legitimately produces no events.
		return wasBusy ? "stalled" : "waiting";
	}
	return wasBusy ? "active" : "waiting";
}

/**
 * Stall notification policy: "first" (never notified yet), "reping" (stall
 * persists and the reping interval elapsed), "none".
 */
async function watchTick(): Promise<void> {
	tickCount += 1;
	if (tickCount % 30 === 0) refreshConfig();
	const config = configRef;
	if (!config) return;
	const live = [...running.values()].filter((r) => !r.finished);
	if (live.length === 0) {
		lastWidgetJson = "";
		updateWidget();
		return;
	}

	const now = Date.now();
	let statuses: Map<string, boolean> = new Map();
	try {
		statuses = await ensureBackend().batchStatus(live.map((r) => r.surface));
	} catch {
		statuses = new Map();
	}

	for (const r of live) {
		const snap = readSnapshot(r.activityFile, r.id);
		if (snap) r.lastSnapshot = snap;

		// Incremental token usage/cost from the child session file (tail only).
		const usageDelta = readChildUsage(r.sessionFile, r.usage?.offset ?? 0);
		if (usageDelta.usage.total > 0 || usageDelta.usage.cost > 0) {
			const prev = r.usage ?? EMPTY_CHILD_USAGE;
			r.usage = {
				input: prev.input + usageDelta.usage.input,
				output: prev.output + usageDelta.usage.output,
				cacheRead: prev.cacheRead + usageDelta.usage.cacheRead,
				total: prev.total + usageDelta.usage.total,
				cost: prev.cost + usageDelta.usage.cost,
				offset: usageDelta.offset,
			};
		} else if (r.usage) {
			r.usage.offset = usageDelta.offset;
		}

		const sidecar = readExitSidecar(r.sessionFile);
		if (sidecar) {
			void finishSubagent(r, sidecar, "sidecar").catch(() => {});
			continue;
		}

		const alive = r.surface.kind === "pane" ? statuses.get(r.surface.target) ?? false : await ensureBackend().isAlive(r.surface);
		if (!alive) {
			// Surface gone without a sidecar: crash path.
			void finishSubagent(r, { type: "error", exitCode: 1, errorMessage: "Sub-agent surface disappeared before it reported completion." }, "crash").catch(() => {});
			continue;
		}

		r.phase = classifyPhase(r, now, config.watchdog.snapshotStaleMs);

		if (r.phase === "stalled" && !r.stallPingSent && !r.interactive) {
			r.stallPingSent = true;
			latestCtx?.ui.notify(`subagents: ${r.name} looks stalled (no activity snapshot for ${Math.round(config.watchdog.snapshotStaleMs / 1000)}s)`, "warning");
		}
		if (r.phase !== "stalled" && r.stallPingSent) {
			r.stallPingSent = false;
		}

		// Stale-but-alive panes: check the terminal sentinel occasionally (crash fallback).
		if (r.lastSnapshot && now - r.lastSnapshot.ts > config.watchdog.snapshotStaleMs * 2 && tickCount % 5 === 0) {
			const tail = await ensureBackend().captureTail(r.surface, 6);
			const match = tail.match(EXIT_SENTINEL_RE);
			if (match) {
				const code = Number(match[1]);
				const summary = lastAssistantText(readLinesSafe(r.sessionFile));
				void finishSubagent(
					r,
					code === 0
						? { type: "done", exitCode: 0 }
						: { type: "error", exitCode: code, errorMessage: `Sub-agent process exited with code ${code}${summary ? "" : " and no final output"}.` },
					"sentinel",
				).catch(() => {});
			}
		}
	}

	// Refresh elapsed clocks every ~5 ticks even if phases did not change.
	if (tickCount % 5 === 0) {
		lastWidgetJson = "";
		updateWidget();
	} else {
		updateWidget();
	}
}

function refreshConfig(): void {
	if (!latestCtx) return;
	configRef = loadConfig({ cwd: latestCtx.cwd, projectTrusted: latestCtx.isProjectTrusted() });
}

function startWatch(): void {
	if (watchTimer) return;
	watchTimer = setInterval(() => {
		void watchTick().catch(() => {});
	}, configRef?.watch.intervalMs ?? 1000);
	watchTimer.unref();
}

// ── spawn ──

export interface SpawnParams {
	task: string;
	name?: string;
	agent?: string;
	fork?: boolean;
	interactive?: boolean;
	model?: string;
	thinking?: string;
	systemPrompt?: string;
	skills?: string;
	tools?: string;
	cwd?: string;
}

export type SpawnOutcome =
	| { ok: true; id: string; name: string; sessionFile: string; surface: string }
	| { ok: false; error: string; code?: "disabled" | "backend" | "limit" | "unknown-agent" | "no-session" | "error" };

export function buildLaunchScript(opts: {
	r: RunningSubagent;
	def: AgentDefinition | undefined;
	params: SpawnParams;
	childCwd: string;
	model: string | undefined;
	systemPromptFile?: string;
	childSessionFile: string;
	resumeMessage?: string;
	autoExit: boolean;
	childExtensions?: "none" | "all";
}): string {
	const { r, def, params, childCwd, model, systemPromptFile, childSessionFile, resumeMessage, autoExit } = opts;
	const skills = (params.skills ?? def?.skills ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const parts: string[] = ["pi", "--session", childSessionFile, "-e", CHILD_SCRIPT];
	// Deterministic child environment: global extensions can block the child
	// (trust dialogs, interactive prompts) and are a recursion surface. Switch
	// to "all" via config child.extensions when the sub-agent needs them.
	if (opts.childExtensions !== "all") parts.push("--no-extensions");
	// Opt-in recursive spawning: the child loads the parent extension back and
	// keeps the spawning tools (guard env lets the extension register them).
	const spawning = def?.spawning === true;
	if (spawning) parts.push("-e", PARENT_SCRIPT);
	if (model) parts.push("--model", model);
	const allowlist = buildChildToolAllowlist(def, params.tools, { spawning });
	if (allowlist) parts.push("--tools", allowlist);
	// The child must never see parent-side spawning tools unless its agent
	// definition opts in (defense in depth; deny-tools always applies).
	const deny = (def?.denyTools ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const excluded = spawning ? deny : [...PARENT_TOOLS.split(","), ...deny];
	if (excluded.length > 0) parts.push("--exclude-tools", excluded.join(","));
	if (systemPromptFile) parts.push("--append-system-prompt", systemPromptFile);
	parts.push("--");
	for (const skill of skills) parts.push(`/skill:${skill}`);
	const prompt = params.task ?? resumeMessage ?? "";
	if (prompt) parts.push(prompt);

	const quoted = parts.map((p) => (p.includes(" ") ? quote(p) : p)).join(" ");
	const envPrefix = [
		`PI_SUBAGENTS_CHILD_ID=${r.id}`,
		`PI_SUBAGENTS_ACTIVITY_FILE=${quote(r.activityFile)}`,
		`PI_SUBAGENTS_SESSION_FILE=${quote(r.sessionFile)}`,
		`PI_SUBAGENTS_AUTO_EXIT=${autoExit ? "1" : "0"}`,
		...(spawning ? ["PI_SUBAGENTS_SPAWNING=1"] : []),
	].join(" ");

	return [
		"#!/bin/bash",
		`# subagent launch: ${r.name} (id ${r.id})`,
		`cd ${quote(childCwd)}`,
		`${envPrefix} ${quoted}`,
		`echo "__SUBAGENT_EXIT_$?"`,
	].join("\n");
}

export function isDisabledFlag(pi: ExtensionAPI): boolean {
	try {
		return isDisabled(process.env, pi.getFlag("--subagents-disabled"));
	} catch {
		return isDisabled(process.env);
	}
}

export async function spawnAgentInternal(params: SpawnParams, pi: ExtensionAPI): Promise<SpawnOutcome> {
	const ctx = latestCtx;
	if (!ctx) return { ok: false, error: "Subagents are not ready yet (session not started).", code: "error" };
	const config = configRef ?? (configRef = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }));

	if (isDisabledFlag(pi)) {
		return { ok: false, error: "Subagents are disabled (PI_SUBAGENTS_DISABLED=1 or --subagents-disabled).", code: "disabled" };
	}

	const def = params.agent ? resolveAgent(ctx.cwd, params.agent) : undefined;
	if (params.agent && !def) {
		const available = discoverAgents(ctx.cwd).map((d) => d.name).join(", ") || "(none)";
		return { ok: false, error: `Unknown agent "${params.agent}". Available: ${available}`, code: "unknown-agent" };
	}

	const probe = await ensureBackend().probe();
	if (!probe.ok) {
		return {
			ok: false,
			error: `Subagents need pi to run inside tmux (${probe.detail ?? "tmux unavailable"}). Start pi with: tmux new -A -s ${quote(config.tmux.sessionName)} '${config.tmux.sessionCommand}'.`,
			code: "backend",
		};
	}

	const liveCount = [...running.values()].filter((r) => !r.finished).length;
	if (liveCount >= config.limits.maxConcurrent) {
		return { ok: false, error: `Concurrency limit reached (${config.limits.maxConcurrent}). Wait for a sub-agent to finish.`, code: "limit" };
	}

	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile) {
		return { ok: false, error: "No parent session file available.", code: "no-session" };
	}

	const id = newId();
	const name = params.name?.trim() || def?.name || "subagent";
	const childCwd = resolveChildCwd(def, params.cwd, ctx.cwd);
	const mode: SessionMode = resolveSessionMode(def, params.fork);
	const autoExit = def?.autoExit ?? false;
	const interactive = params.interactive ?? def?.interactive ?? !autoExit;

	const branchEntries =
		mode === "fork" ? ((ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>).filter((e) => e?.type !== "session")) : undefined;

	const session = createChildSession({
		mode,
		// getSessionDir() is the per-cwd subdir of the sessions root (session.ts).
		sessionsRoot: sessionsRootFor(ctx.sessionManager.getSessionDir()),
		cwd: childCwd,
		parentSessionFile,
		parentBranchEntries: branchEntries,
	});

	const dir = artifactDir() ?? join(ctx.sessionManager.getSessionDir(), "artifacts");
	mkdirSync(dir, { recursive: true });
	const r: RunningSubagent = {
		id,
		name,
		agent: params.agent,
		task: params.task,
		surface: { kind: "pane", target: "" },
		sessionFile: session.file,
		activityFile: join(dir, `${slugify(name)}-${id}.activity.json`),
		launchScript: join(dir, `${slugify(name)}-${id}.launch.sh`),
		startTime: Date.now(),
		autoExit,
		interactive,
		phase: "starting",
		stallPingSent: false,
		finished: false,
	};

	// Reserve the slot immediately (synchronously after the limit check) so that
	// concurrent spawn calls cannot all pass the check against a stale count.
	running.set(id, r);
	startWatch();
	updateWidget();

	let surface;
	try {
		surface = await ensureBackend().createSurface({ name });
	} catch (err) {
		running.delete(id);
		updateWidget();
		try {
			unlinkSync(session.file);
		} catch {}
		return { ok: false, error: `Failed to create tmux surface: ${(err as Error).message}`, code: "backend" };
	}
	r.surface = surface;

	let systemPromptFile: string | undefined;
	const systemPrompt = def?.body || params.systemPrompt;
	if (systemPrompt) {
		systemPromptFile = join(dir, `${slugify(name)}-${id}.systemprompt.md`);
		writeFileSync(systemPromptFile, systemPrompt, "utf8");
	}

	const model = params.model ?? def?.model;
	const thinking = params.thinking ?? def?.thinking;
	const modelArg = model ? `${model}${thinking ? `:${thinking}` : ""}` : undefined;

	const script = buildLaunchScript({
		r,
		def,
		params,
		childCwd,
		model: modelArg,
		systemPromptFile,
		childSessionFile: session.file,
		autoExit,
		childExtensions: config.child?.extensions,
	});
	writeFileSync(r.launchScript, script, "utf8");

	try {
		// Smart shell-ready: wait for a prompt marker (max shellReadyMs), then send.
		await waitForShellReady(ensureBackend(), surface, config.tmux.shellReadyMs);
		await ensureBackend().sendCommand(surface, r.launchScript);
	} catch (err) {
		running.delete(id);
		updateWidget();
		try {
			await ensureBackend().close(surface);
		} catch {}
		return { ok: false, error: `Failed to launch sub-agent: ${(err as Error).message}`, code: "error" };
	}

	return { ok: true, id, name, sessionFile: session.file, surface: surface.target };
}

// ── tmux handoff (pi started outside tmux) ──

function handoffPossible(ctx: ExtensionContext): boolean {
	return (
		!isDisabled(process.env) &&
		ctx.mode === "tui" &&
		!process.env.TMUX &&
		!process.env[HANDOFF_GUARD_ENV] &&
		(configRef?.tmux.handoff ?? "ask") !== "never"
	);
}

function runTmuxHandoff(ctx: ExtensionContext): void {
	const config = configRef;
	if (!config) return;
	const sessionName = config.tmux.sessionName;
	// Prefer the explicit session file (deterministic continuation) over
	// "most recent session in cwd" — the latter can be a stale/foreign session.
	let sessionCommand = config.tmux.sessionCommand;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile && existsSync(sessionFile)) {
		sessionCommand = `pi --session ${quote(sessionFile)}`;
	}
	const script =
		`sleep 0.3; exec env ${HANDOFF_GUARD_ENV}=1 tmux new-session -d -A -s ${quote(sessionName)} ${quote(sessionCommand)}`;
	try {
		const child = spawnProcess("bash", ["-c", script], { stdio: "inherit", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch (err) {
		ctx.ui.notify(`subagents: tmux handoff failed: ${(err as Error).message}`, "error");
		return;
	}
	ctx.ui.notify("Restarting pi inside tmux — the session continues...", "info");
	ctx.shutdown();
}

async function maybeHandoff(ctx: ExtensionContext): Promise<void> {
	if (!handoffPossible(ctx)) return;
	const config = configRef!;
	if (config.tmux.handoff === "auto") {
		runTmuxHandoff(ctx);
		return;
	}
	const choice = await ctx.ui.select(
		"Subagents: pi runs outside tmux",
		[
			`Restart pi inside tmux (session continues, attach: tmux a -t ${config.tmux.sessionName})`,
			"Not now",
			"Never ask again",
		],
	).catch(() => undefined);
	if (choice?.startsWith("Restart")) {
		runTmuxHandoff(ctx);
	} else if (choice?.startsWith("Never")) {
		if (persistHandoffPreference("never")) {
			ctx.ui.notify("subagents: tmux handoff disabled (tmux.handoff: never in ~/.pi/agent/subagents.json)", "info");
		}
	}
}

// ── /subagents doctor ──

export interface DoctorCheck {
	name: string;
	ok: boolean;
	warn?: boolean;
	detail?: string;
}

export function renderDoctorReport(checks: DoctorCheck[]): string {
	return checks
		.map((c) => {
			const mark = c.ok ? "✓" : c.warn ? "!" : "✗";
			return `${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`;
		})
		.join("\n");
}

export async function collectDoctor(opts: { cwd?: string } = {}): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const env = process.env;

	const tmuxV = await execFileAsync("tmux", ["-V"]);
	checks.push({ name: "tmux binary", ok: tmuxV.ok, detail: tmuxV.ok ? tmuxV.stdout : tmuxV.error });

	const inTmux = !!env.TMUX;
	checks.push({
		name: "pi inside tmux",
		ok: inTmux,
		warn: !inTmux,
		detail: inTmux ? `pane ${env.TMUX_PANE ?? "?"}` : "not in tmux — spawn will fail until handoff",
	});
	if (inTmux) {
		const list = await execFileAsync("tmux", ["list-panes", "-s", "-F", "#{pane_id}"]);
		checks.push({
			name: "tmux server",
			ok: list.ok,
			detail: list.ok ? `${list.stdout.split("\n").filter(Boolean).length} panes` : list.error,
		});
	}

	const piV = await execFileAsync("pi", ["--version"], 5000);
	checks.push({ name: "pi CLI", ok: piV.ok, detail: piV.ok ? piV.stdout : "not found in PATH" });

	const disabled = isDisabled(env);
	checks.push({
		name: "disabled flag",
		ok: !disabled,
		warn: disabled,
		detail: disabled ? "PI_SUBAGENTS_DISABLED=1 or --subagents-disabled" : "enabled",
	});

	const ctx = latestCtx;
	const cwd = opts.cwd ?? ctx?.cwd;
	const config = cwd ? configRef ?? loadConfig({ cwd, projectTrusted: ctx?.isProjectTrusted() ?? false }) : undefined;
	const sources = [globalConfigPath(), cwd ? projectConfigPath(cwd) : undefined].filter(
		(p): p is string => typeof p === "string" && existsSync(p),
	);
	checks.push({
		name: "config",
		ok: !!config,
		detail: config
			? `${sources.length ? sources.join(" + ") : "defaults"} · maxConcurrent=${config.limits.maxConcurrent} · handoff=${config.tmux.handoff} · child.extensions=${config.child.extensions} · shellReadyMs=${config.tmux.shellReadyMs}`
			: "not loaded yet",
	});

	const defs = cwd ? discoverAgents(cwd) : [];
	const bySource = new Map<string, number>();
	for (const d of defs) bySource.set(d.source, (bySource.get(d.source) ?? 0) + 1);
	checks.push({
		name: "agent definitions",
		ok: defs.length > 0,
		warn: defs.length === 0,
		detail: [...bySource.entries()].map(([s, n]) => `${n} ${s}`).join(", ") || "none",
	});

	const sessionFile = ctx?.sessionManager.getSessionFile();
	checks.push({ name: "parent session file", ok: !!sessionFile, detail: sessionFile ?? "not available" });

	if (env.PI_SUBAGENTS_CHILD_ID) {
		checks.push({
			name: "child mode",
			ok: true,
			warn: true,
			detail: `this pi IS a sub-agent (id ${env.PI_SUBAGENTS_CHILD_ID})${env.PI_SUBAGENTS_SPAWNING === "1" ? ", spawning allowed" : ""}`,
		});
	}
	if (env[HANDOFF_GUARD_ENV]) {
		checks.push({ name: "handoff guard", ok: true, detail: "PI_SUBAGENTS_TMUX_HANDOFF=1 (started by a handoff)" });
	}

	return checks;
}

// ── extension entrypoint ──

let piRef: ExtensionAPI | undefined;

export default function subagentsExtension(pi: ExtensionAPI): void {
	piRef = pi;

	// Child sessions never get parent tools (recursion guard) — unless their
	// agent definition opted into recursive spawning (PI_SUBAGENTS_SPAWNING=1,
	// set by the launch script for `spawning: true` agents).
	if (process.env.PI_SUBAGENTS_CHILD_ID && process.env.PI_SUBAGENTS_SPAWNING !== "1") return;

	pi.registerFlag("subagents-disabled", { description: "Disable the subagents extension for this run.", type: "boolean", default: false });

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		refreshConfig();
		startWatch();
		void maybeHandoff(ctx);
	});

	pi.on("session_shutdown", () => {
		if (watchTimer) {
			clearInterval(watchTimer);
			watchTimer = undefined;
		}
		for (const r of [...running.values()]) {
			if (r.finished) continue;
			try {
				void ensureBackend().close(r.surface);
			} catch {}
		}
		running.clear();
	});

	pi.registerTool({
		name: "spawn_agent",
		label: "spawn_agent",
		description:
			"Spawn a sub-agent in a dedicated tmux pane. This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. When the sub-agent finishes, its result is AUTOMATICALLY delivered as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT fabricate, assume, or summarize results after calling this tool. After spawning, either end your turn immediately or work on other independent tasks (including spawning more sub-agents in parallel).",
		promptSnippet:
			"Use spawn_agent for parallelizable sub-tasks (scouting, implementation, review). Spawn multiple at once for parallel work; results arrive automatically as steer messages.",
		promptGuidelines: [
			"Spawn calls are async: never poll, wait, or sleep for a sub-agent result — the harness steers it back automatically.",
			"Do not fabricate or assume sub-agent results; act only on the delivered steer message.",
			"Use agent definitions (agents_list) for model/tools defaults; use fork only when the sub-agent truly needs your conversation context.",
		],
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Display name for the sub-agent (shown in the widget and tmux window)." })),
			task: Type.String({ description: "Task prompt for the sub-agent." }),
			agent: Type.Optional(Type.String({ description: "Agent definition name (loads model/tools/skills defaults from .pi/agents)." })),
			fork: Type.Optional(Type.Boolean({ description: "Force full-context fork mode for this spawn (child starts with your conversation)." })),
			interactive: Type.Optional(
				Type.Boolean({ description: "Mark as interactive: no stall notifications; the user drives the pane." }),
			),
			model: Type.Optional(Type.String({ description: "Model override (provider/id)." })),
			thinking: Type.Optional(Type.String({ description: "Thinking level override (e.g. minimal, medium, high)." })),
			systemPrompt: Type.Optional(Type.String({ description: "Append to the sub-agent system prompt (or set on an agent definition instead)." })),
			skills: Type.Optional(Type.String({ description: "Comma-separated skill names to load in the sub-agent." })),
			tools: Type.Optional(Type.String({ description: "Comma-separated native tool allowlist for the sub-agent." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent (absolute or relative to the project)." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (isDisabledFlag(pi)) {
				return { content: [{ type: "text", text: "Subagents are disabled." }], details: td({ error: "disabled" }) };
			}
			const outcome = await spawnAgentInternal(params as SpawnParams, pi);
			if (!outcome.ok) {
				return {
					content: [{ type: "text", text: `spawn_agent failed: ${outcome.error}` }],
					details: td({ error: outcome.error, code: outcome.code }),
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Sub-agent "${outcome.name}" started (id ${outcome.id}, pane ${outcome.surface}). It runs in its own tmux pane/window. When it finishes, its result is delivered automatically as a steer message — do not poll.`,
					},
				],
				details: td({ status: "started", id: outcome.id, name: outcome.name, sessionFile: outcome.sessionFile, surface: outcome.surface }),
			};
		},

		renderCall(args, theme) {
			const a = args as Partial<SpawnParams>;
			let text = theme.fg("toolTitle", theme.bold("spawn_agent ")) + theme.fg("muted", a.name ?? a.agent ?? "subagent");
			if (a.agent) text += theme.fg("dim", ` (${a.agent})`);
			if (a.fork) text += theme.fg("dim", " [fork]");
			if (a.task) text += `\n${theme.fg("dim", `  ${truncateToWidth(a.task.slice(0, 120), 100)}`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "agents_list",
		label: "agents_list",
		description:
			"List available sub-agent definitions (project .pi/agents/*.md, global ~/.pi/agent/agents/*.md, and bundled planner/scout/worker/reviewer) with their defaults. Read-only discovery tool — call it before spawn_agent when you are unsure which agent fits.",
		parameters: Type.Object({}),
		async execute() {
			const ctx = latestCtx;
			const defs = ctx ? discoverAgents(ctx.cwd) : [];
			if (defs.length === 0) {
				return {
					content: [{ type: "text", text: "No agent definitions found. Spawn without `agent` to use defaults, or create .pi/agents/<name>.md." }],
					details: td({ agents: [] }),
				};
			}
			const lines = defs.map((d) => {
				const bits = [d.name, d.source];
				if (d.model) bits.push(`model: ${d.model}`);
				if (d.thinking) bits.push(`thinking: ${d.thinking}`);
				if (d.sessionMode !== "standalone") bits.push(`session-mode: ${d.sessionMode}`);
				if (d.autoExit) bits.push("auto-exit");
				if (d.spawning) bits.push("spawning");
				const desc = d.description ? ` — ${d.description}` : "";
				return `- ${bits.join(" · ")}${desc}`;
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: td({
					agents: defs.map((d) => ({ name: d.name, source: d.source, model: d.model, sessionMode: d.sessionMode, autoExit: d.autoExit, file: d.file })),
				}),
			};
		},
	});

	pi.registerTool({
		name: "interrupt_agent",
		label: "interrupt_agent",
		description:
			"Send Escape to the active turn of a running sub-agent, cancelling the in-progress model turn. The sub-agent session stays alive (pane, session file, watch loop) and returns to waiting; use resume_agent to continue it.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Exact running sub-agent id (from the spawn_agent result)." })),
			name: Type.Optional(Type.String({ description: "Exact running sub-agent display name." })),
		}),
		async execute(_toolCallId, params) {
			const { id, name } = params as { id?: string; name?: string };
			if (!id && !name) {
				return { content: [{ type: "text", text: "Provide id or name." }], details: td({ error: "missing-target" }) };
			}
			const match = [...running.values()].find((r) => !r.finished && (id ? r.id === id : r.name.toLowerCase() === (name ?? "").toLowerCase()));
			if (!match) {
				const names = [...running.values()].filter((r) => !r.finished).map((r) => `${r.name} (${r.id})`).join(", ") || "(none)";
				return { content: [{ type: "text", text: `No running sub-agent matched. Running: ${names}` }], details: td({ error: "not-found" }) };
			}
			try {
				await ensureBackend().sendEscape(match.surface);
			} catch (err) {
				return { content: [{ type: "text", text: `Interrupt failed: ${(err as Error).message}` }], details: td({ error: (err as Error).message }) };
			}
			match.stallPingSent = false;
			latestCtx?.ui.notify(`subagents: ${match.name} interrupted (turn cancelled)`, "info");
			return { content: [{ type: "text", text: `Interrupted "${match.name}" — its session is still alive and waiting.` }], details: td({ status: "interrupted", id: match.id }) };
		},
	});

	pi.registerTool({
		name: "resume_agent",
		label: "resume_agent",
		description:
			"Resume a previous sub-agent session in a new tmux pane (async). Use when a sub-agent pinged you for help (answer with `message`), or to continue a finished/aborted session from its session file.",
		parameters: Type.Object({
			sessionPath: Type.String({ description: "Path to the sub-agent session .jsonl file (given in the sub-agent result)." }),
			name: Type.Optional(Type.String({ description: "Display name for the resumed pane." })),
			message: Type.Optional(Type.String({ description: "Follow-up instruction sent to the resumed agent (e.g. your answer to its ping)." })),
			autoExit: Type.Optional(
				Type.Boolean({ description: "Auto-exit after the next response (default true for autonomous follow-up; false for interactive handoff)." }),
			),
		}),
		async execute(_toolCallId, params) {
			const { sessionPath, name, message, autoExit } = params as { sessionPath: string; name?: string; message?: string; autoExit?: boolean };
			if (!existsSync(sessionPath)) {
				return { content: [{ type: "text", text: `Session file not found: ${sessionPath}` }], details: td({ error: "no-session-file" }) };
			}
			const ctx = latestCtx;
			if (!ctx) return { content: [{ type: "text", text: "Not ready." }], details: td({ error: "not-ready" }) };

			const cfg = configRef ?? (configRef = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }));
			const liveCount = [...running.values()].filter((x) => !x.finished).length;
			if (liveCount >= cfg.limits.maxConcurrent) {
				return { content: [{ type: "text", text: `Concurrency limit reached (${cfg.limits.maxConcurrent}). Wait for a sub-agent to finish.` }], details: td({ error: "limit" }) };
			}

			// Child cwd comes from the session header.
			let childCwd = ctx.cwd;
			const headerLine = readLinesSafe(sessionPath)[0];
			try {
				const header = JSON.parse(headerLine);
				if (typeof header?.cwd === "string" && existsSync(header.cwd)) childCwd = header.cwd;
			} catch {}

			const id = newId();
			const displayName = name?.trim() || `Resume ${basenameSafe(sessionPath)}`;
			const dir = artifactDir() ?? join(ctx.sessionManager.getSessionDir(), "artifacts");
			mkdirSync(dir, { recursive: true });
			const r: RunningSubagent = {
				id,
				name: displayName,
				task: message ?? "(resumed session)",
				surface: { kind: "pane", target: "" },
				sessionFile: sessionPath,
				activityFile: join(dir, `resume-${id}.activity.json`),
				launchScript: join(dir, `resume-${id}.launch.sh`),
				startTime: Date.now(),
				autoExit: autoExit ?? true,
				interactive: (autoExit ?? true) === false,
				phase: "starting",
				stallPingSent: false,
				finished: false,
			};

			// Reserve the concurrency slot before the first await (see spawn path).
			running.set(id, r);
			startWatch();
			updateWidget();

			let surface;
			try {
				surface = await ensureBackend().createSurface({ name: displayName });
			} catch (err) {
				running.delete(id);
				updateWidget();
				return { content: [{ type: "text", text: `Failed to create tmux surface: ${(err as Error).message}` }], details: td({ error: "surface" }) };
			}
			r.surface = surface;

			const script = buildLaunchScript({
				r,
				def: undefined,
				params: { task: message ?? "" },
				childCwd,
				model: undefined,
				childSessionFile: sessionPath,
				resumeMessage: message,
				autoExit: r.autoExit,
				childExtensions: configRef?.child?.extensions,
			});
			writeFileSync(r.launchScript, script, "utf8");

			try {
				await waitForShellReady(ensureBackend(), surface, configRef?.tmux.shellReadyMs ?? 700);
				await ensureBackend().sendCommand(surface, r.launchScript);
			} catch (err) {
				running.delete(id);
				updateWidget();
				try {
					await ensureBackend().close(surface);
				} catch {}
				return { content: [{ type: "text", text: `Resume failed: ${(err as Error).message}` }], details: td({ error: (err as Error).message }) };
			}
			return {
				content: [{ type: "text", text: `Resumed sub-agent "${displayName}" (id ${id}, pane ${surface.target}). Result arrives automatically as a steer message.` }],
				details: td({ status: "resumed", id, sessionFile: sessionPath }),
			};
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn a sub-agent: /spawn [agent] <task...>",
		async handler(args, ctx) {
			const trimmed = (args ?? "").trim();
			let agent: string | undefined;
			let task: string | undefined;
			if (trimmed) {
				const firstSpace = trimmed.search(/\s/);
				if (firstSpace > 0 && trimmed.slice(firstSpace + 1).trim().length > 0 && trimmed.slice(0, firstSpace).trim()) {
					const first = trimmed.slice(0, firstSpace).trim();
					const rest = trimmed.slice(firstSpace + 1).trim();
					const known = ctx ? discoverAgents(ctx.cwd).some((d) => d.name === first) : false;
					if (known || rest.length === 0) {
						agent = first;
						task = rest;
					} else {
						task = trimmed;
					}
				} else {
					task = trimmed;
				}
			}
			if (!task) {
				const defs = discoverAgents(ctx.cwd);
				if (defs.length > 0) {
					const picked = await ctx.ui.select("Which agent?", defs.map((d) => `${d.name}${d.description ? ` — ${d.description}` : ""}`));
					agent = picked ? picked.split(" — ")[0].trim() : undefined;
				}
				task = await ctx.ui.input("Task for the sub-agent", "e.g. Map the auth module and list entry points");
			}
			if (!task) {
				ctx.ui.notify("subagents: /spawn cancelled", "info");
				return;
			}
			const outcome = await spawnAgentInternal({ task, agent, name: agent ? `Spawn: ${agent}` : undefined }, pi);
			if (outcome.ok) {
				ctx.ui.notify(`subagents: spawned "${outcome.name}" (pane ${outcome.surface})`, "info");
			} else {
				ctx.ui.notify(`subagents: ${outcome.error}`, "error");
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "Subagents utilities: /subagents doctor (environment self-check)",
		async handler(args, ctx) {
			const cmd = (args ?? "").trim().split(/\s+/)[0];
			if (!cmd || cmd === "help") {
				ctx.ui.notify("subagents: usage: /subagents doctor", "info");
				return;
			}
			if (cmd !== "doctor") {
				ctx.ui.notify(`subagents: unknown sub-command "${cmd}" (available: doctor)`, "error");
				return;
			}
			const checks = await collectDoctor();
			const failed = checks.filter((c) => !c.ok).length;
			piRef?.sendMessage({
				customType: REPORT_CUSTOM_TYPE,
				content: `subagents doctor\n${renderDoctorReport(checks)}`,
				display: true,
			});
			ctx.ui.notify(failed === 0 ? "subagents: doctor — all checks passed" : `subagents: doctor — ${failed} problem(s)`, failed === 0 ? "info" : "warning");
		},
	});

	pi.registerCommand("iterate", {
		description: "Spawn a sub-agent with a FORK of the current session (full conversation context): /iterate [agent] <task...>",
		async handler(args, ctx) {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				ctx.ui.notify("subagents: usage: /iterate [agent] <task...>", "info");
				return;
			}
			let agent: string | undefined;
			let task = trimmed;
			const firstSpace = trimmed.search(/\s/);
			if (firstSpace > 0) {
				const first = trimmed.slice(0, firstSpace).trim();
				const rest = trimmed.slice(firstSpace + 1).trim();
				if (first && rest && discoverAgents(ctx.cwd).some((d) => d.name === first)) {
					agent = first;
					task = rest;
				}
			}
			const outcome = await spawnAgentInternal({ task, agent, fork: true, name: "iterate", systemPrompt: ITERATE_PROMPT }, pi);
			if (outcome.ok) {
				ctx.ui.notify(`subagents: iterate spawned "${outcome.name}" (pane ${outcome.surface}) — it sees the full conversation`, "info");
			} else {
				ctx.ui.notify(`subagents: ${outcome.error}`, "error");
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Phased sub-agent workflow (planner → worker → reviewer): /plan <task...>",
		async handler(args, ctx) {
			const task = (args ?? "").trim();
			if (!task) {
				ctx.ui.notify("subagents: usage: /plan <task...>", "info");
				return;
			}
			const phase = (role: "planner" | "worker" | "reviewer") => ({
				agent: resolveAgent(ctx.cwd, role) ? role : undefined,
				hasDef: !!resolveAgent(ctx.cwd, role),
			});
			const p1 = phase("planner");
			const outcome = await spawnAgentInternal(
				{
					task: `Plan (do NOT implement): ${task}`,
					name: "plan: planner",
					agent: p1.agent,
					systemPrompt: p1.hasDef ? undefined : PHASE_FALLBACK_PROMPTS.planner,
				},
				pi,
			);
			if (!outcome.ok) {
				ctx.ui.notify(`subagents: /plan failed at phase 1 (planner): ${outcome.error}`, "error");
				return;
			}
			const p2 = phase("worker");
			const p3 = phase("reviewer");
			const instruction = [
				"Subagents /plan — phased workflow started. Results of each phase arrive automatically as steer messages; do not poll.",
				`Task: ${task}`,
				`Phase 1/3 (planner) is running (pane ${outcome.surface}).`,
				`When the planner result arrives, start phase 2/3 with spawn_agent:`,
				`  name: "plan: worker"${p2.agent ? `\n  agent: "${p2.agent}"` : ""}`,
				`  task: "Implement the plan below for the task: «${task}».\n\nPlan:\n<paste the planner's full summary verbatim here>"`,
				`When the worker result arrives, start phase 3/3 with spawn_agent:`,
				`  name: "plan: reviewer"${p3.agent ? `\n  agent: "${p3.agent}"` : ""}`,
				`  task: "Review the changes made for the task: «${task}». Run the relevant tests if available; report the verdict and remaining risks."`,
				"When the reviewer result arrives, give the user a final summary: what was planned, what was done, the review verdict, and remaining risks.",
			].join("\n");
			pi.sendMessage(
				{
					customType: REPORT_CUSTOM_TYPE,
					content: instruction,
					display: true,
					details: { plan: true, task },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
			ctx.ui.notify(`subagents: /plan started — planner running (pane ${outcome.surface})`, "info");
		},
	});

	pi.registerMessageRenderer(RESULT_CUSTOM_TYPE, (message, { expanded }, theme) => {
		const d = message.details as SubagentResultDetails | undefined;
		if (!d) return new Text(typeof message.content === "string" ? message.content : "", 0, 0);

		const marker = d.status === "done" ? theme.fg("success", "✓") : d.status === "ping" ? theme.fg("warning", "⇠") : theme.fg("error", "✗");
		const title =
			marker +
			" " +
			theme.bold(d.name) +
			" " +
			theme.fg(d.status === "done" ? "success" : "warning", d.status) +
			theme.fg("muted", ` · ${formatElapsedMs(d.elapsedMs)} · exit ${d.exitCode}`);

		if (!expanded) {
			const firstLine = (d.status === "ping" ? d.ping?.message : d.summary ?? d.errorMessage)?.split("\n")[0]?.slice(0, 140);
			return new Text(`${title}${firstLine ? `\n${theme.fg("text", firstLine)}` : ""}\n${theme.fg("dim", "Ctrl+O to expand")}`, 0, 0);
		}

		const lines: string[] = [title, ""];
		if (d.status === "ping") {
			lines.push(theme.fg("warning", `Needs help: ${d.ping?.message ?? ""}`));
		} else {
			lines.push(...(d.summary ?? d.errorMessage ?? "(no output)").split("\n").map((l) => theme.fg("text", l)));
		}
		lines.push("");
		if (d.tokens) {
			const cost = typeof d.costUsd === "number" && d.costUsd > 0 ? ` · $${d.costUsd < 0.01 ? d.costUsd.toFixed(4) : d.costUsd.toFixed(2)}` : "";
			lines.push(theme.fg("dim", `Tokens:   ↑${formatTokens(d.tokens.input)} ↓${formatTokens(d.tokens.output)} (total ${formatTokens(d.tokens.total)})${cost}`));
		}
		lines.push(theme.fg("dim", `Session:  ${d.sessionFile}`));
		lines.push(theme.fg("dim", `Resume:   pi --resume ${d.sessionFile}`));
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerMessageRenderer(REPORT_CUSTOM_TYPE, (message, _env, theme) => {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return new Text(theme.fg("dim", text), 0, 0);
	});
}

function basenameSafe(file: string): string {
	const base = file.split("/").pop() ?? file;
	return base.length > 24 ? `…${base.slice(-24)}` : base;
}
