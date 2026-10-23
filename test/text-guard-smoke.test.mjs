/**
 * Смоук-тест text-guard: jiti + стаб ExtensionAPI.
 * Запуск: node test/text-guard-smoke.test.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

// Изолируем agent dir (guard-state.json пишется в <agentDir>/ — не в реальный ~/.pi/agent).
const guardAgentDir = join(tmpdir(), `pi-text-guard-state-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));
const textGuard = jiti("../extensions/text-guard/index.ts");

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
function makePi(overrides = {}) {
	const handlers = {};
	const commands = [];
	const flags = [];
	return {
		handlers, commands, flags,
		on: (event, fn) => { handlers[event] = fn; },
		registerCommand: (name, def) => commands.push({ name, def }),
		registerFlag: (name, def) => flags.push({ name, def }),
		registerShortcut: () => {},
		registerTool: () => {},
		getFlag: (name) => overrides[name] ?? false,
	};
}

function makeCtx(cwd, extra = {}) {
	const notifications = [];
	return {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: (m, t) => notifications.push({ m, t }),
			setStatus: extra.setStatus ?? (() => {}),
			theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
			...extra,
		},
		notifications,
		...extra,
	};
}

// --- фикстуры ---
const base = tmpdir() + "/pi-text-guard-test-" + process.pid;
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });

const EMOJI = "Текст с 🎉 эмодзи";
const MD = "doc.md";

{
	const pi = makePi();
	textGuard.default(pi);
	const handler = pi.handlers.tool_call;
	const cmd = (name) => pi.commands.find((c) => c.name === name).def;
	const ctx = makeCtx(cwd);

	await check("зарегистрированы флаги и команды", () => {
		for (const f of ["text-guard-strict", "text-guard-off"]) {
			if (!pi.flags.some((x) => x.name === f)) throw new Error("нет флага " + f);
		}
		for (const c of ["text-guard", "text-guard:fix", "text-guard:stats"]) {
			if (!pi.commands.some((x) => x.name === c)) throw new Error("нет команды " + c);
		}
	});

	await check("before_agent_start: секция writing-style добавлена (warn)", async () => {
		const ev = { systemPromptOptions: { sections: {} } };
		await pi.handlers.before_agent_start(ev, ctx);
		if (!ev.systemPromptOptions.sections["writing-style"]) throw new Error("секции нет");
	});

	await check("(warn) write с эмодзи не блокируется, notify + статистика", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: EMOJI } }, ctx);
		if (res !== undefined) throw new Error("warn не должен блокировать: " + JSON.stringify(res));
		if (!ctx.notifications.length) throw new Error("нет предупреждения");
	});

	await check("(/text-guard) warn → strict, персистентно", async () => {
		await cmd("text-guard").handler("", ctx);
		const st = JSON.parse(readFileSync(join(guardAgentDir, "guard-state.json"), "utf8"))["text-guard"];
		if (st.mode !== "strict") throw new Error("режим в файле: " + JSON.stringify(st));
	});

	await check("(strict) write с эмодзи блокируется, reason конкретный", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: EMOJI } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("text-guard") || !res.reason.includes("🎉")) throw new Error("reason: " + res.reason);
		if (!res.reason.includes("стр. 1")) throw new Error("нет строки в reason: " + res.reason);
	});

	await check("(strict) RU-слово «Давайте» блокируется", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: "Давайте начнём с установки." } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("давайте")) throw new Error("reason: " + res.reason);
	});

	await check("(strict) EN-слово delve блокируется", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: "Let us delve into details." } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("delve")) throw new Error("reason: " + res.reason);
	});

	await check("(strict) naming — в заголовке md да, в теле нет", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: "# Ultimate Wizard Guide\n\nЧистый текст без маркеров." } }, ctx);
		if (!res?.block) throw new Error("заголовок с wizard должен блокироваться");
		const ok = await handler({ toolName: "write", input: { path: join(cwd, MD), content: "Обычный абзац про wizard из зависимостей." } }, ctx);
		if (ok !== undefined) throw new Error("в теле wizard не должен проверяться: " + JSON.stringify(ok));
	});

	await check("(strict) структура: жирная метка в буллете блокируется", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, MD), content: "- **Note:** что-то важное\n" } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("структура")) throw new Error("reason: " + res.reason);
	});

	await check("(strict) edit: newText сканируется, oldText — нет", async () => {
		const bad = await handler({ toolName: "edit", input: { path: join(cwd, MD), edits: [{ oldText: "старый ✅ текст", newText: "новый ✅ текст" }] } }, ctx);
		if (!bad?.block) throw new Error("эмодзи в newText должен блокироваться");
		const ok = await handler({ toolName: "edit", input: { path: join(cwd, MD), edits: [{ oldText: "старый ✅ текст", newText: "новый чистый текст" }] } }, ctx);
		if (ok !== undefined) throw new Error("эмодзи в oldText не должен проверяться: " + JSON.stringify(ok));
	});

	await check("(strict) bash: git commit -m с эмодзи блокируется", async () => {
		const res = await handler({ toolName: "bash", input: { command: `git commit -m "🎉 релиз 🚀"` } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
	});

	await check("(strict) bash: naming в коммите (awesome wizard) блокируется", async () => {
		const res = await handler({ toolName: "bash", input: { command: `git commit -m "awesome wizard release"` } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("умные названия")) throw new Error("reason: " + res.reason);
	});

	await check("(strict) bash: heredoc в .md со словом «Итак,» блокируется", async () => {
		const command = `cat > ${join(cwd, "notes.md")} <<'EOF'\nИтак, поехали.\nEOF`;
		const res = await handler({ toolName: "bash", input: { command } }, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
	});

	await check("(strict) .json пропускается всегда", async () => {
		const res = await handler({ toolName: "write", input: { path: join(cwd, "data.json"), content: '{"a": "🎉 и 🚀"}' } }, ctx);
		if (res !== undefined) throw new Error("json не должен сканироваться: " + JSON.stringify(res));
	});

	await check("(strict) комментарии .ts сканируются, строки внутри кода — нет", async () => {
		const bad = await handler({ toolName: "write", input: { path: join(cwd, "a.ts"), content: "// комментарий с 🎉\nconst x = 1;\n" } }, ctx);
		if (!bad?.block) throw new Error("эмодзи в комментарии должен блокироваться");
		const ok = await handler({ toolName: "write", input: { path: join(cwd, "a.ts"), content: 'const s = "строка с 🎉 внутри";\n' } }, ctx);
		if (ok !== undefined) throw new Error("строка в коде не должна сканироваться: " + JSON.stringify(ok));
	});

	await check("(/text-guard:fix) автофикс: чистые символы правятся in place", async () => {
		await cmd("text-guard:fix").handler("", ctx);
		const input = { toolName: "write", input: { path: join(cwd, MD), content: "Список: 🎉 первый пункт ✅ второй → третий" } };
		const res = await handler(input, ctx);
		if (res !== undefined) throw new Error("автофикс не должен блокировать: " + JSON.stringify(res));
		if (/[🎉✅→]/u.test(input.input.content)) throw new Error("символы не убраны: " + JSON.stringify(input.input.content));
		if (input.input.content !== "Список: первый пункт второй третий") throw new Error("неожиданный результат: " + JSON.stringify(input.input.content));
	});

	await check("автофикс не заменяет слова: «давайте» + эмодзи → блок", async () => {
		const input = { toolName: "write", input: { path: join(cwd, MD), content: "Давайте 🎉 начнём" } };
		const res = await handler(input, ctx);
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
	});

	await check("(/text-guard:fix ещё раз) автофикс выключен обратно", async () => {
		await cmd("text-guard:fix").handler("", ctx);
	});

	await check("защита от петли: после 2 блоков одинаковый текст пропускается", async () => {
		const content = "Давайте повторим это же исправление.";
		const b1 = await handler({ toolName: "write", input: { path: join(cwd, "loop.md"), content } }, ctx);
		const b2 = await handler({ toolName: "write", input: { path: join(cwd, "loop.md"), content } }, ctx);
		if (!b1?.block || !b2?.block) throw new Error("первые два вызова должны блокироваться");
		const b3 = await handler({ toolName: "write", input: { path: join(cwd, "loop.md"), content } }, ctx);
		if (b3 !== undefined) throw new Error("после двух блоков должен быть пропуск: " + JSON.stringify(b3));
		if (!ctx.notifications.some((n) => n.m.includes("дважды не смогла"))) throw new Error("нет предупреждения о петле");
	});

	await check("message_end: находки в чате считаются, бейдж с числом", async () => {
		let statusKey = null, statusVal = null;
		const ctxS = makeCtx(cwd, { setStatus: (k, v) => { statusKey = k; statusVal = v; } });
		await pi.handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Отлично! Готово 🎉" }] } }, ctxS);
		if (statusKey !== " z-text-guard") throw new Error("ключ статуса: " + JSON.stringify(statusKey));
		if (!statusVal || !statusVal.includes("TG")) throw new Error("бейдж: " + JSON.stringify(statusVal));
	});

	await check(".text-guard.json: allow-глобы и ignore", async () => {
		writeFileSync(join(cwd, ".text-guard.json"), JSON.stringify({ allow: ["README*"], ignore: ["robust"] }));
		const pi2 = makePi();
		textGuard.default(pi2);
		const h2 = pi2.handlers.tool_call;
		const ctx2 = makeCtx(cwd);
		const ok = await h2({ toolName: "write", input: { path: join(cwd, "README.md"), content: "Крутой 🚀 проект" } }, ctx2);
		if (ok !== undefined) throw new Error("README* должен быть в allow: " + JSON.stringify(ok));
		const ok2 = await h2({ toolName: "write", input: { path: join(cwd, "x.md"), content: "Robust и надёжный механизм." } }, ctx2);
		if (ok2 !== undefined) throw new Error("ignore не сработал: " + JSON.stringify(ok2));
		const bad = await h2({ toolName: "write", input: { path: join(cwd, "y.md"), content: "Давайте проверим allow дальше." } }, ctx2);
		if (!bad?.block) throw new Error("файл вне allow должен блокироваться");
	});

	await check("custom words из конфига блокируются", async () => {
		writeFileSync(join(cwd, ".text-guard.json"), JSON.stringify({ words: ["золотая пуля"] }));
		const pi3 = makePi();
		textGuard.default(pi3);
		const res = await pi3.handlers.tool_call({ toolName: "write", input: { path: join(cwd, "z.md"), content: "Это не золотая пуля, но близко." } }, makeCtx(cwd));
		if (!res?.block) throw new Error("ожидался блок: " + JSON.stringify(res));
		if (!res.reason.includes("золотая пуля")) throw new Error("reason: " + res.reason);
	});

	await check("--text-guard-off: сессия стартует выключенной, секции стиля нет", async () => {
		const piOff = makePi({ "text-guard-off": true });
		textGuard.default(piOff);
		const ctxOff = makeCtx(cwd);
		await piOff.handlers.session_start({ reason: "startup" }, ctxOff);
		const ev = { systemPromptOptions: { sections: {} } };
		await piOff.handlers.before_agent_start(ev, ctxOff);
		if (ev.systemPromptOptions.sections["writing-style"]) throw new Error("секция стиля не должна добавляться в off");
		const res = await piOff.handlers.tool_call({ toolName: "write", input: { path: join(cwd, MD), content: EMOJI } }, ctxOff);
		if (res !== undefined) throw new Error("в off ничего не блокируется: " + JSON.stringify(res));
	});
}

rmSync(base, { recursive: true, force: true });
rmSync(guardAgentDir, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
