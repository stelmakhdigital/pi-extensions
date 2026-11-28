/**
 * todo: живой список задач над полем ввода.
 *
 * Pi, в отличие от других агентов, встроенного todo не имеет, а для длинного
 * автономного прогона (yolo, subagents) без внешнего плана непонятно, на чём
 * модель остановилась. Здесь — инструмент `todo` + виджет, который виден всё
 * время, пока идёт работа.
 *
 * Механика состояния (как в bundled примере examples/extensions/todo.ts):
 * состояние живёт в `details` результата инструмента, а не в файле. После
 * `/reload`, рестарта или перехода по ветке (`session_tree`) список
 * восстанавливается проходом по ветке сессии — и корректен для любой ветки,
 * потому что берётся из истории, а не из глобального файла.
 *
 * `pi-commander` (pipeline) к списку не причём: у него spec в task.md и своя
 * итерационная логика. Здесь — рабочий чек-лист интерактивной сессии.
 *
 * UI:
 * - виджет над редактором: `☐`/`☑`, счётчик, cap на 6 строк (дальше — «ещё N»);
 * - `/todos` (`alt+t`) — полноэкранный список, Escape закрывает;
 * - бейдж `2/5` в футере — когда виджет не виден (другое расширение заняло
 *   место, либо прогон без TUI).
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("toggle"), Type.Literal("clear")], {
		description: 'list | add | toggle | clear',
	}),
	text: Type.Optional(Type.String({ description: "Формулировка задачи (для add)" })),
	id: Type.Optional(Type.Number({ description: "id задачи (для toggle)" })),
});

const WIDGET_KEY = " todo"; // ключ с пробелом: сортировка футера/виджетов (см. AGENTS.md)
const STATUS_KEY = " a-todo";
const MAX_WIDGET_ITEMS = 6;
/** Результат add/toggle, из которого восстанавливаем состояние. */
const ok = (todos: Todo[], nextId: number, text: string): AgentToolResult<TodoDetails> => ({
	content: [{ type: "text", text }],
	details: { todos: todos.map((t) => ({ ...t })), nextId },
});
const fail = (todos: Todo[], nextId: number, error: string): AgentToolResult<TodoDetails> => ({
	content: [{ type: "text", text: `todo: ${error}` }],
	details: { todos: todos.map((t) => ({ ...t })), nextId, error },
});

function progress(todos: Todo[]): { done: number; total: number } {
	return { done: todos.filter((t) => t.done).length, total: todos.length };
}

/** Строки виджета: незакрытые сверху, закрытые — одной строкой-счётчиком. */
function widgetLines(todos: Todo[], theme: Theme): string[] {
	const { done, total } = progress(todos);
	const open = todos.filter((t) => !t.done);
	const shown = open.slice(0, MAX_WIDGET_ITEMS);
	const lines = [theme.fg("accent", ` задачи ${done}/${total} `)];
	for (const t of shown) lines.push(`  ${theme.fg("warning", "☐")} ${theme.fg("text", t.text)}`);
	const hidden = open.length - shown.length;
	if (hidden > 0) lines.push(theme.fg("dim", `  … ещё ${hidden} (alt+t)`));
	if (done > 0) lines.push(theme.fg("dim", `  ☑ ${done} готово`));
	return lines;
}

