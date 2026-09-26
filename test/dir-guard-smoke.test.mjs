/**
 * Смоук-тест dir-guard: jiti + стаб ExtensionAPI.
 * Запуск: node test/dir-guard-smoke.test.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));
const dirGuard = jiti("../extensions/dir-guard/index.ts");

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
	return {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
			...extra,
		},
	};
}

// --- фикстуры ---
const base = tmpdir() + "/pi-dir-guard-test-" + process.pid;
const cwd = join(base, "project");
const outside = join(base, "outside");
mkdirSync(cwd, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(cwd, "inner.txt"), "hello");
writeFileSync(join(outside, "secret.txt"), "s3cr3t");

// === dir-guard ===
{
	const pi = makePi();
	dirGuard.default(pi);
	const handler = pi.handlers.tool_call;
	const ctx = makeCtx(cwd);

	await check("dir-guard: зарегистрированы флаги и команда", () => {
		if (!pi.flags.some((f) => f.name === "dir-guard-disabled")) throw new Error("нет флага dir-guard-disabled");
		if (!pi.flags.some((f) => f.name === "dir-guard-allow")) throw new Error("нет флага dir-guard-allow");
		if (!pi.commands.some((c) => c.name === "dir-guard")) throw new Error("нет /dir-guard");
	});

	await check("(a) read за CWD блокируется, reason содержит dir-guard", async () => {
		const res = await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!res.reason.includes("dir-guard")) throw new Error("причина: " + res.reason);
	});

	await check("(b) read внутри CWD пропущен (относительный)", async () => {
		const res = await handler({ toolName: "read", input: { path: "inner.txt" } }, ctx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});

	await check("(b2) read внутри CWD пропущен (абсолютный)", async () => {
		const res = await handler({ toolName: "read", input: { path: join(cwd, "inner.txt") } }, ctx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});

	await check("(c) write за CWD блокируется", async () => {
		const res = await handler({ toolName: "write", input: { path: join(outside, "evil.txt"), content: "x" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!res.reason.includes("dir-guard")) throw new Error("причина: " + res.reason);
	});

	await check("(c2) edit за CWD блокируется", async () => {
		const res = await handler({ toolName: "edit", input: { path: "/etc/hosts", oldText: "a", newText: "b" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});

	await check("(d) bash с cat /etc/passwd блокируется", async () => {
		const res = await handler({ toolName: "bash", input: { command: "cat /etc/passwd" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!res.reason.includes("dir-guard")) throw new Error("причина: " + res.reason);
	});

	await check("(e) bash с ls -la пропущен", async () => {
		const res = await handler({ toolName: "bash", input: { command: "ls -la" } }, ctx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});

	await check("(e2) bash с относительным ../../.. за CWD блокируется", async () => {
		const res = await handler({ toolName: "bash", input: { command: "cat ../../../etc/passwd" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});

	await check("(e3) bash с абсолютным путём внутри CWD пропущен", async () => {
		const res = await handler({ toolName: "bash", input: { command: "cat " + join(cwd, "inner.txt") } }, ctx);
		if (res !== undefined) throw new Error("ожидалось undefined, получили: " + JSON.stringify(res));
	});

	await check("(e4) bash с URL (https://…) не блокируется ложно", async () => {
		const res = await handler({ toolName: "bash", input: { command: "curl https://example.com/docs/page" } }, ctx);
		if (res !== undefined) throw new Error("ложный блок: " + JSON.stringify(res));
	});

	await check("(e5) bash с неразрешимым токеном ($VAR) не блокируется (задокументированный компромисс)", async () => {
		const res = await handler({ toolName: "bash", input: { command: "cat $HOME/somefile" } }, ctx);
		if (res !== undefined) throw new Error("неразрешимый токен заблокирован: " + JSON.stringify(res));
	});

	await check("(f) symlink-escape блокируется (symlink в CWD → наружу)", async () => {
		const link = join(cwd, "sneaky-link");
		if (!existsSync(link)) symlinkSync(outside, link);
		const res = await handler({ toolName: "read", input: { path: join(link, "secret.txt") } }, ctx);
		if (!res?.block) throw new Error("symlink-escape не заблокирован: " + JSON.stringify(res));
	});

	await check("(f2) несуществующий путь за CWD блокируется (канонизация хвоста)", async () => {
		const res = await handler({ toolName: "write", input: { path: "/opt/definitely-not-here/new.txt", content: "x" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
	});

	await check("(g) toggle /dir-guard снимает блокировку, повторный — возвращает", async () => {
		const cmd = pi.commands.find((c) => c.name === "dir-guard").def;
		await cmd.handler("", ctx); // выключить
		const resOff = await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctx);
		if (resOff !== undefined) throw new Error("после /dir-guard блок остался: " + JSON.stringify(resOff));
		await cmd.handler("", ctx); // включить
		const resOn = await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctx);
		if (!resOn?.block) throw new Error("после повторного /dir-guard блок пропал");
	});

	await check("(h) allowlist-путь (флаг --dir-guard-allow) разрешён", async () => {
		const piAllow = makePi({ "--dir-guard-allow": outside });
		dirGuard.default(piAllow);
		const ctxA = makeCtx(cwd);
		const res = await piAllow.handlers.tool_call({ toolName: "read", input: { path: join(outside, "secret.txt") } }, ctxA);
		if (res !== undefined) throw new Error("allowlist-путь заблокирован: " + JSON.stringify(res));
		// а путь вне и CWD, и allowlist всё ещё блокируется
		const res2 = await piAllow.handlers.tool_call({ toolName: "read", input: { path: "/etc/passwd" } }, ctxA);
		if (!res2?.block) throw new Error("внешний путь мимо allowlist пропущен");
	});

	await check("(h2) allowlist из .dir-guard.json в CWD разрешён", async () => {
		const cfgDir = join(base, "project-cfg");
		mkdirSync(cfgDir, { recursive: true });
		writeFileSync(join(cfgDir, ".dir-guard.json"), JSON.stringify({ allow: [outside] }));
		const piCfg = makePi();
		dirGuard.default(piCfg);
		const ctxCfg = makeCtx(cfgDir);
		const res = await piCfg.handlers.tool_call({ toolName: "read", input: { path: join(outside, "secret.txt") } }, ctxCfg);
		if (res !== undefined) throw new Error("allowlist-путь из файла заблокирован: " + JSON.stringify(res));
	});

	await check("(h3) невалидный .dir-guard.json → warn через notify и игнор", async () => {
		const cfgDir2 = join(base, "project-badcfg");
		mkdirSync(cfgDir2, { recursive: true });
		writeFileSync(join(cfgDir2, ".dir-guard.json"), "{не json");
		const piBad = makePi();
		dirGuard.default(piBad);
		let warned = "";
		const ctxBad = makeCtx(cfgDir2, { notify: (m) => { warned += m; } });
		const res = await piBad.handlers.tool_call({ toolName: "read", input: { path: join(outside, "secret.txt") } }, ctxBad);
		if (!res?.block) throw new Error("с невалидным конфигом путь должен блокироваться");
		if (!warned.includes(".dir-guard.json")) throw new Error("нет warn: " + warned);
	});

	await check("session_start с --dir-guard-disabled ставит бейдж с ключом ' dir-guard'", async () => {
		const piDis = makePi({ "--dir-guard-disabled": true });
		dirGuard.default(piDis);
		let statusKey = null, statusVal = null;
		const ctxDis = makeCtx(cwd, { setStatus: (k, v) => { statusKey = k; statusVal = v; } });
		await piDis.handlers.session_start({ reason: "startup" }, ctxDis);
		if (statusKey !== " dir-guard") throw new Error("ключ статуса: " + JSON.stringify(statusKey));
		if (!statusVal) throw new Error("бейдж не установлен");
	});
}

rmSync(base, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
