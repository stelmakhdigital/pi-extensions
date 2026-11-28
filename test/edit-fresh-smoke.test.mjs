/**
 * Смоук-тест edit-fresh: jiti + стаб ExtensionAPI.
 * Запуск: node test/edit-fresh-smoke.test.mjs
 */
import { mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

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

// === подсказка при промахе oldText ===
{
	const f = join(cwd, "hint.txt");
	writeFileSync(f, "package main\n\nfunc main() {\n\tif err != nil {\n\t\treturn err\n\t}\n}\n");
	// файл «свежий»: read в этой сессии был
	await onResult({ type: "tool_result", toolName: "read", toolCallId: "h0", input: { path: "hint.txt" }, content: [], isError: false }, ctx);

	const editErr = (oldText, msg, id = "h1") => onResult({
		type: "tool_result",
		toolName: "edit",
		toolCallId: id,
		input: { path: "hint.txt", edits: [{ oldText, newText: "x" }] },
		content: [{ type: "text", text: msg }],
		isError: true,
	}, ctx);
	const joined = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");

	await check("промах oldText: в ответ добавлен реальный фрагмент с табами", async () => {
		const res = await editErr(
			"func main() {\n if err != nil {\n  return err\n }\n}",
			"Could not find the exact text in hint.txt. The old text must match exactly including all whitespace and newlines.",
		);
		const text = joined(res);
		if (!text.includes("edit-hint:")) throw new Error("нет подсказки: " + JSON.stringify(res));
		if (!text.includes("\tif err != nil {")) throw new Error("во фрагменте потеряны табы: " + JSON.stringify(text));
		if (!text.includes("Could not find the exact text")) throw new Error("пропал исходный текст ошибки");
	});

	await check("совпадений нет вовсе — подсказки нет", async () => {
		const res = await editErr(
			"zzz такой строки в файле нет",
			"Could not find the exact text in hint.txt. The old text must match exactly including all whitespace and newlines.",
			"h2",
		);
		if (res !== undefined) throw new Error("выдумана подсказка: " + JSON.stringify(res));
	});

	await check("oldText не уникален — подсказка с номерами строк", async () => {
		const f2 = join(cwd, "hint2.txt");
		writeFileSync(f2, "one\n\trepeat\nthree\n\trepeat\n");
		await onResult({ type: "tool_result", toolName: "read", toolCallId: "h3a", input: { path: "hint2.txt" }, content: [], isError: false }, ctx);
		const res = await onResult({
			type: "tool_result",
			toolName: "edit",
			toolCallId: "h3",
			input: { path: "hint2.txt", edits: [{ oldText: "\trepeat", newText: "x" }] },
			content: [{ type: "text", text: "Found 2 occurrences of edits[0] in hint2.txt. Each oldText must be unique." }],
			isError: true,
		}, ctx);
		const text = joined(res);
		if (!text.includes("edit-hint:") || !text.includes("2, 4")) throw new Error("нет номеров вхождений: " + JSON.stringify(res));
	});

	await check("успешный edit и чужие ошибки подсказки не получают", async () => {
		const ok = await onResult({
			type: "tool_result", toolName: "edit", toolCallId: "h4",
			input: { path: "hint.txt", edits: [{ oldText: "package main", newText: "//go:build x" }] },
			content: [{ type: "text", text: "ok" }], isError: false,
		}, ctx);
		if (ok !== undefined) throw new Error("подсказка к успешному edit: " + JSON.stringify(ok));
		const other = await onResult({
			type: "tool_result", toolName: "edit", toolCallId: "h5",
			input: { path: "hint.txt", edits: [{ oldText: "package main", newText: "x" }] },
			content: [{ type: "text", text: "Validation failed for tool \"edit\": edits.0: expected object" }], isError: true,
		}, ctx);
		if (other !== undefined) throw new Error("подсказка не к промаху oldText: " + JSON.stringify(other));
	});
}

// === один файл под разными путями (symlink) ===
{
	const base2 = join(tmpdir(), `edit-fresh-link-${process.pid}`);
	mkdirSync(base2, { recursive: true });
	const dir = join(base2, "proj");
	mkdirSync(dir, { recursive: true });
	const target = join(dir, "real.txt");
	writeFileSync(target, "one\n");
	symlinkSync("real.txt", join(dir, "link.txt"));

	const pi = makePi();
	editFresh.default(pi);
	const onCall = pi.handlers.tool_call;
	const ctx = makeCtx(dir);

	await check("read по symlink'у считает файл прочитанным для edit реального пути", async () => {
		await onCall({ type: "tool_call", toolName: "read", toolCallId: "l1", input: { path: "link.txt" } }, ctx);
		const res = await onCall({ type: "tool_call", toolName: "edit", toolCallId: "l2", input: { path: "real.txt", edits: [] } }, ctx);
		if (res !== undefined) throw new Error("ложный блок после read по symlink: " + JSON.stringify(res));
	});

	await check("обратный порядок (read реального → edit symlink'а) тоже проходит", async () => {
		const pi2 = makePi();
		editFresh.default(pi2);
		const call2 = pi2.handlers.tool_call;
		await call2({ type: "tool_call", toolName: "read", toolCallId: "l3", input: { path: "real.txt" } }, ctx);
		const res = await call2({ type: "tool_call", toolName: "edit", toolCallId: "l4", input: { path: "link.txt", edits: [] } }, ctx);
		if (res !== undefined) throw new Error("ложный блок после read реального пути: " + JSON.stringify(res));
	});

	rmSync(base2, { recursive: true, force: true });
}

rmSync(base, { recursive: true, force: true });
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
