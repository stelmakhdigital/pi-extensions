/**
 * Смоук-тест dir-guard: jiti + стаб ExtensionAPI.
 * Запуск: node test/dir-guard-smoke.test.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

// Изолируем agent dir (guard-state.json пишется в <agentDir>/ — не в реальный ~/.pi/agent).
const guardAgentDir = join(tmpdir(), `pi-dir-guard-state-test-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = guardAgentDir;

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
// dir-guard по дефолту открывает scratch (/tmp, /private/tmp) и $HOME/.pi.
// Фикстуру «outside» нельзя брать ни там, ни там: на хостах, где HOME лежит
// внутри /tmp (подменённый HOME, песочницы), «outside» попадал в allowlist, и
// проверки на блок падали с «получили: undefined». Поэтому HOME фикстуре
// ставим в /var/tmp — он вне allowlist, и $HOME/.pi остаётся внутри фикстуры.
function writableDir(p) {
	try {
		mkdirSync(p, { recursive: true });
		const probe = join(p, `.dir-guard-probe-${process.pid}`);
		writeFileSync(probe, "x");
		rmSync(probe);
		return true;
	} catch {
		return false;
	}
}
const base = writableDir("/var/tmp")
	? join("/var/tmp", `pi-dir-guard-test-${process.pid}`)
	: join(homedir(), `.pi-dir-guard-test-${process.pid}`);
// os.homedir() читает HOME в момент вызова, а guard считает allowlist
// лениво (на первом tool call) — так что подмена до проверок работает
process.env.HOME = base;
process.env.USERPROFILE = base;
const cwd = join(base, "project");
const outside = join(base, "outside");
mkdirSync(cwd, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(cwd, "inner.txt"), "hello");
writeFileSync(join(outside, "secret.txt"), "s3cr3t");

/** Зафиксировать состояние dir-guard в файле: тесты на toggle пишут его, а
 * factory читает на старте — без пина следующий блок проверял бы «всё разрешено». */
function pinGuardState(disabled) {
	mkdirSync(guardAgentDir, { recursive: true });
	writeFileSync(join(guardAgentDir, "guard-state.json"), JSON.stringify({ "dir-guard": { disabled } }));
}
pinGuardState(false);

