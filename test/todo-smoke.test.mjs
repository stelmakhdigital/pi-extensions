/**
 * Смоук-тест todo: jiti + стаб ExtensionAPI.
 * Запуск: node test/todo-smoke.test.mjs
 */
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { isolateGuardEnv } from "./env.mjs";
isolateGuardEnv();

const jiti = createJiti(fileURLToPath(import.meta.url));
const todoExt = jiti("../extensions/todo/index.ts");

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

function makePi() {
	const handlers = {};
	const tools = {};
	const commands = {};
	const shortcuts = {};
	return {
		handlers,
		tools,
		commands,
		shortcuts,
		on: (event, fn) => {
			handlers[event] = fn;
		},
		registerTool: (t) => {
			tools[t.name] = t;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		registerShortcut: (key, def) => {
			shortcuts[key] = def;
		},
		registerFlag: () => {},
		getFlag: () => false,
	};
}

/** ctx с записью UI-вызовов (виджет/статус/уведомления). */
function makeCtx(extra = {}) {
	const ui = {
		widgets: {},
		statuses: {},
		notes: [],
		setWidget: (key, lines) => {
			ui.widgets[key] = lines;
		},
		setStatus: (key, text) => {
			ui.statuses[key] = text;
		},
		notify: (m) => ui.notes.push(m),
		custom: async (factory) => {
			ui.overlay = factory(null, theme, null, () => {});
			return undefined;
		},
		theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s, strikethrough: (s) => s },
	};
	const theme = ui.theme;
	ui.theme = theme;
	return { mode: "tui", hasUI: true, cwd: process.cwd(), ui, ...extra };
}

/** ctx без TUI (rpc/print) — виджет рисовать нельзя. */
const headlessCtx = () => makeCtx({ mode: "rpc", hasUI: true });

/** В ctx-«сессию» с нужной веткой: getBranch возвращает переданные todo-details. */
function withBranch(ctx, ...detailsList) {
	ctx.sessionManager = {
		getBranch: () =>
			detailsList.map((details) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details } })),
	};
	return ctx;
}

const load = () => {
	const pi = makePi();
	todoExt.default(pi);
	return { pi, tool: pi.tools.todo };
};
const widgetText = (ctx) => (ctx.ui.widgets[" todo"] ?? []).join("\n");

await check("add рисует виджет и бейдж счётчика", async () => {
	const { tool } = load();
	const ctx = makeCtx();
	const res = await tool.execute("c1", { action: "add", text: "починить тесты" }, undefined, undefined, ctx);
	assert(/починить тесты/.test(widgetText(ctx)), "нет пункта в виджете: " + widgetText(ctx));
	assert(ctx.ui.statuses[" a-todo"] === " 0/1 ", "бейдж: " + ctx.ui.statuses[" a-todo"]);
	assert(res.details.todos.length === 1 && res.details.nextId === 2, "details: " + JSON.stringify(res.details));
});

await check("toggle закрывает пункт и обновляет счётчик", async () => {
	const { tool } = load();
	const ctx = makeCtx();
	await tool.execute("c1", { action: "add", text: "шаг 1" }, undefined, undefined, ctx);
	const res = await tool.execute("c2", { action: "toggle", id: 1 }, undefined, undefined, ctx);
	assert(/1\/1/.test(res.content[0].text) && /всё готово/.test(res.content[0].text), "текст: " + res.content[0].text);
	assert(/☑ 1 готово/.test(widgetText(ctx)), "виджет: " + widgetText(ctx));
	assert(ctx.ui.statuses[" a-todo"] === " 1/1 ", "бейдж: " + ctx.ui.statuses[" a-todo"]);
});

await check("виджет не разрастается: больше 6 открытых — свёрнуто в «ещё N»", async () => {
	const { tool } = load();
	const ctx = makeCtx();
	for (let i = 1; i <= 9; i++) await tool.execute(`c${i}`, { action: "add", text: `шаг ${i}` }, undefined, undefined, ctx);
	const lines = ctx.ui.widgets[" todo"];
	assert(lines.length === 1 + 6 + 1, `строк виджета: ${lines.length} (${JSON.stringify(lines)})`);
	assert(/ещё 3/.test(lines.at(-1)), "нет свёртки: " + lines.at(-1));
});

await check("clear убирает виджет и бейдж", async () => {
	const { tool } = load();
	const ctx = makeCtx();
	await tool.execute("c1", { action: "add", text: "шаг" }, undefined, undefined, ctx);
	await tool.execute("c2", { action: "clear" }, undefined, undefined, ctx);
	assert(ctx.ui.widgets[" todo"] === undefined, "виджет остался: " + widgetText(ctx));
	assert(ctx.ui.statuses[" a-todo"] === undefined, "бейдж остался");
});

