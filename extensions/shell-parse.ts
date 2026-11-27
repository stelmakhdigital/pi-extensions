/**
 * Разбор shell-команд на один лад. Общий для bash-guard (оценка риска),
 * dir-guard (какие пути трогает команда) и bash-exit-hint (какая утилита даёт
 * код выхода). До этого модуля каждый из трёх парсил по-своему: shell-quote,
 * `split(/\s+/)` и `split(/&&|\|\||;/)` — расходились они на кавычках, и
 * `grep "a && b" f` для одного guard'а был одной командой, для другого двумя.
 *
 * shell-quote раскрывает `$ПЕРЕМЕННЫЕ` по process.env. Кому нужно оставить
 * их неразрешимыми (dir-guard сознательно не блокирует то, чего нельзя
 * разрешить), просит keepVariables.
 */
import { parse as shellParse } from "shell-quote";

export type OpToken = { op: string; [k: string]: unknown };
export type Token = string | OpToken;

const CHAIN_OPS = ["&&", "||", ";"];

/**
 * Физические строки команды: shell-quote перевод строки не считает оператором
 * (`grep a f\nmake deploy` для него одна команда из пяти слов), а для bash это
 * две команды. Скан учитывает кавычки, чтобы `awk 'BEGIN\n{...}'` не резалось.
 */
export function physicalLines(command: string): string[] {
	const lines: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			cur += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "\\") {
			cur += ch + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "\n") {
			lines.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	lines.push(cur);
	return lines.filter((l) => l.trim());
}

export function isOpToken(t: Token): t is OpToken {
	return typeof t === "object" && t !== null && "op" in t;
}

/**
 * Токены одной команды. keepVariables оставляет `$VAR` неразрешёнными (их нельзя
 * канонить — guard'ы на них не блокируют), по умолчанию shell-quote раскрывает
 * их по process.env.
 */
export function parseTokens(line: string, opts: { keepVariables?: boolean } = {}): Token[] {
	const env = opts.keepVariables ? (key: string) => `$${key}` : undefined;
	return (env ? shellParse(line, env) : shellParse(line)) as Token[];
}

export function tokensToStrings(tokens: Token[]): string[] {
	return tokens.filter((t): t is string => typeof t === "string");
}

