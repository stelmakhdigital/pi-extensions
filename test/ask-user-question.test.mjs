/**
 * Смоук-тест ask_user_question: регистрация, состояния «нет UI / отмена /
 * ответ» и главное — что отмена хода (abort) не оставляет висящий вопрос.
 * Запуск: node test/ask-user-question.test.mjs
 */
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

const jiti = createJiti(fileURLToPath(import.meta.url));
const mod = jiti("../extensions/ask-user-question/index.ts");
const ask = mod.default ?? mod;

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

/** Стаб pi: registerTool сохраняет определение инструмента. */
function makePi() {
	const tool = {};
	return {
		tool,
		registerTool(def) {
			Object.assign(tool, def);
		},
		registerFlag() {},
		registerCommand() {},
		on() {},
		getFlag: () => undefined,
	};
}

const theme = { fg: (_c, t) => t, bold: (t) => t };
/** ctx с ui.custom, который «отвечает» переданным способом. */
function makeCtx({ answer = null, hang = false, ui = true } = {}) {
	return {
		hasUI: ui,
		mode: "tui",
		ui: {
			theme,
			setStatus() {},
			notify() {},
			custom(_factory) {
				return new Promise((resolve) => {
					if (hang) return; // вопрос «открыт и waits» — спасает только abort
					setTimeout(() => resolve(answer), 0);
				});
			},
			editor() {
				return new Promise((resolve) => setTimeout(() => resolve(answer ?? undefined), 0));
			},
		},
		isProjectTrusted: () => true,
	};
}

const Q = { question: "Какой путь?", options: [{ label: "A" }, { label: "B" }] };
const details = (r) => r?.details;

const pi = makePi();
ask(pi);

await check("инструмент зарегистрирован под именем ask_user_question", async () => {
	if (pi.tool.name !== "ask_user_question") throw new Error("имя: " + pi.tool.name);
	if (typeof pi.tool.execute !== "function") throw new Error("нет execute");
});

await check("без UI — честный ответ «интерактив недоступен»", async () => {
	const r = await pi.tool.execute("t1", Q, undefined, undefined, makeCtx({ ui: false }));
	if (!JSON.stringify(details(r)).includes("unavailable")) throw new Error("не unavailable: " + JSON.stringify(r?.details));
	if (!/UI/.test(JSON.stringify(r.content))) throw new Error("в тексте нет причины: " + JSON.stringify(r.content));
});

await check("сигнал уже взведён — вопрос не показывается", async () => {
	const ac = new AbortController();
	ac.abort();
	let shown = false;
	const ctx = makeCtx({ answer: { type: "option", label: "A", value: "A" } });
	const orig = ctx.ui.custom;
	ctx.ui.custom = (f) => {
		shown = true;
		return orig(f);
	};
	await pi.tool.execute("t2", Q, ac.signal, undefined, ctx);
	if (shown) throw new Error("вопрос показали после abort");
});

await check("abort посреди открытого вопроса завершает вызов", async () => {
	const ac = new AbortController();
	const ctx = makeCtx({ hang: true }); // select навсегда открыт
	const pending = pi.tool.execute("t3", Q, ac.signal, undefined, ctx);
	setTimeout(() => ac.abort(), 10);
	const r = await Promise.race([
		pending,
		new Promise((_, rej) => setTimeout(() => rej(new Error("висит: abort не завершил вызов")), 2000)),
	]);
	if (!JSON.stringify(details(r)).includes("cancelled")) throw new Error("не cancelled: " + JSON.stringify(r?.details));
});

await check("ответ вариант — в content и в details", async () => {
	const ctx = makeCtx({ answer: { type: "option", label: "A", value: "A" } });
	const r = await pi.tool.execute("t4", Q, undefined, undefined, ctx);
	const text = JSON.stringify(r.content);
	if (!text.includes("A")) throw new Error("ответ не в content: " + text);
	if (!JSON.stringify(details(r)).includes("answered")) throw new Error("details: " + JSON.stringify(r.details));
});

await check("отказ (done(null)) — cancelled, не ошибка", async () => {
	const r = await pi.tool.execute("t5", Q, undefined, undefined, makeCtx({ answer: null }));
	if (!JSON.stringify(details(r)).includes("cancelled")) throw new Error("не cancelled: " + JSON.stringify(r.details));
});

await check("свободный текст (без options) идёт через editor", async () => {
	const r = await pi.tool.execute("t6", { question: "Что?" }, undefined, undefined, makeCtx({ answer: "вот так" }));
	if (!JSON.stringify(r.content).includes("вот так")) throw new Error("текста нет: " + JSON.stringify(r.content));
});

// --- withAbort: юнит ---
await check("withAbort: без сигнала — прокидывает значение", async () => {
	if ((await mod.withAbort(Promise.resolve(5))) !== 5) throw new Error("значение потеряно");
});

await check("withAbort: отклонение прокидывается, а не глотается", async () => {
	let threw = false;
	try {
		await mod.withAbort(Promise.reject(new Error("сбой UI")), new AbortController().signal);
	} catch {
		threw = true;
	}
	if (!threw) throw new Error("ошибка проглочена");
});

await check("withAbort: abort во время ожидания даёт undefined", async () => {
	const ac = new AbortController();
	const p = mod.withAbort(new Promise(() => {}), ac.signal);
	ac.abort();
	if ((await p) !== undefined) throw new Error("abort не заверши undefined");
});

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
