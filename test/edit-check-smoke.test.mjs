/**
 * Смоук-тест edit-check: jiti + стаб ExtensionAPI, реальный дочерний процесс.
 * Запуск: node test/edit-check-smoke.test.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

const guardAgentDir = join(tmpdir(), `pi-edit-check-state-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;
mkdirSync(guardAgentDir, { recursive: true });

const jiti = createJiti(fileURLToPath(import.meta.url));
const editCheck = jiti("../extensions/edit-check/index.ts");

const root = join(tmpdir(), `pi-edit-check-cwd-${process.pid}`);
mkdirSync(root, { recursive: true });

/** Проект с командой проверки, которая всегда падает / всегда проходит. */
function project(name, cmd) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	if (cmd === null) return dir; // команда не настроена, tsconfig нет
	writeFileSync(join(dir, ".edit-check.json"), JSON.stringify({ cmd, max: 5 }));
	return dir;
}
const FAILS = project("fails", "node -e \"console.log('a.ts(3,7): error TS2345: Type 'x' is not assignable'); process.exit(2)\"");
const PASSES = project("passes", "node -e \"console.log('ok'); \"");
const NOCMD = project("nocmd", null);

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

function load(mode = "on") {
	writeFileSync(
		join(guardAgentDir, "guard-state.json"),
		JSON.stringify({ "edit-check": { enabled: mode === "on" } }),
	);
	const sent = [];
	const notes = [];
	const statuses = {};
	const handlers = {};
	const commands = {};
	const pi = {
		handlers,
		sent,
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		registerFlag: () => {},
		getFlag: () => false,
		sendMessage: (msg, opts) => sent.push({ msg, opts }),
	};
	editCheck.default(pi);
	return {
		pi,
		handlers,
		commands,
		sent,
		notes,
		statuses,
		ctx: (cwd) => ({
			cwd,
			hasUI: true,
			mode: "tui",
			ui: {
				setStatus: (key, text) => {
					statuses[key] = text;
				},
				notify: (m, kind) => notes.push({ m, kind }),
				theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
			},
			sessionManager: { buildSessionContext: () => ({ messages: [] }) },
		}),
	};
}

const edited = (handlers) => handlers.tool_result({ toolName: "edit", toolCallId: "c1", input: { path: "a.ts" }, isError: false });

await check("правка + падающая проверка: ошибки уходят модели, прогон продолжается", async () => {
	const h = load();
	const ctx = h.ctx(FAILS);
	await h.handlers.session_start({ reason: "startup" }, ctx);
	await edited(h.handlers);
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 1, "сообщений не отправлено: " + h.sent.length);
	assert(/TS2345/.test(h.sent[0].msg.content), "нет текста ошибки: " + h.sent[0].msg.content);
	assert(h.sent[0].opts?.triggerTurn === true, "прогон не продолжается: " + JSON.stringify(h.sent[0].opts));
	assert(/✗ 1\/3/.test(h.statuses[" a-edit-check"] ?? ""), "бейдж: " + h.statuses[" a-edit-check"]);
});

await check("без правок проверка не запускается", async () => {
	const h = load();
	const ctx = h.ctx(FAILS);
	await h.handlers.session_start({ reason: "startup" }, ctx);
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 0 && h.statuses[" a-edit-check"] === undefined, "реакция на чистый прогон");
});

await check("неудачный edit не помечает дерево грязным", async () => {
	const h = load();
	const ctx = h.ctx(FAILS);
	await h.handlers.tool_result({ toolName: "edit", toolCallId: "c1", input: { path: "a.ts" }, isError: true });
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 0, "отреагировал на неудачную правку");
});

await check("чистая проверка: сообщения нет, бейдж снят", async () => {
	const h = load();
	const ctx = h.ctx(PASSES);
	await edited(h.handlers);
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 0, "сообщение о чистом проекте: " + JSON.stringify(h.sent));
	assert(h.statuses[" a-edit-check"] === undefined, "бейдж остался: " + h.statuses[" a-edit-check"]);
});

await check("после MAX_REPORTS моделей не долбим — предупреждение пользователю", async () => {
	const h = load();
	const ctx = h.ctx(FAILS);
	for (let i = 0; i < 4; i++) {
		await edited(h.handlers);
		await h.handlers.agent_settled({}, ctx);
	}
	assert(h.sent.length === 3, "сообщений: " + h.sent.length);
	assert(h.notes.some((n) => n.kind === "warning"), "нет предупреждения: " + JSON.stringify(h.notes));
});

await check("/edit-check запускает проверку вручную", async () => {
	const h = load();
	const ctx = h.ctx(FAILS);
	await h.commands["edit-check"].handler("", ctx);
	assert(h.sent.length === 0, "ручной запуск отправил сообщение модели");
	assert(h.notes.some((n) => n.kind === "error" && /TS2345/.test(n.m)), "нет уведомления с ошибкой: " + JSON.stringify(h.notes));

	const ok = load();
	await ok.commands["edit-check"].handler("", ok.ctx(PASSES));
	assert(ok.notes.some((n) => /чисто/.test(n.m)), "нет ответа об успехе: " + JSON.stringify(ok.notes));
});

await check("/edit-check off запоминается и глушит проверку", async () => {
	const h = load("off");
	const ctx = h.ctx(FAILS);
	await edited(h.handlers);
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 0, "проверка работает при off");
	await h.commands["edit-check"].handler("on", ctx);
	await edited(h.handlers);
	await h.handlers.agent_settled({}, ctx);
	assert(h.sent.length === 1, "on не включил проверку: " + h.sent.length);
});

await check("проекту нечего проверять — тихо", async () => {
	const h = load();
	const ctx = h.ctx(NOCMD);
	await edited(h.handlers);
	await h.handlers.agent_settled({}, ctx);
	await h.commands["edit-check"].handler("", ctx);
	assert(h.sent.length === 0 && h.notes.length === 0 && h.statuses[" a-edit-check"] === undefined, "шум без команды");
});

rmSync(root, { recursive: true, force: true });
rmSync(guardAgentDir, { recursive: true, force: true });
console.log(results.join("\n"));
process.exit(results.filter((r) => r.startsWith("FAIL")).length ? 1 : 0);
