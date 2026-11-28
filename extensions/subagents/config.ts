/**
 * Configuration loading: defaults < global file < project file < env.
 * Files: ~/.pi/agent/subagents.json and <cwd>/.pi/subagents.json
 * (project file honored only for trusted projects).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { readJson } from "../json-store.ts";

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
	watchdog: { snapshotStaleMs: number; stallRepingTicks: number };
	widget: { enabled: boolean };
	cleanup: { killSurfaceOnExit: boolean; keepOnError: boolean };
	/** Child environment: "none" (deterministic, recommended) or "all" (user's global extensions). */
	child: { extensions: "none" | "all" };
}

export const DEFAULT_CONFIG: SubagentsConfig = {
	tmux: { handoff: "ask", sessionName: "pi", sessionCommand: "pi -c", shellReadyMs: 700 },
	limits: { maxConcurrent: 6 },
	watch: { intervalMs: 1000 },
	watchdog: { snapshotStaleMs: 30_000, stallRepingTicks: 30 },
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
	const parsed = readJson<Record<string, unknown>>(path);
	return parsed && typeof parsed === "object" ? parsed : undefined;
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
	// Глубокая копия: без неё env-оверрайды (`config.tmux.handoff = …`) дописывали
	// бы значения в сам DEFAULT_CONFIG, и следующий loadConfig в этом же процессе
	// (refreshConfig, тесты) стартовал бы с чужими числами.
	let config = structuredClone(DEFAULT_CONFIG);

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
	if (env.PI_SUBAGENTS_STALL_REPING_TICKS) {
		const n = Number(env.PI_SUBAGENTS_STALL_REPING_TICKS);
		// 0 is a valid value (disable reping), so parse directly.
		if (Number.isFinite(n) && n >= 0) config.watchdog.stallRepingTicks = Math.floor(n);
	}
	if (env.PI_SUBAGENTS_SHELL_READY_MS) {
		config.tmux.shellReadyMs = toPositiveInt(Number(env.PI_SUBAGENTS_SHELL_READY_MS), config.tmux.shellReadyMs);
	}

	// Числа из файлов проходят как пришли, а env-ветки выше меняют их только если
	// переменная задана. `intervalMs: 0` → setInterval с нулём, то есть hot loop на
	// `execFileSync tmux list-panes` + чтении файлов каждый тик; `maxConcurrent: 0`
	// отказывает каждому спавну с видом будто лимит настоящий. stallRepingTicks не
	// трогаем: там 0 осмысленное «выкл».
	config.tmux.shellReadyMs = toPositiveInt(config.tmux.shellReadyMs, DEFAULT_CONFIG.tmux.shellReadyMs);
	config.limits.maxConcurrent = toPositiveInt(config.limits.maxConcurrent, DEFAULT_CONFIG.limits.maxConcurrent);
	config.watch.intervalMs = toPositiveInt(config.watch.intervalMs, DEFAULT_CONFIG.watch.intervalMs);
	config.watchdog.snapshotStaleMs = toPositiveInt(config.watchdog.snapshotStaleMs, DEFAULT_CONFIG.watchdog.snapshotStaleMs);

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
