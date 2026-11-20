/**
 * Смоук-тест edit-fresh: jiti + стаб ExtensionAPI.
 * Запуск: node test/edit-fresh-smoke.test.mjs
 */
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(fileURLToPath(import.meta.url));
const editFresh = jiti("../extensions/edit-fresh/index.ts");

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

function makePi(overrides = {}) {
	const handlers = {};
	return {
		handlers,
		on: (event, fn) => { handlers[event] = fn; },
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		getFlag: (name) => overrides[name] ?? false,
	};
}

function makeCtx(cwd) {
	return {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
		},
	};
}

const base = join(tmpdir(), `pi-edit-fresh-test-${process.pid}`);
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });
const file = join(cwd, "a.txt");
writeFileSync(file, "one\n");

const pi = makePi();
editFresh.default(pi);
const onCall = pi.handlers.tool_call;
const onResult = pi.handlers.tool_result;
const ctx = makeCtx(cwd);

const editCall = () => onCall({ type: "tool_call", toolName: "edit", toolCallId: "t", input: { path: "a.txt", edits: [] } }, ctx);
const readResult = (isError = false) => onResult({ type: "tool_result", toolName: "read", toolCallId: "t", input: { path: "a.txt" }, content: [], isError }, ctx);
const touchExternal = () => utimesSync(file, new Date(), new Date(Date.now() + 5000));

{
	await check("edit без предварительного read блокируется", async () => {
		const res = await editCall();
		if (!res?.block || !res.reason.includes("edit-fresh")) throw new Error("нет блока: " + JSON.stringify(res));
	});

	await check("после успешного read edit проходит", async () => {
		await readResult();
		const res = await editCall();
		if (res !== undefined) throw new Error("ложный блок: " + JSON.stringify(res));
	});

	await check("ошибочный read не считается (снова блок)", async () => {
		touchExternal();
		await readResult(true);
		const res = await editCall();
		if (!res?.block) throw new Error("нет блока после failed read: " + JSON.stringify(res));
	});

	await check("внешнее изменение файла после read блокирует edit", async () => {
		touchExternal(); // mtime ушёл вперёд относительно записанного
		const res = await editCall();
		if (!res?.block) throw new Error("нет блока: " + JSON.stringify(res));
		await readResult();
		const after = await editCall();
		if (after !== undefined) throw new Error("не разблокировался после перечитывания: " + JSON.stringify(after));
	});

	await check("edit несуществующего файла не блокируется (скажет сам edit)", async () => {
		const res = await onCall({ type: "tool_call", toolName: "edit", toolCallId: "t", input: { path: "ghost.txt", edits: [] } }, ctx);
		if (res !== undefined) throw new Error("ложный блок: " + JSON.stringify(res));
	});

	await check("не-edit вызовы не проверяются", async () => {
		const res = await onCall({ type: "tool_call", toolName: "write", toolCallId: "t", input: { path: "b.txt", content: "x" } }, ctx);
		if (res !== undefined) throw new Error("write не должен блокироваться");
	});

	await check("--edit-fresh-disabled отключает блокировки", async () => {
		const pi2 = makePi({ "edit-fresh-disabled": true });
		editFresh.default(pi2);
		if (pi2.handlers.tool_call) throw new Error("хендлеры зарегистрированы несмотря на флаг");
	});

	await check("read+edit в одном ходе (preflight без tool_result) не блокируется", async () => {
		const f = join(cwd, "batch.txt");
		writeFileSync(f, "one\n");
		// префлайт: tool_call(read) затем tool_call(edit), results ещё не пришли
		await onCall({ type: "tool_call", toolName: "read", toolCallId: "b1", input: { path: "batch.txt" } }, ctx);
		const res = await onCall({ type: "tool_call", toolName: "edit", toolCallId: "b2", input: { path: "batch.txt", edits: [] } }, ctx);
		if (res !== undefined) throw new Error("ложный блок read+edit в одном ходе: " + JSON.stringify(res));
	});

	await check("write+edit нового файла в одном ходе не блокируется", async () => {
		await onCall({ type: "tool_call", toolName: "write", toolCallId: "b3", input: { path: "new-batch.txt", content: "x" } }, ctx);
		const res = await onCall({ type: "tool_call", toolName: "edit", toolCallId: "b4", input: { path: "new-batch.txt", edits: [] } }, ctx);
		if (res !== undefined) throw new Error("ложный блок write+edit: " + JSON.stringify(res));
	});

	await check("неудавшийся write снимает пендинг (edit существующего файла снова блокируется)", async () => {
		const f = join(cwd, "wfail.txt");
		writeFileSync(f, "one\n");
		await onCall({ type: "tool_call", toolName: "write", toolCallId: "b5", input: { path: "wfail.txt", content: "y" } }, ctx);
		await onResult({ type: "tool_result", toolName: "write", toolCallId: "b5", input: { path: "wfail.txt" }, content: [], isError: true }, ctx);
		const res = await onCall({ type: "tool_call", toolName: "edit", toolCallId: "b6", input: { path: "wfail.txt", edits: [] } }, ctx);
		if (!res?.block) throw new Error("после failed-write edit не заблокирован (пендинг не снят)");
	});
}

rmSync(base, { recursive: true, force: true });
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
