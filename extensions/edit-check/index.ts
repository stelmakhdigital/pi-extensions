/**
 * edit-check: проверка типов/линта после правок, чтобы модель узнала, что сломала код.
 *
 * Мотивация: edit-fresh ловит «правку по устаревшему read», но если oldText
 * совпал, а правка сломала типы — инструмент отдаёт успех, и модель рапортует
 * «готово» с красным проектом. LSP-обвязка (pi-lens) это решает на каждом
 * редактировании, но это отдельный большой слой. Здесь — дешёвая версия: одна
 * проверка в конце прогона.
 *
 * Механика:
 * - tool_result(edit|write) без ошибки → помечаем «грязно»;
 * - agent_settled (гонка дошла до конца) → если грязно, запускаем команду
 *   проекта и ждём её (loader остаётся, в футере — «проверяю…»);
 * - ненулевой exit → первые N строк вывода уходит модели сообщением
 *   (`triggerTurn`), то есть прогон не завершается со сломанным кодом молча;
 * - после MAX_REPORTS ответов подряд цикл обрывается и остаётся предупреждение
 *   в футере: дальше решает пользователь.
 *
 * Команда берётся из (первое совпадение): `.edit-check.json` `{ "cmd": ... }` →
 * scripts проекта `typecheck` / `type-check` / `check-types` / `tsc` →
 * `npx tsc --noEmit`, если рядом есть tsconfig.json. Команды нет → расширение
 * молча не работает (бейджа нет: шуметь в JS-скриптах незачем).
 *
 * Режим в guard-state.json (`/edit-check`), персистентен. В yolo работает:
 * сообщение с ошибкой как раз то, чего в автономном прогоне не хватало.
 */

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadGuard, saveGuard, shouldResetGuards } from "../guard-state.ts";
import { readJson } from "../json-store.ts";

const STATUS_KEY = " a-edit-check";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_REPORTS = 3;
const MAX_LINES = 25;

type Check = { cmd: string; cwd: string; timeoutMs: number; max: number };