// === dir-guard ===
{
	const pi = makePi();
	dirGuard.default(pi);
	const handler = pi.handlers.tool_call;
	const ctx = makeCtx(cwd);

	await check("dir-guard: зарегистрированы флаги и команда", () => {
		if (!pi.flags.some((f) => f.name === "dir-guard-disabled")) throw new Error("нет флага dir-guard-disabled");
		if (!pi.flags.some((f) => f.name === "dir-guard-allow")) throw new Error("нет флага dir-guard-allow");
		if (!pi.flags.some((f) => f.name === "dir-guard-allow-secrets")) throw new Error("нет флага dir-guard-allow-secrets");
		if (!pi.commands.some((c) => c.name === "dir-guard")) throw new Error("нет /dir-guard");
	});

	await check("(a) read за CWD блокируется, reason содержит dir-guard", async () => {
		const res = await handler({ toolName: "read", input: { path: "/etc/passwd" } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!res.reason.includes("dir-guard")) throw new Error("причина: " + res.reason);
	});

	await check("(a2) секрет сверх allowlist блокируется ($HOME/.pi/agent/auth.json)", async () => {
		const res = await handler({ toolName: "read", input: { path: join(base, ".pi/agent/auth.json") } }, ctx);
		if (!res?.block) throw new Error("ожидалось block, получили: " + JSON.stringify(res));
		if (!/учётными|секр/.test(res.reason)) throw new Error("причина не про секреты: " + res.reason);
	});

	await check("(a3) ~/.ssh и ~/.aws блокируются, bash-путь к ключу тоже", async () => {
		for (const p of [join(base, ".ssh/id_ed25519"), join(base, ".aws/credentials")]) {
			const res = await handler({ toolName: "read", input: { path: p } }, ctx);
			if (!res?.block) throw new Error(`не заблокирован ${p}: ` + JSON.stringify(res));
		}
		const bash = await handler({ toolName: "bash", input: { command: `cat ${base}/.ssh/id_rsa` } }, ctx);
		if (!bash?.block) throw new Error("bash к ключу не заблокирован: " + JSON.stringify(bash));
	});

	await check("(a4) секрет-файл внутри CWD — обычный рабочий файл", async () => {
		writeFileSync(join(cwd, ".env"), "TOKEN=x");
		const res = await handler({ toolName: "read", input: { path: join(cwd, ".env") } }, ctx);
		if (res !== undefined) throw new Error("ложный блок на .env в CWD: " + JSON.stringify(res));
	});

	await check("(a5) обычный файл в allowlist ($HOME/.pi) не блокируется", async () => {
		mkdirSync(join(base, ".pi/agent"), { recursive: true });
		writeFileSync(join(base, ".pi/agent/guard-state.json"), "{}");
		const res = await handler({ toolName: "read", input: { path: join(base, ".pi/agent/guard-state.json") } }, ctx);
		if (res !== undefined) throw new Error("allowlist-файл заблокирован: " + JSON.stringify(res));
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

	await check("(e6) bash с редирекцией 2>/dev/null не блокируется ложно", async () => {
		const res = await handler({ toolName: "bash", input: { command: "ls missing-file 2>/dev/null | head" } }, ctx);
		if (res !== undefined) throw new Error("ложный блок на /dev/null: " + JSON.stringify(res));
	});

	await check("(e7) bash с ~/… (allowlist-дефолт $HOME/.pi) не даёт ложного токена /…", async () => {
		const res = await handler({ toolName: "bash", input: { command: "ls ~/.pi/agent" } }, ctx);
		if (res !== undefined) throw new Error("ложный блок на ~/…: " + JSON.stringify(res));
	});

	await check("(e8) односегментные токены (docker exec … /models, /app) не блокируются", async () => {
		for (const command of ["docker exec ctr ls /models", "cd /app && make", "grep -r x /MTP"]) {
			const res = await handler({ toolName: "bash", input: { command } }, ctx);
			if (res !== undefined) throw new Error(`ложный блок на "${command}": ${JSON.stringify(res)}`);
		}
	});

	await check("(e9) /tmp и read-only системные root'ы в дефолтном allowlist", async () => {
		for (const command of [
			"tar xzf a.tgz -C /tmp/out",
			"echo hi > /private/tmp/scratch.txt",
			"bash /bin/bash -c 'echo hi'",
			"/usr/bin/env python3 s.py",
		]) {
			const res = await handler({ toolName: "bash", input: { command } }, ctx);
			if (res !== undefined) throw new Error(`ложный блок на "${command}": ${JSON.stringify(res)}`);
		}
		const res = await handler({ toolName: "bash", input: { command: "cat /etc/hosts" } }, ctx);
		if (res === undefined) throw new Error("/etc/hosts не заблокировался — allowlist шире задуманного");
	});

	await check("(e10) двойной слэш (cat //etc/passwd) блокируется как обычный путь", async () => {
		const res = await handler({ toolName: "bash", input: { command: "cat //etc/passwd" } }, ctx);
		if (res === undefined) throw new Error("//etc/passwd не заблокирован (bash читает его как /etc/passwd)");
	});

	await check("(e11) локальные бинари (brew /usr/local, /opt/homebrew) в allowlist", async () => {
		// Проверяем только реально установленные на этой машине brew-бинари
		// (на другой машине их нет — тест переносимый). Символические ссылки
		// за пределы brew-root блокируются канон-проверкой и должны отсутствовать.
		const { existsSync } = await import("node:fs");
		for (const command of ["/opt/homebrew/bin/rg foo", "/usr/local/bin/rg foo"]) {
			const bin = command.split(" ")[0];
			if (!existsSync(bin)) continue;
			const res = await handler({ toolName: "bash", input: { command } }, ctx);
			if (res !== undefined) throw new Error(`ложный блок на "${command}": ${JSON.stringify(res)}`);
		}
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
		const piAllow = makePi({ "dir-guard-allow": outside });
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
		const piDis = makePi({ "dir-guard-disabled": true });
		dirGuard.default(piDis);
		let statusKey = null, statusVal = null;
		const ctxDis = makeCtx(cwd, { setStatus: (k, v) => { statusKey = k; statusVal = v; } });
		await piDis.handlers.session_start({ reason: "startup" }, ctxDis);
		if (statusKey !== " z-dir-guard") throw new Error("ключ статуса: " + JSON.stringify(statusKey));
		if (!statusVal) throw new Error("бейдж не установлен");
	});
}

await check("dir-guard: /dir-guard персистентен и восстанавливается новым factory", async () => {
	const stFile = join(guardAgentDir, "guard-state.json");
	const readState = () => {
		try {
			return JSON.parse(readFileSync(stFile, "utf8"))["dir-guard"] ?? {};
		} catch {
			return {};
		}
	};
	const before = Boolean(readState().disabled);
	const piP = makePi();
	dirGuard.default(piP);
	const cmd = piP.commands.find((c) => c.name === "dir-guard").def;
	await cmd.handler("", makeCtx(cwd)); // флип → file: !before
	if (readState().disabled !== !before) throw new Error("файл не обновлён: " + JSON.stringify(readState()));
	// Новый factory (имитация /reload): disabled восстановлен из файла — поведение соответствует
	const piNew = makePi();
	dirGuard.default(piNew);
	const resFlipped = await piNew.handlers.tool_call({ toolName: "read", input: { path: "/etc/passwd" } }, makeCtx(cwd));
	if (Boolean(resFlipped?.block) !== before) {
		throw new Error("состояние не восстановлено (ожидалось block=" + before + "): " + JSON.stringify(resFlipped));
	}
	// Возврат в исходный вид: флип на новом factory (file → before) + поведение соответствует
	await piNew.commands.find((c) => c.name === "dir-guard").def.handler("", makeCtx(cwd));
	if (readState().disabled !== before) throw new Error("не вернули исходное состояние: " + JSON.stringify(readState()));
	const resBack = await piNew.handlers.tool_call({ toolName: "read", input: { path: "/etc/passwd" } }, makeCtx(cwd));
	if (Boolean(resBack?.block) !== !before) {
		throw new Error("после возврата поведение неверно (ожидалось block=" + !before + "): " + JSON.stringify(resBack));
	}
});

// === инструменты поиска: у них тоже есть input.path (найдённая дыра) ===
pinGuardState(false);
{
	const pi = makePi();
	dirGuard.default(pi);
	const handler = pi.handlers.tool_call;
	const ctx = makeCtx(cwd);
	const ssh = join(base, ".ssh", "id_ed25519");

	for (const tool of ["grep", "find", "ls"]) {
		await check(`(${tool}) путь наружу блокируется так же, как у read`, async () => {
			const res = await handler({ toolName: tool, input: { pattern: "x", path: outside } }, ctx);
			if (!res?.block) throw new Error(`${tool} наружу пропущен: ${JSON.stringify(res)}`);
		});
	}

	await check("grep по ключу блокируется (то же, что cat ключа)", async () => {
		const res = await handler({ toolName: "grep", input: { pattern: "pass", path: join(base, ".ssh") } }, ctx);
		if (!res?.block) throw new Error("grep по ~/.ssh пропущен");
		if (!ssh.startsWith(base)) throw new Error("фикстура вне базы");
	});

	for (const tool of ["grep", "find", "ls"]) {
		await check(`(${tool}) path внутри CWD и опущенный path прощаются`, async () => {
			if (await handler({ toolName: tool, input: { pattern: "x", path: cwd } }, ctx)) throw new Error("внутренний path заблокирован");
			if (await handler({ toolName: tool, input: { pattern: "x" } }, ctx)) throw new Error("опущенный path заблокирован");
		});
	}
}

// === разбор bash: кавычки, флаги и присваивания не прячут путь ===
pinGuardState(false);
{
	const pi = makePi();
	dirGuard.default(pi);
	const handler = pi.handlers.tool_call;
	const ctx = makeCtx(cwd);

	const blocked = async (command, label) => {
		const res = await handler({ toolName: "bash", input: { command } }, ctx);
		if (!res?.block) throw new Error(`${label} пропущен: ${command}`);
	};
	const passed = async (command, label) => {
		const res = await handler({ toolName: "bash", input: { command } }, ctx);
		if (res) throw new Error(`ложный блок (${label}): ${command} → ${JSON.stringify(res)}`);
	};

	await check("bash: путь в кавычках блокируется", async () => {
		await blocked('cat "/etc/passwd"', "в двойных кавычках");
		await blocked("cat '/etc/passwd'", "в одинарных кавычках");
	});

	await check("bash: путь после флага (--file=, -C) блокируется", async () => {
		await blocked("sed --file=/etc/hosts/x sedscript", "флаг со значением");
	});

	await check("bash: точка с запятой в кавычках не режет команду пополам", async () => {
		await blocked('echo "a; b" ; cat /etc/shadow', "путь после кавычки");
		await passed('grep "a ; b" notes.txt', "внутренний разделитель в кавычках");
	});

	await check("bash: sed/awk-адрес — не путь (ложный блок на текстах)", async () => {
		await passed("sed -n '/^## Заголовки/,/^```$/p' README.md", "адрес sed");
		await passed("awk -F: '{print $1}' users.csv | head", "awk по файлу в CWD");
	});

	await check("bash: относительный путь с .. в середине блокируется", async () => {
		await blocked("cat src/../../../etc/passwd", ".. в середине");
	});
}

rmSync(base, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
