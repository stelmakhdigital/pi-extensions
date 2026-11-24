/**
 * Тест yolo-режима: как включается (env, argv, команда /yolo) и что реально
 * выключает в момент вызова инструмента.
 * Запуск: node test/yolo.test.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
	const savedEnv = process.env.PI_YOLO;
	try {
		rmSync(join(guardAgentDir, "guard-state.json"), { force: true });
		yoloMode.resetYolo();
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	} finally {
		yoloMode.resetYolo();
		if (savedEnv === undefined) delete process.env.PI_YOLO;
		else process.env.PI_YOLO = savedEnv;
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

function makeCtx(cwd = process.cwd(), extra = {}) {
	return {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
			...extra,
		},
	};
}
const noUiCtx = makeCtx(process.cwd(), {});
noUiCtx.hasUI = false;

// Загрузка расширения с заданным СТАРТОВЫМ состоянием режима.
function loadWith(ext, startOn) {
	const savedEnv = process.env.PI_YOLO;
	const savedArgv = process.argv;
	process.argv = ["node", "pi", ...(startOn ? ["--yolo"] : [])];
	if (startOn) process.env.PI_YOLO = "1";
	else delete process.env.PI_YOLO;
	try {
		const api = makeApi();
		ext.default(api);
		return api;
	} finally {
		if (savedEnv === undefined) delete process.env.PI_YOLO;
		else process.env.PI_YOLO = savedEnv;
		process.argv = savedArgv;
	}
}

const command = (api, name) => api.commands.find((c) => c.name === name)?.def;

// То же, но с сохранённым стартовым состоянием на время проверок: обработчики
// спрашивают isYolo() в момент вызова, а не при загрузке расширения.
// Состояние задаётся флагом (без env) — тогда видно, что расширение само
// нормализует `--yolo` в PI_YOLO для дочерних процессов.
async function withStart(on, fn) {
	const savedEnv = process.env.PI_YOLO;
	const savedArgv = process.argv;
	process.argv = ["node", "pi", ...(on ? ["--yolo"] : [])];
	delete process.env.PI_YOLO;
	try {
		const api = makeApi();
		yolo.default(api);
		await fn(api);
	} finally {
		if (savedEnv === undefined) delete process.env.PI_YOLO;
		else process.env.PI_YOLO = savedEnv;
		process.argv = savedArgv;
	}
}

// Фикстура «вне рабочей директории»: HOME не входит в дефолтный allowlist
// dir-guard (разрешён только ~/.pi), /var/tmp — чтобы cwd не лежал в /tmp.
const cwd = join("/var/tmp", `pi-yolo-test-${process.pid}`);
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "x");

// === 1. isYolo: стартовые способы ===
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

// === 2. рантайм-переключатель setYolo ===
await check("setYolo: перекрывает --yolo в argv (выключить посреди сессии)", () => {
	const savedArgv = process.argv;
	process.argv = ["node", "pi", "--yolo"];
	try {
		if (!yoloMode.isYolo()) throw new Error("ожидался режим из argv");
		yoloMode.setYolo(false);
		if (yoloMode.isYolo()) throw new Error("выключить не удалось");
		if (process.env.PI_YOLO !== "0") throw new Error("дочерние pi унаследовали бы режим: " + process.env.PI_YOLO);
	} finally {
		process.argv = savedArgv;
	}
});
await check("setYolo(true): включает без env и argv, дети наследуют PI_YOLO=1", () => {
	if (yoloMode.isYolo({}, ["node", "pi"])) throw new Error("включено без причины");
	yoloMode.setYolo(true);
	if (!yoloMode.isYolo({}, ["node", "pi"])) throw new Error("включить не удалось");
	if (process.env.PI_YOLO !== "1") throw new Error("env не синхронизирован: " + process.env.PI_YOLO);
});
await check("onYoloChange: подписчик получает каждое переключение", () => {
	const seen = [];
	yoloMode.onYoloChange((on) => seen.push(on));
	yoloMode.setYolo(true);
	yoloMode.setYolo(false);
	if (seen.join(",") !== "true,false") throw new Error("события: " + JSON.stringify(seen));
});

// === 3. расширение yolo ===
await check("yolo: флаг и команда /yolo зарегистрированы всегда", () => {
	const api = loadWith(yolo, false);
	if (!api.flags.some((f) => f.name === "yolo")) throw new Error("нет флага yolo");
	if (!command(api, "yolo")) throw new Error("нет команды /yolo");
});
await check("yolo: project_trust отвечает «доверяем» и не пишет в trust.json", async () => {
	await withStart(true, async (api) => {
		const res = await api.handlers.project_trust({ cwd }, noUiCtx);
		if (res?.trusted !== "yes") throw new Error("результат: " + JSON.stringify(res));
		if (res.remember) throw new Error("remember не должен ставиться");
	});
});
await check("yolo: без режима project_trust отдаёт решение дальше", async () => {
	const api = loadWith(yolo, false);
	const res = await api.handlers.project_trust({ cwd }, noUiCtx);
	if (res?.trusted !== "undecided") throw new Error("результат: " + JSON.stringify(res));
});
await check("yolo: флаг --yolo нормализуется в PI_YOLO (дочерние pi наследуют режим)", async () => {
	await withStart(true, async () => {
		if (process.env.PI_YOLO !== "1") throw new Error("env не синхронизирован: " + process.env.PI_YOLO);
	});
});
await check("yolo: session_start не падает без UI", async () => {
	await withStart(true, async (api) => {
		await api.handlers.session_start({ reason: "startup" }, noUiCtx);
	});
});
await check("/yolo: команда переключает режим в обе стороны", async () => {
	const api = loadWith(yolo, false);
	const handler = command(api, "yolo").handler;
	await handler("", makeCtx(cwd));
	if (!yoloMode.isYolo()) throw new Error("первый вызов не включил режим");
	await handler("", makeCtx(cwd));
	if (yoloMode.isYolo()) throw new Error("второй вызов не выключил режим");
});

// === 4. guard'ы: регистрация не зависит от режима, блокировка — зависит ===
for (const [name, ext] of Object.entries(guards)) {
	await check(`${name}: обработчики зарегистрированы и в режиме, и без него`, () => {
		for (const startOn of [false, true]) {
			const api = loadWith(ext, startOn);
			if (Object.keys(api.handlers).length === 0) {
				throw new Error(`старт yolo=${startOn}: ни одного обработчика — /yolo не будет работать`);
			}
		}
	});
}

await check("bash-guard: «пол» блокирует без режима и молчит в режиме", async () => {
	const api = loadWith(guards["bash-guard"], false);
	const ev = () => ({ toolName: "bash", input: { command: "sudo rm -rf /" } });
	const off = await api.handlers.tool_call(ev(), noUiCtx);
	if (!off?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(off));
	yoloMode.setYolo(true);
	if ((await api.handlers.tool_call(ev(), noUiCtx))?.block) throw new Error("в режиме команду заблокировало");
});
await check("dir-guard: путь вне cwd блокирует без режима и проходит в режиме", async () => {
	const api = loadWith(guards["dir-guard"], false);
	const ev = () => ({ toolName: "write", input: { path: join(homedir(), "pi-yolo-outside.txt") } });
	const off = await api.handlers.tool_call(ev(), makeCtx(cwd));
	if (!off?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(off));
	yoloMode.setYolo(true);
	if ((await api.handlers.tool_call(ev(), makeCtx(cwd)))?.block) throw new Error("в режиме путь заблокировало");
});
await check("edit-fresh: edit без read блокирует без режима и проходит в режиме", async () => {
	const api = loadWith(guards["edit-fresh"], false);
	const ev = () => ({ toolName: "edit", input: { path: "a.txt", edits: [] } });
	const ctx = makeCtx(cwd);
	const off = await api.handlers.tool_call(ev(), ctx);
	if (!off?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(off));
	yoloMode.setYolo(true);
	if ((await api.handlers.tool_call(ev(), makeCtx(cwd)))?.block) throw new Error("в режиме edit заблокировало");
});
await check("text-guard: секция стиля вшивается без режима и не шьётся в режиме", async () => {
	const api = loadWith(guards["text-guard"], false);
	const call = async () => {
		const ev = { systemPromptOptions: { sections: {} } };
		await api.handlers.before_agent_start(ev, makeCtx(cwd));
		return Object.keys(ev.systemPromptOptions.sections).length;
	};
	if ((await call()) === 0) throw new Error("без режима секция не добавлена");
	yoloMode.setYolo(true);
	if ((await call()) !== 0) throw new Error("в режиме секция добавлена");
});
await check("sandbox: в режиме команду не оборачивает и не блокирует", async () => {
	const api = loadWith(guards.sandbox, false);
	yoloMode.setYolo(true);
	const ctx = makeCtx(cwd);
	const ev = { toolName: "bash", input: { command: "echo hi" } };
	const res = await api.handlers.tool_call(ev, ctx);
	if (res?.block) throw new Error("в режиме команду заблокировало: " + res.reason);
	if (ev.input.command !== "echo hi") throw new Error("команда обёрнута: " + ev.input.command);
	const trust = await api.handlers.project_trust({ cwd }, noUiCtx);
	if (trust?.trusted !== "undecided") throw new Error("project_trust в режиме: " + JSON.stringify(trust));
});

const failed = results.filter((r) => r.startsWith("FAIL"));
for (const r of results) console.log(r);
rmSync(guardAgentDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
if (failed.length) {
	console.log(`\n${failed.length} из ${results.length} не прошли`);
	process.exit(1);
}
console.log(`\nвсе проверки прошли (${results.length})`);