/** Команда проверки или undefined, если проекту нечего проверять. */
function resolveCheck(cwd: string): Check | undefined {
	const cfg = readJson<Record<string, unknown>>(path.join(cwd, ".edit-check.json")) ?? {};
	const max = typeof cfg.max === "number" && cfg.max > 0 ? cfg.max : 10;
	const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
	const scripts = (readJson<{ scripts?: Record<string, string> }>(path.join(cwd, "package.json"))?.scripts ?? {});
	const fromCfg = typeof cfg.cmd === "string" && cfg.cmd.trim() ? cfg.cmd.trim() : undefined;
	const npmScript = ["typecheck", "type-check", "check-types", "tsc"].find((s) => typeof scripts[s] === "string");
	let cmd = fromCfg ?? (npmScript ? `npm run ${npmScript}` : undefined);
	if (!cmd) {
		// Только tsconfig в самом cwd и только если рядом есть запускаемый tsc (`npx
		// --no-install` ищет бинарь в node_modules/.bin вверх по дереву). Поиск
		// tsconfig'а на 4 уровня вверх находил корень монорепа, а `tsc` в пакете без
		// своего typescript не запускался и завершался с кодом 1 и шуточным баннером —
		// модель ловила три раунда «проверка упала» ни за что. Нет команды — молчим.
		const hasLocalTsc = (dir: string, depth: number): boolean =>
			fs.existsSync(path.join(dir, "node_modules", ".bin", "tsc")) ||
			(depth < 4 && dir !== path.dirname(dir) && hasLocalTsc(path.dirname(dir), depth + 1));
		if (fs.existsSync(path.join(cwd, "tsconfig.json")) && hasLocalTsc(cwd, 0)) cmd = "npx --no-install tsc --noEmit";
	}
	return cmd ? { cmd, cwd, timeoutMs, max } : undefined;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Вывод проверки → строки для модели: сначала строки ошибок, иначе весь вывод. */
function findings(out: string, cmd: string, max: number): string[] {
	const lines = out.replace(ANSI_RE, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
	const err = lines.filter((l) => /\berror\b|✖|Found \d+ error|^\s+\d+:(error|warning)/i.test(l));
	const src = err.length ? err : lines;
	const picked = src.slice(0, max);
	const rest = src.length - picked.length;
	return rest > 0 ? [...picked, `… ещё ${rest} строк — запусти \`${cmd}\` сам`] : picked;
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, { cwd, shell: true, env: process.env });
		let out = "";
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const collect = (chunk: Buffer) => {
			if (out.length < 200_000) out += chunk.toString("utf8");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 127, out: `${cmd}: ${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: killed ? 124 : (code ?? 0), out: killed ? `${cmd}: превышен таймаут ${timeoutMs} мс` : out });
		});
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = loadGuard("edit-check").enabled !== false;
	let dirty = false;
	let reports = 0;
	let running = false;

	const badge = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	};
	const failBadge = (ctx: ExtensionContext, text: string) =>
		badge(ctx, ctx.ui.theme.bg("toolErrorBg", ctx.ui.theme.bold(ctx.ui.theme.fg("error", ` ${text} `))));

	const onToolResult = async (event: ToolResultEvent) => {
		if (!enabled || event.isError) return;
		if (event.toolName === "edit" || event.toolName === "write") dirty = true;
	};

	const check = async (ctx: ExtensionContext, why: "settle" | "manual") => {
		if (!enabled || running) return;
		const cfg = resolveCheck(ctx.cwd || process.cwd());
		if (!cfg) return;
		running = true;
		badge(ctx, ctx.ui.theme.fg("dim", " check…"));
		let res: { code: number; out: string };
		try {
			res = await run(cfg.cmd, cfg.cwd, cfg.timeoutMs);
		} finally {
			running = false;
		}
		if (res.code === 0) {
			dirty = false;
			reports = 0;
			badge(ctx, undefined);
			if (why === "manual") ctx.ui.notify(`edit-check: чисто (${cfg.cmd})`, "info");
			return;
		}
		const header = `edit-check: \`${cfg.cmd}\` завершился с кодом ${res.code}`;
		const lines = findings(res.out, cfg.cmd, cfg.max);
		if (why === "manual") {
			failBadge(ctx, "✗ проверки не проходят");
			ctx.ui.notify([header, ...lines].join("\n"), "error");
			return;
		}
		if (reports >= MAX_REPORTS) {
			failBadge(ctx, "⚠ проверки не проходят");
			ctx.ui.notify(`${header} — модель уже получала эти ошибки ${MAX_REPORTS} раза, дальше не стучим.`, "warning");
			// Снимаем «грязно»: иначе каждый следующий прогон заново гоняет команду
			// (полный typecheck, до таймаута) только ради этой же строки.
			dirty = false;
			return;
		}
		reports++;
		badge(ctx, ctx.ui.theme.fg("error", ` ✗ ${reports}/${MAX_REPORTS} `));
		// Прогон не должен завершаться «готово» со сломанным кодом: ошибки уходят
		// модели, и triggerTurn даёт ей шанс их починить.
		pi.sendMessage(
			{
				customType: "edit-check",
				content: `${header} (в этом прогоне правили файлы, попытка ${reports}/${MAX_REPORTS}). Почини и проверь:\n${lines.join("\n")}`,
				display: true,
				details: { cmd: cfg.cmd, code: res.code, attempts: reports },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	pi.on("session_start", async (event, ctx) => {
		dirty = false;
		reports = 0;
		badge(ctx, undefined);
		if (shouldResetGuards(event, ctx as unknown as Parameters<typeof shouldResetGuards>[1])) {
			enabled = true;
			saveGuard("edit-check", { enabled });
		}
	});

	pi.on("tool_result", onToolResult);

	pi.on("agent_settled", async (_event, ctx) => {
		if (!dirty) return;
		await check(ctx, "settle");
	});

	// Проверка в конце прогона (agent_settled) покрывает и последние правки: она
	// вызывается на каждой завершённой гонке. Здесь лишь снимаем бейдж.
	pi.on("session_shutdown", async (_event, ctx) => {
		badge(ctx, undefined);
	});

	pi.registerCommand("edit-check", {
		description: "Проверить типы/линт сейчас (/edit-check) или выключить расширение (/edit-check off).",
		async handler(args, ctx) {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				saveGuard("edit-check", { enabled });
				badge(ctx, undefined);
				ctx.ui.notify(enabled ? "edit-check: включён (запомнено)" : "edit-check: выключен (запомнено)", "info");
				return;
			}
			dirty = false;
			await check(ctx, "manual");
		},
	});
}
