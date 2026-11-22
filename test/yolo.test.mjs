/**
 * Тест yolo-режима: как включается и что реально выключает.
 * Запуск: node test/yolo.test.mjs
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Изолируем agent dir: guard-state.json не должен трогать реальный ~/.pi/agent.
const guardAgentDir = join(tmpdir(), `pi-yolo-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;

const jiti = createJiti(fileURLToPath(import.meta.url));
const yoloMode = jiti("../extensions/yolo-mode.ts");
const yolo = jiti("../extensions/yolo/index.ts");
const guards = {
	"bash-guard": jiti("../extensions/bash-guard/index.ts"),
	"dir-guard": jiti("../extensions/dir-guard/index.ts"),
	"edit-fresh": jiti("../extensions/edit-fresh/index.ts"),
	"text-guard": jiti("../extensions/text-guard/index.ts"),
	sandbox: jiti("../extensions/sandbox/index.ts"),
};

const results = [];
async function check(name, fn) {
	try {
		rmSync(join(guardAgentDir, "guard-state.json"), { force: true });
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

function makeApi() {
	const api = {
		handlers: {},
		flags: [],
		commands: [],
		getFlag: () => false,
	};
	api.on = (event, fn) => { api.handlers[event] = fn; };
	api.registerCommand = (name, def) => api.commands.push({ name, def });
	api.registerFlag = (name, def) => api.flags.push({ name, def });
	api.registerShortcut = () => {};
	api.registerTool = () => {};
	return api;
}

const noUiCtx = {
	hasUI: false,
	mode: "tui",
	cwd: process.cwd(),
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
	},
};

// Флаг/--yolo и env включаются/выключаются вокруг каждого случая.
function withYolo(on, fn) {
	const savedEnv = process.env.PI_YOLO;
	const savedArgv = process.argv;
	process.argv = ["node", "pi", ...(on ? ["--yolo"] : [])];
	if (on === "env") process.env.PI_YOLO = "1";
	else delete process.env.PI_YOLO;
	try {
		return fn();
	} finally {
		if (savedEnv === undefined) delete process.env.PI_YOLO;
		else process.env.PI_YOLO = savedEnv;
		process.argv = savedArgv;
	}
}

// === 1. isYolo ===
await check("isYolo: PI_YOLO=1", () => {
	if (!yoloMode.isYolo({ PI_YOLO: "1" }, ["node", "pi"])) throw new Error("не распознан");
	if (!yoloMode.isYolo({ PI_YOLO: "TRUE" }, ["node", "pi"])) throw new Error("TRUE не распознан");
});
await check("isYolo: флаг --yolo в argv", () => {
	if (!yoloMode.isYolo({}, ["node", "pi", "--yolo", "задача"])) throw new Error("не распознан");
});
await check("isYolo: --yolo после разделителя -- это текст промпта, не режим", () => {
	if (yoloMode.isYolo({}, ["node", "pi", "-p", "--", "никогда --yolo"])) throw new Error("ложное включение");
});
await check("isYolo: пусто/0 — выключено", () => {
	if (yoloMode.isYolo({}, ["node", "pi"])) throw new Error("включено без причины");
	if (yoloMode.isYolo({ PI_YOLO: "0" }, ["node", "pi"])) throw new Error("PI_YOLO=0 включил режим");
});

// === 2. расширение yolo ===
await check("yolo: флаг зарегистрирован и без режима (для pi --help)", () => {
	const api = withYolo(false, () => { const a = makeApi(); yolo.default(a); return a; });
	if (!api.flags.some((f) => f.name === "yolo")) throw new Error("нет флага yolo");
	if (Object.keys(api.handlers).length !== 0) throw new Error("без режима обработчики не нужны");
});
await check("yolo: project_trust отвечает «доверяем» и не пишет в trust.json", async () => {
	const api = withYolo("env", () => { const a = makeApi(); yolo.default(a); return a; });
	const res = await api.handlers.project_trust({ cwd: process.cwd() }, noUiCtx);
	if (res?.trusted !== "yes") throw new Error("результат: " + JSON.stringify(res));
	if (res.remember) throw new Error("remember не должен ставиться");
});
await check("yolo: PI_YOLO проставляется в окружение процесса (наследуется дочерними pi)", () => {
	withYolo(true, () => yolo.default(makeApi()));
});
await check("yolo: session_start не падает без UI", async () => {
	const api = withYolo("env", () => { const a = makeApi(); yolo.default(a); return a; });
	await api.handlers.session_start({ reason: "startup" }, noUiCtx);
});

// === 3. guard'ы в yolo ничего не регистрируют ===
for (const [name, ext] of Object.entries(guards)) {
	await check(`${name}: в yolo нет ни обработчиков, ни флагов, ни команд`, () => {
		const api = withYolo("env", () => { const a = makeApi(); ext.default(a); return a; });
		const n = Object.keys(api.handlers).length + api.flags.length + api.commands.length;
		if (n !== 0) throw new Error(`зарегистрировано ${n}: ` + JSON.stringify({ h: Object.keys(api.handlers), f: api.flags.map((x) => x.name), c: api.commands.map((x) => x.name) }));
	});
	await check(`${name}: без режима работает как раньше`, () => {
		const api = withYolo(false, () => { const a = makeApi(); ext.default(a); return a; });
		if (Object.keys(api.handlers).length === 0) throw new Error("ни одного обработчика — режим случайно включён?");
	});
}

// === 4. bash-guard в yolo пропускает то, что обычно блокирует ===
await check("bash-guard: в yolo проходит и «пол» (sudo rm -rf /)", async () => {
	const api = withYolo("env", () => { const a = makeApi(); guards["bash-guard"].default(a); return a; });
	if (api.handlers.tool_call) throw new Error("tool_call зарегистрирован");
});
await check("bash-guard: без режима «пол» блокирует", async () => {
	const api = withYolo(false, () => { const a = makeApi(); guards["bash-guard"].default(a); return a; });
	const res = await api.handlers.tool_call({ toolName: "bash", input: { command: "sudo rm -rf /" } }, noUiCtx);
	if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
});

const failed = results.filter((r) => r.startsWith("FAIL"));
for (const r of results) console.log(r);
rmSync(guardAgentDir, { recursive: true, force: true });
if (failed.length) {
	console.log(`\n${failed.length} из ${results.length} не прошли`);
	process.exit(1);
}
console.log(`\n${results.length} проверок прошли`);