/** Разбить поток токенов на куски по операторам (операторы выбрасываются). */
export function splitOnOps(tokens: Token[], splitOps: string[]): Token[][] {
	const out: Token[][] = [];
	let current: Token[] = [];
	for (const t of tokens) {
		if (isOpToken(t) && splitOps.includes(t.op)) {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		current.push(t);
	}
	if (current.length) out.push(current);
	return out;
}

export function chainOpsOf(tokens: Token[]): string[] {
	return tokens.filter(isOpToken).map((t) => t.op);
}

/**
 * Головная утилита аргументов: первая не-переменная после снятия `VAR=value`
 * и пути к бинарю. null — разобрать не во что (пусто, только переменные).
 */
export function headUtility(argv: string[]): string | null {
	for (const tok of argv) {
		if (!tok || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
		return tok.slice(tok.lastIndexOf("/") + 1);
	}
	return null;
}

/**
 * Головные утилиты, чей код выхода и есть код всей команды: для каждого
 * сегмента цепочки (`&&`, `||`, `;`, перевод строки) — первая утилита
 * последней стадии конвейера (у пайпа код берёт последняя команда).
 * null, если хотя бы один сегмент неразрешим (глоб, пустота): caller не должен
 * делать выводов о всей команде по разобранной её части.
 */
export function chainHeads(command: string): string[] | null {
	const heads: string[] = [];
	for (const line of physicalLines(command)) {
		const headsOfLine = lineHeads(line);
		if (!headsOfLine) return null;
		heads.push(...headsOfLine);
	}
	return heads.length ? heads : null;
}

function lineHeads(line: string): string[] | null {
	let tokens: Token[];
	try {
		tokens = parseTokens(line, { keepVariables: true });
	} catch {
		return null;
	}
	const heads: string[] = [];
	for (const segment of splitOnOps(tokens, CHAIN_OPS)) {
		const stages = splitOnOps(segment, ["|"]);
		const last = stages[stages.length - 1];
		if (!last) return null;
		const head = headUtility(tokensToStrings(last));
		if (!head) return null;
		heads.push(head);
	}
	return heads.length ? heads : null;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);

/**
 * Сегменты команды как списки аргументов: физические строки × цепочки (`&&`,
 * `||`, `;`), вложенное `sh -c "..."` разворачивается в те же сегменты
 * (глубина ≤ depth). Это то, по чему надо матчить правила: `echo "rm -rf /"`
 * даёт сегмент с головой `echo`, а не строку, в которой что-то есть.
 */
export function commandSegments(command: string, depth = 2, keepVariables = false): string[][] {
	const out: string[][] = [];
	const walk = (source: string, level: number) => {
		for (const line of physicalLines(source)) {
			let tokens: Token[];
			try {
				tokens = parseTokens(line, { keepVariables });
			} catch {
				continue;
			}
			for (const segment of splitOnOps(tokens, CHAIN_OPS)) {
				const argv = tokensToStrings(segment);
				if (!argv.length) continue;
				out.push(argv);
				if (level <= 0) continue;
				const head = headUtility(argv);
				if (!head || !SHELLS.has(head)) continue;
				// `bash -c "<скрипт>"`, `bash -lic "<скрипт>"`: аргумент после флага с c
				const cFlag = argv.findIndex((a, i) => i > 0 && /^-[a-zA-Z]*c$/.test(a));
				const script = cFlag >= 0 ? argv[cFlag + 1] : undefined;
				if (script) walk(script, level - 1);
			}
		}
	};
	walk(command, depth);
	return out;
}

/** Сегменты в виде строк (для правил-регулярок): аргументы через один пробел. */
export function segmentStrings(command: string, depth = 2, keepVariables = false): string[] {
	return commandSegments(command, depth, keepVariables).map((argv) => argv.join(" "));
}

/** URL-схема в начале токена (`https://…`, `s3://…`) — это не файловый путь. */
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function candidateFrom(word: string): string | null {
	const w = word.trim();
	if (!w || URL_RE.test(w)) return null;
	// sed/awk-адреса и регулярки (`sed -n '/^## Х/,/^```$/p'`, `y|^|/|`): на вид
	// абсолютный путь, а по факту текст. `^` в файловом пути — экзотика,
	// ложный блок на таком токене мешает чаще, чем ловит что-то реальное.
	if (w.includes("^")) return null;
	// `//etc/x` bash читает как `/etc/x`, а realpath на POSIX оставляет `//` как есть.
	const norm = (s: string) => s.replace(/\/\/+/g, "/");
	// Присваивание окружения: значение и есть путь (`HOME=/etc x cmd`).
	const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
	if (assign && assign[2]) return candidateFrom(assign[2]);
	// Флаг со значением: `--file=/etc/x`, `-C/tmp`, `--exclude=/etc`.
	if (w.startsWith("-")) {
		const body = w.replace(/^--?/, "");
		const eq = body.indexOf("=");
		const value = eq >= 0 ? body.slice(eq + 1) : body;
		const slash = value.indexOf("/");
		if (slash < 0) return null;
		return norm(value.slice(slash));
	}
	if (w.startsWith("/") || w.startsWith("~") || w.startsWith("./") || w.startsWith("../")) return norm(w);
	// Относительный путь с `..` в середине (`a/../../x`) тоже уводит из CWD.
	if (/(^|\/)\.\.\//.test(w)) return norm(w);
	return null;
}

/**
 * Путь-подобные слова команды. Globs (`a*.txt`) и операторы не возвращаются:
 * разрешить их нельзя, а блокировать наугад — значит ловить ложные срабатывания
 * (осознанный компромисс dir-guard, см. его шапку). Односегментные абсолютные
 * пути (`/models`, `/app`) не возвращаются тоже: в bash-командах это почти
 * всегда пути внутри контейнера, а не хостовые.
 */
export function pathCandidates(command: string): string[] {
	let tokens: Token[];
	try {
		tokens = parseTokens(command, { keepVariables: true });
	} catch {
		return [];
	}
	const found = new Set<string>();
	for (const t of tokens) {
		if (typeof t !== "string") continue;
		const c = candidateFrom(t);
		if (!c || c === "/dev/null") continue;
		if (c.startsWith("/") && !c.slice(1).includes("/")) continue;
		found.add(c);
	}
	return [...found];
}
