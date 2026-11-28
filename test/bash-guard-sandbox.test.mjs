/**
 * Тест связи sandbox <-> bash-guard: guard не спрашивает подтверждение на
 * команду, которую sandbox возьмёт в изоляцию, но «пол» жёсткого блока держит.
 *
 * Проверяется именно мост extensions/sandbox-state.ts, а не обёртка в тексте:
 * bash-guard загружается раньше sandbox и обёртки (bwrap/sandbox-exec) в момент
 * своей работы никогда не видит — прежняя проверка по голове команды была
 * мёртвой и двойной промпт не снимала.
 * Запуск: node test/bash-guard-sandbox.test.mjs
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

// Состояние guard'ов пишем в изолированный agent dir (не реальный ~/.pi/agent).
const guardAgentDir = join(tmpdir(), `pi-sbx-guard-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;

const jiti = createJiti(fileURLToPath(import.meta.url));
const bashGuard = jiti("../extensions/bash-guard/index.ts");
const sandboxState = jiti("../extensions/sandbox-state.ts");

const results = [];
async function check(name, fn) {
	try {
		rmSync(join(guardAgentDir, "guard-state.json"), { force: true });
		sandboxState.registerSandboxProbe(() => false);
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

function makeApi() {
	const handlers = {};
	return {
		handlers,
		on: (event, fn) => { handlers[event] = fn; },
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => false,
	};
}

/** ctx с UI: считаем, сколько раз bash-guard открыл диалог «Выполнить/Отменить». */
function makeCtx() {
	const ctx = { hasUI: true, cwd: process.cwd(), asked: 0, status: [], ui: {
		notify: () => {},
		setStatus: (_k, v) => ctx.status.push(v),
		setWidget: () => {},
		custom: async () => { ctx.asked++; return "abort"; },
		theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
	} };
	return ctx;
}

const bash = (command) => ({ toolName: "bash", input: { command } });
// Конвейер — medium-риск по правилу анализатора, «пол» на него не матчится.
const RISKY = "cat build.log | tail -5";
const FLOOR = "rm -rf build";

const load = () => {
	const api = makeApi();
	bashGuard.default(api);
	return api.handlers.tool_call;
};

await check("без изоляции: рискованная команда идёт в диалог и блокируется отменой", async () => {
	const handler = load();
	const ctx = makeCtx();
	const res = await handler(bash(RISKY), ctx);
	if (ctx.asked !== 1) throw new Error(`диалог открыт ${ctx.asked} раз(а), ожидался 1`);
	if (!res?.block) throw new Error("отменённая команда не заблокирована: " + JSON.stringify(res));
});

await check("изоляция включена: диалога нет, команда проходит", async () => {
	sandboxState.registerSandboxProbe(() => true);
	const handler = load();
	const ctx = makeCtx();
	const res = await handler(bash(RISKY), ctx);
	if (ctx.asked !== 0) throw new Error("спросил подтверждение у изолированной команды");
	if (res !== undefined) throw new Error("заблокировал изолированную команду: " + JSON.stringify(res));
});

await check("изоляция включена: «пол» всё равно блокирует", async () => {
	sandboxState.registerSandboxProbe(() => true);
	const handler = load();
	const ctx = makeCtx();
	const res = await handler(bash(FLOOR), ctx);
	if (ctx.asked !== 0) throw new Error("попросил подтверждение вместо жёсткого блока");
	if (!res?.block) throw new Error("«пол» не сработал в песочнице: " + JSON.stringify(res));
	if (!res.reason.includes("в песочнице")) throw new Error("причина не говорит про песочницу: " + res.reason);
});

await check("нет предиката (sandbox не загружен) — guard спрашивает, а не разрешает", async () => {
	sandboxState.registerSandboxProbe(() => { throw new Error("бэкенд не спрашиваем без причины"); });
	const handler = load();
	const ctx = makeCtx();
	await handler(bash(RISKY + " | head"), ctx);
	if (ctx.asked !== 1) throw new Error(`сбойный предикат снял вопрос (диалогов: ${ctx.asked})`);
});

const failed = results.filter((r) => r.startsWith("FAIL"));
for (const r of results) console.log(r);
if (failed.length) {
	console.log(`\n${failed.length} из ${results.length} не прошли`);
	process.exit(1);
}
console.log(`\nвсе проверки прошли (${results.length})`);
