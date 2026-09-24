/**
 * Agent definition discovery: project `.pi/agents/*.md` > global
 * `~/.pi/agent/agents/*.md`. File body is the role/system prompt; frontmatter
 * carries defaults (subset supported in v1 — see AgentDefinition).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { AgentDefinition, SessionMode } from "./types.ts";

/** Parent-side tools a child must never see unless the agent opts in via `spawning: true`. */
export const PARENT_TOOLS = "spawn_agent,agents_list,interrupt_agent,resume_agent";

export type AgentSource = "project" | "global" | "bundled";

export function projectAgentsDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "agents");
}

export function globalAgentsDir(): string {
	return join(homedir(), ".pi", "agent", "agents");
}

/** Bundled agents shipped with the extension (lowest priority). */
export function bundledAgentsDir(): string {
	return fileURLToPath(new URL("./agents", import.meta.url));
}

/** Minimal frontmatter parser: `key: value` lines between --- markers. */
export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const data: Record<string, string> = {};
	let body = content;
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx <= 0) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
			if (key) data[key] = value;
		}
		body = content.slice(match[0].length);
	}
	return { data, body: body.trim() };
}

function parseSessionMode(value: string | undefined): SessionMode {
	if (value === "lineage-only" || value === "lineage") return "lineage";
	if (value === "fork") return "fork";
	return "standalone";
}

function parseBoolean(value: string | undefined): boolean {
	return value === "true" || value === "1";
}

export function parseAgentDefinition(content: string, fallbackName: string, source: AgentSource, file: string): AgentDefinition {
	const { data, body } = parseFrontmatter(content);
	const name = data.name?.trim() || fallbackName;
	return {
		name,
		description: data.description?.trim() || undefined,
		body,
		model: data.model?.trim() || undefined,
		thinking: data.thinking?.trim() || undefined,
		tools: data.tools?.trim() || undefined,
		skills: data.skills?.trim() || undefined,
		sessionMode: parseSessionMode(data["session-mode"]),
		autoExit: parseBoolean(data["auto-exit"]),
		interactive: data.interactive === undefined ? !parseBoolean(data["auto-exit"]) : parseBoolean(data.interactive),
		cwd: data.cwd?.trim() || undefined,
		denyTools: data["deny-tools"]?.trim() || undefined,
		spawning: parseBoolean(data.spawning),
		source,
		file,
	};
}

function readDirAgents(dir: string, source: AgentSource): Map<string, AgentDefinition> {
	const out = new Map<string, AgentDefinition>();
	if (!existsSync(dir)) return out;
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const file = join(dir, entry);
		try {
			if (!statSync(file).isFile()) continue;
			const def = parseAgentDefinition(readFileSync(file, "utf8"), entry.replace(/\.md$/, ""), source, file);
			out.set(def.name, def);
		} catch {
			// Skip unreadable files.
		}
	}
	return out;
}

/** Project definitions shadow global, global shadows bundled. */
export function discoverAgents(cwd: string, opts: { projectDir?: string; globalDir?: string; bundledDir?: string } = {}): AgentDefinition[] {
	const projectDir = opts.projectDir ?? projectAgentsDir(cwd);
	const globalDir = opts.globalDir ?? globalAgentsDir();
	const bundledDir = opts.bundledDir ?? bundledAgentsDir();
	const merged = new Map<string, AgentDefinition>();
	for (const [name, def] of readDirAgents(bundledDir, "bundled")) merged.set(name, def);
	for (const [name, def] of readDirAgents(globalDir, "global")) merged.set(name, def);
	for (const [name, def] of readDirAgents(projectDir, "project")) merged.set(name, def);
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveAgent(cwd: string, name: string | undefined, opts?: { projectDir?: string; globalDir?: string; bundledDir?: string }): AgentDefinition | undefined {
	if (!name) return undefined;
	return discoverAgents(cwd, opts).find((def) => def.name === name);
}

/**
 * Effective --tools allowlist for the child. Extension tools are covered by
 * --tools as well, so child tools must be listed explicitly; spawning agents
 * additionally get the parent-side tools back.
 */
export function buildChildToolAllowlist(
	def: AgentDefinition | undefined,
	override?: string,
	opts: { spawning?: boolean } = {},
): string | undefined {
	const list = (override ?? def?.tools ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (list.length === 0) {
		// No allowlist: nothing is restricted. Spawning is controlled by the
		// --exclude-tools path, so do NOT synthesize a --tools list here —
		// that would strip all native tools from a spawning child.
		return undefined;
	}
	if (opts.spawning) list.push(...PARENT_TOOLS.split(","));
	const withChildTools = [...new Set([...list, "agent_done", "agent_ping"])];
	return withChildTools.join(",");
}

/** Resolve the child working directory (agent default or tool override). */
export function resolveChildCwd(
	def: AgentDefinition | undefined,
	overrideCwd: string | undefined,
	parentCwd: string,
): string {
	const raw = overrideCwd ?? def?.cwd;
	if (!raw) return parentCwd;
	return resolve(parentCwd, raw);
}

/** Effective session mode: spawn-level fork override wins, then agent default. */
export function resolveSessionMode(def: AgentDefinition | undefined, forkOverride?: boolean): SessionMode {
	if (forkOverride) return "fork";
	return def?.sessionMode ?? "standalone";
}