await check("list ничего меняет, toggle без id и чужой id — ошибка", async () => {
	const { tool } = load();
	const ctx = makeCtx();
	await tool.execute("c1", { action: "add", text: "шаг" }, undefined, undefined, ctx);
	const before = widgetText(ctx);
	const list = await tool.execute("c2", { action: "list" }, undefined, undefined, ctx);
	assert(/шаг/.test(list.content[0].text) && widgetText(ctx) === before, "list изменил виджет: " + widgetText(ctx));
	const noId = await tool.execute("c3", { action: "toggle" }, undefined, undefined, ctx);
	const badId = await tool.execute("c4", { action: "toggle", id: 42 }, undefined, undefined, ctx);
	assert(noId.details.error && badId.details.error, "ошибки нет");
	assert(widgetText(ctx) === before, "виджет изменился на ошибке");
});

await check("состояние восстанавливается из ветки (session_start, /reload)", async () => {
	const { pi } = load();
	const ctx = withBranch(makeCtx(), { todos: [{ id: 1, text: "из истории", done: true }, { id: 2, text: "в работе", done: false }], nextId: 3 });
	await pi.handlers.session_start({}, ctx);
	assert(/из истории|в работе/.test(widgetText(ctx)), "не восстановлено: " + widgetText(ctx));
	assert(ctx.ui.statuses[" a-todo"] === " 1/2 ", "бейдж: " + ctx.ui.statuses[" a-todo"]);
	// следующий add обязан продолжить нумерацию с nextId
	const res = await pi.tools.todo.execute("c1", { action: "add", text: "новый" }, undefined, undefined, ctx);
	assert(res.details.todos[2].id === 3, "nextId не восстановлен: " + JSON.stringify(res.details));
});

await check("session_tree (переход по ветке) пересобирает список", async () => {
	const { pi } = load();
	const ctx = makeCtx();
	await pi.tools.todo.execute("c1", { action: "add", text: "текущая ветка" }, undefined, undefined, ctx);
	await pi.handlers.session_tree({}, withBranch(ctx, { todos: [{ id: 7, text: "другая ветка", done: false }], nextId: 8 }));
	assert(/другая ветка/.test(widgetText(ctx)) && !/текущая ветка/.test(widgetText(ctx)), "не переключилось: " + widgetText(ctx));
});

await check("без TUI виджет не рисуется, /todos отдаёт текст", async () => {
	const { pi } = load();
	const ctx = withBranch(headlessCtx());
	await pi.handlers.session_start({}, ctx);
	await pi.tools.todo.execute("c1", { action: "add", text: "headless шаг" }, undefined, undefined, ctx);
	assert(Object.keys(ctx.ui.widgets).length === 0, "виджет вызван в rpc: " + JSON.stringify(ctx.ui.widgets));
	await pi.commands.todos.handler("", ctx);
	assert(/headless шаг|пуст/.test(ctx.ui.notes.join("\n")), "нет уведомление: " + ctx.ui.notes.join("\n"));
});

await check("/todos и shift+ctrl+o открывают оверлей со списком", async () => {
	const { pi } = load();
	const ctx = makeCtx();
	await pi.tools.todo.execute("c1", { action: "add", text: "виден в оверлее" }, undefined, undefined, ctx);
	await pi.commands.todos.handler("", ctx);
	assert(ctx.ui.overlay, "оверлей не открыт");
	assert(/виден в оверлее/.test(ctx.ui.overlay.render(60).join("\n")), "оверлей без пункта");
	await pi.shortcuts["shift+ctrl+o"].handler(ctx);
	assert(ctx.ui.overlay, "shift+ctrl+o не открыл оверлей");
	// ctrl+o занят pi (app.tools.expand): регистрация этого ключа дала бы warning и "Skipping"
	assert(pi.shortcuts["ctrl+o"] === undefined && pi.shortcuts["alt+t"] === undefined, "неожиданные клавиши: " + Object.keys(pi.shortcuts));
});

await check("session_shutdown снимает виджет и бейдж", async () => {
	const { pi } = load();
	const ctx = makeCtx();
	await pi.tools.todo.execute("c1", { action: "add", text: "шаг" }, undefined, undefined, ctx);
	await pi.handlers.session_shutdown({}, ctx);
	assert(ctx.ui.widgets[" todo"] === undefined && ctx.ui.statuses[" a-todo"] === undefined, "не снято");
});

console.log(results.join("\n"));
process.exit(results.filter((r) => r.startsWith("FAIL")).length ? 1 : 0);
