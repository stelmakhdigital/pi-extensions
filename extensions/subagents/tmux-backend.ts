/**
 * tmux backend for subagent surfaces.
 *
 * Every interaction with tmux goes through a single runner (execFileSync by
 * default) so tests can assert the exact command-line arrays without touching
 * a real server.
 */
import { execFileSync } from "node:child_process";
import { MuxBackend } from "./types.ts";

export type TmuxRunner = (args: string[]) => string;

export interface TmuxBackendOptions {
	/** Injectable tmux executor (testing). Defaults to execFileSync("tmux", ...). */
	runner?: TmuxRunner;
	/** Pane to split from. Defaults to $TMUX_PANE (the pane this pi runs in). */
	sourcePane?: string;
	env?: NodeJS.ProcessEnv;
}

export function createTmuxBackend(options: TmuxBackendOptions = {}): MuxBackend {
	const env = options.env ?? process.env;
	const sourcePane = options.sourcePane ?? env.TMUX_PANE ?? "";
	const runner: TmuxRunner =
		options.runner ??
		((args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

	function tmux(...args: string[]): string {
		return runner(args).trim();
	}

	const id = "tmux";

	return {
		id,

		async probe() {
			if (!env.TMUX) return { ok: false, detail: "pi is not running inside tmux" };
			try {
				tmux("list-sessions");
				return { ok: true };
			} catch (err) {
				return { ok: false, detail: `tmux unavailable: ${(err as Error).message}` };
			}
		},

		async createSurface({ name }) {
			if (!env.TMUX || !sourcePane) {
				throw new Error(
					"Subagents require pi to run inside tmux. Start pi with: tmux new -A -s pi 'pi'",
				);
			}
			const out = tmux(
				"split-window",
				"-d",
				"-h",
				"-t",
				sourcePane,
				"-P",
				"-F",
				"#{window_id} #{pane_id}",
			);
			const [windowId, paneId] = out.split(" ");
			if (!windowId?.startsWith("@") || !paneId?.startsWith("%")) {
				throw new Error(`Unexpected tmux split-window output: ${out}`);
			}
			try {
				tmux("rename-window", "-t", windowId, name);
			} catch {
				// Cosmetic; surface is usable regardless.
			}
			return { kind: "pane", target: paneId };
		},

		async sendCommand(surface, scriptPath) {
			// Launch is always a pre-built script file: zero shell quoting,
			// and the artifact remains on disk for debugging.
			tmux("send-keys", "-t", surface.target, "-l", `bash ${scriptPath}`);
			tmux("send-keys", "-t", surface.target, "Enter");
		},

		async sendEscape(surface) {
			tmux("send-keys", "-t", surface.target, "Escape");
		},

		async isAlive(surface) {
			try {
				tmux("list-panes", "-t", surface.target, "-F", "#{pane_id}");
				return true;
			} catch {
				return false;
			}
		},

		async captureTail(surface, lines = 10) {
			try {
				return tmux("capture-pane", "-p", "-t", surface.target, "-S", `-${lines}`);
			} catch {
				return "";
			}
		},

		async rename(surface, title) {
			try {
				const windowId = tmux("display-message", "-p", "-t", surface.target, "#{window_id}");
				tmux("rename-window", "-t", windowId, title);
			} catch {
				// Cosmetic.
			}
		},

		async close(surface) {
			try {
				if (surface.kind === "pane") {
					tmux("kill-pane", "-t", surface.target);
				} else {
					tmux("kill-window", "-t", surface.target);
				}
			} catch {
				// Already gone.
			}
		},

		async batchStatus(surfaces) {
			const result = new Map<string, boolean>();
			let alive: Set<string> = new Set();
			try {
				const out = tmux("list-panes", "-s", "-F", "#{pane_id}");
				alive = new Set(out.split("\n").filter(Boolean));
			} catch {
				alive = new Set();
			}
			for (const surface of surfaces) {
				if (surface.kind === "pane") {
					result.set(surface.target, alive.has(surface.target));
				} else {
					// Windows: fall back to a per-surface check (rare in v1).
					result.set(surface.target, await this.isAlive(surface));
				}
			}
			return result;
		},
	};
}