class TodoOverlay {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private todos: Todo[], private theme: Theme, private onClose: () => void) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const { done, total } = progress(this.todos);
		const lines: string[] = [""];
		const title = th.fg("accent", " Задачи ");
		lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10))), width));
		lines.push("");
		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "Список пуст — попроси модель разбить задачу на шаги")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${total} готово`)}`, width));
			lines.push("");
			for (const t of this.todos) {
				const check = t.done ? th.fg("success", "☑") : th.fg("warning", "☐");
				const id = th.fg("accent", `#${t.id}`);
				const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}
		lines.push("", truncateToWidth(`  ${th.fg("dim", "Escape — закрыть")}`, width), "");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;

	/** Состояние — из истории текущей ветки: любой `todo`-результат перекрывает предыдущее. */
	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; toolName?: string; details?: TodoDetails };
			if (msg?.role !== "toolResult" || msg.toolName !== "todo" || !msg.details) continue;
			todos = Array.isArray(msg.details.todos) ? msg.details.todos : [];
			nextId = typeof msg.details.nextId === "number" ? msg.details.nextId : nextId;
		}
	};

	const paint = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const { done, total } = progress(todos);
		ctx.ui.setWidget(WIDGET_KEY, total ? widgetLines(todos, ctx.ui.theme) : undefined);
		ctx.ui.setStatus(STATUS_KEY, total ? ctx.ui.theme.fg(done === total ? "success" : "dim", ` ${done}/${total} `) : undefined);
	};

	const showOverlay = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id} ${t.text}`).join("\n") : "todo: список пуст",
				"info",
			);
			return;
		}
		await ctx.ui.custom<void>((_tui, theme, _keys, done) => new TodoOverlay(todos.map((t) => ({ ...t })), theme, () => done()));
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		paint(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		paint(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerTool({
		name: "todo",
		label: "todo",
		description:
			"Рабочий чек-лист сессии: разбей многошаговую задачу на пункты и отмечай выполнение. " +
			"add — добавить пункт, toggle — закрыть/открыть по id, list — показать, clear — очистить. " +
			"Список виден пользователю всё время работы, поэтому им полезно делить непрогресс на шаги.",
		promptSnippet: "Веди чек-лист многошаговых задач: add при планировании, toggle при завершении шага.",
		promptGuidelines: [
			"Перед многошаговой задачей заведи todo-список из 3-8 шагов, отмечай toggle сразу после шага, не в конце.",
			"Если задача одна правка — todo не нужен.",
		],
		parameters: TodoParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return ok(
						todos,
						nextId,
						todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id} ${t.text}`).join("\n") : "Список пуст",
					);
				case "add": {
					const text = params.text?.trim();
					if (!text) return fail(todos, nextId, "add требует text");
					const item: Todo = { id: nextId++, text, done: false };
					todos = [...todos, item];
					paint(ctx);
					const { done, total } = progress(todos);
					return ok(todos, nextId, `Добавлено #${item.id}: ${text} (${done}/${total})`);
				}
				case "toggle": {
					if (params.id === undefined) return fail(todos, nextId, "toggle требует id");
					const item = todos.find((t) => t.id === params.id);
					if (!item) return fail(todos, nextId, `задачи #${params.id} нет`);
					todos = todos.map((t) => (t.id === item.id ? { ...t, done: !t.done } : t));
					paint(ctx);
					const { done, total } = progress(todos);
					const left = todos.filter((t) => !t.done).map((t) => `#${t.id} ${t.text}`);
					return ok(
						todos,
						nextId,
						`#${item.id} ${item.done ? "открыта" : "закрыта"} (${done}/${total})` +
							(left.length ? `\nосталось: ${left.join("; ")}` : "\nвсё готово"),
					);
				}
				case "clear": {
					const n = todos.length;
					todos = [];
					nextId = 1;
					paint(ctx);
					return { content: [{ type: "text", text: `Очищено задач: ${n}` }], details: { todos: [], nextId: 1 } } as AgentToolResult<TodoDetails>;
				}
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			const first = result.content[0];
			const plain = first?.type === "text" ? first.text : "";
			if (!details) return new Text(plain, 0, 0);
			if (details.error) return new Text(theme.fg("error", plain), 0, 0);
			const { done, total } = progress(details.todos);
			let out = theme.fg("muted", `${done}/${total}`);
			const open = details.todos.filter((t) => !t.done);
			const shown = expanded ? details.todos : open.slice(0, 3);
			for (const t of shown) {
				const check = t.done ? theme.fg("success", "☑") : theme.fg("warning", "☐");
				out += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text)}`;
			}
			const hidden = (expanded ? 0 : open.length - shown.length) + (expanded || done === 0 ? 0 : done);
			if (hidden > 0) out += `\n${theme.fg("dim", `… ещё ${hidden}`)}`;
			return new Text(out, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Показать список задач сессии (todo).",
		handler: async (_args, ctx) => {
			await showOverlay(ctx);
		},
	});

	pi.registerShortcut("alt+t", { description: "Показать список задач (todo)", handler: async (ctx) => await showOverlay(ctx) });
}
