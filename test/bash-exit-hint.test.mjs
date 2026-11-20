/**
 * Смоук-тест bash-exit-hint: jiti + стаб ExtensionAPI.
 * Запуск: node test/bash-exit-hint.test.mjs
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));
const hint = jiti("../extensions/bash-exit-hint/index.ts");

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

const pi = { on: (event, fn) => { pi.handler = fn; }, registerFlag: () => {}, getFlag: () => false };
hint.default(pi);

const ev = (command, code = 1) => ({
	type: "tool_result",
	toolName: "bash",
	toolCallId: "t",
	input: { command },
	content: [{ type: "text", text: `output\n\nCommand exited with code ${code}` }],
	isError: true,
});

{
	await check("grep exit 1 → ошибка снята, пояснение добавлено", async () => {
		const res = await pi.handler(ev("grep foo a.txt"));
		if (!res || res.isError !== false) throw new Error("не снят isError: " + JSON.stringify(res));
		if (!res.content.some((c) => c.text.includes("штатный код"))) throw new Error("нет пояснения");
	});

	await check("diff/пайп/цепочка ; и флаг -e — тоже штатные", async () => {
		for (const cmd of ["diff a.txt b.txt", "cat log | grep foo", "grep a f1; grep b f2", "/usr/bin/grep -e pat f", "LANG=C grep x f"]) {
			const res = await pi.handler(ev(cmd));
			if (!res || res.isError !== false) throw new Error(`не снят isError для "${cmd}"`);
		}
	});

	await check("нерозыскные утилиты не прикрываются", async () => {
		for (const cmd of ["rm -rf build", "python3 deploy.py", "git push", "make test"]) {
			const res = await pi.handler(ev(cmd));
			if (res !== undefined) throw new Error(`прикрыта команда "${cmd}": ${JSON.stringify(res)}`);
		}
	});

	await check("exit >= 2 не трогается", async () => {
		const res = await pi.handler(ev("grep foo /nonexistent/file", 2));
		if (res !== undefined) throw new Error("снят реальный сбой: " + JSON.stringify(res));
	});

	await check("успешный результат не трогается", async () => {
		const e = ev("grep foo a.txt");
		e.isError = false;
		const res = await pi.handler(e);
		if (res !== undefined) throw new Error("трогает успех: " + JSON.stringify(res));
	});

	await check("не-bash результаты игнорируются", async () => {
		const e = ev("grep foo a.txt");
		e.toolName = "edit";
		const res = await pi.handler(e);
		if (res !== undefined) throw new Error("лезет не в bash: " + JSON.stringify(res));
	});
}

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
