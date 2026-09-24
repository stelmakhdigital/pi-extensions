/**
 * Configuration loading: defaults < global file < project file < env.
 * Files: ~/.pi/agent/subagents.json and <cwd>/.pi/subagents.json
 * (project file honored only for trusted projects).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface TmuxConfig {
	handoff: "ask" | "auto" | "never";
	sessionName: string;
	sessionCommand: string;
	shellReadyMs: number;
}

export interface SubagentsConfig {
	tmux: TmuxConfig;
	limits: { maxConcurrent: number };
	watch: { intervalMs: number };
	watchdog: { snapshotStaleMs: number };
	widget: { enabled: boolean };
	cleanup: { killSurfaceOnExit: boolean; keepOnError: boolean };
	/** Child environment: "none" (deterministic, recommended) or "all" (user's global extensions). */
	child: { extensions: "none" | "all" };
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	tmux: { handoff: "ask", sessionName: "pi", sessionCommand: "pi -c", shellReadyMs: 700 },
	limits: { maxConcurrent: 6 },
	watch: { intervalMs: 1000 },
	watchdog: { snapshotStaleMs: 30_000 },
	widget: { enabled: true },
	cleanup: { killSurfaceOnExit: true, keepOnError: true },
	child: { extensions: "none" },
};

/** ~/.pi/agent/subagents.json */
export function globalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "subagents.json");
}

/** <cwd>/.pi/subagents.json */
export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "subagents.json");
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function deepMerge(base: SubagentsConfig, overlay: Record<string, unknown>): SubagentsConfig {
	const out: Record<string, unknown> = { ...base };
	const overlayObj = overlay as Record<string, any>;
	for (const key of Object.keys(out)) {
		const section = overlayObj[key];
		if (section && typeof section === "object" && !Array.isArray(section)) {
			out[key] = { ...(out[key] as object), ...section };
		}
	}
	return out as unknown as SubagentsConfig;
}

function toPositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface LoadConfigOptions {
	cwd: string;
	projectTrusted?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Resolve config file paths from explicit locations (testing). */
	globalFile?: string;
	projectFile?: string;
}

export function loadConfig(opts: LoadConfigOptions): SubagentsConfig {
	const env = opts.env ?? process.env;
	let config = { ...DEFAULT_CONFIG };

	const globalFile = opts.globalFile ?? globalConfigPath();
	const globalData = readJsonFile(globalFile);
	if (globalData) config = deepMerge(config, globalData);

	if (opts.projectTrusted) {
		const projectFile = opts.projectFile ?? projectConfigPath(opts.cwd);
		const projectData = readJsonFile(projectFile);
		if (projectData) config = deepMerge(config, projectData);
	}

	// Env overrides.
	const handoff = env.PI_SUBAGENTS_HANDOFF?.toLowerCase();
	if (handoff === "ask" || handoff === "auto" || handoff === "never") {
		config.tmux.handoff = handoff;
	}
	if (env.PI_SUBAGENTS_MAX_CONCURRENT) {
		config.limits.maxConcurrent = toPositiveInt(Number(env.PI_SUBAGENTS_MAX_CONCURRENT), config.limits.maxConcurrent);
	}
	if (env.PI_SUBAGENTS_STALL_MS) {
		config.watchdog.snapshotStaleMs = toPositiveInt(Number(env.PI_SUBAGENTS_STALL_MS), config.watchdog.snapshotStaleMs);
	}
	if (env.PI_SUBAGENTS_SHELL_READY_MS) {
		config.tmux.shellReadyMs = toPositiveInt(Number(env.PI_SUBAGENTS_SHELL_READY_MS), config.tmux.shellReadyMs);
	}

	return config;
}

export function isDisabled(env: NodeJS.ProcessEnv = process.env, flag?: boolean | string): boolean {
	return env.PI_SUBAGENTS_DISABLED === "1" || flag === true || flag === "true";
}

/** Persist a handoff preference into the global config file (best effort). */
export function persistHandoffPreference(handoff: "ask" | "never", filePath?: string): boolean {
	try {
		const path = filePath ?? globalConfigPath();
		const current = readJsonFile(path) ?? {};
		const tmuxSection = (typeof current.tmux === "object" && current.tmux !== null ? current.tmux : {}) as Record<string, unknown>;
		current.tmux = { ...tmuxSection, handoff };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(current, null, "\t")}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Absolute-path check helper (kept here to avoid importing path in tests). */
export function absolutize(maybeRelative: string, base: string): string {
	return isAbsolute(maybeRelative) ? maybeRelative : join(base, maybeRelative);
}
