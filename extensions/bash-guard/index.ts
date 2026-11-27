import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { commandSegments, headUtility, isOpToken, parseTokens, physicalLines, splitOnOps, tokensToStrings, type Token } from "../shell-parse.ts";
import { loadGuard, saveGuard, shouldResetGuards } from "../guard-state.ts";
import { isYolo } from "../yolo-mode.ts";

/**
 * Перехватывает вызовы инструмента `bash` и применяет разную защиту в зависимости
 * от того, интерактивная ли сессия (главная) или нет (субагент).
 *
 * Анализ: shell-quote построчно (перенос строки — не обход), рекурсия во вложенные
 * `sh -c`/`bash -c` (глубина ≤ 2), строгая проверка флагов (не substring по путям).
 * Read-only git (status/log/diff/…) не спрашивается по умолчанию;
 * --bash-guard-git-strict возвращает режим «спрашивать на любой git».
 */

type Severity = "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((a) => a.startsWith(flag) && flag.length === 2 && a.startsWith("-"));
}

function anyArgStartsWith(args: string[], prefix: string): boolean {
	return args.some((a) => a.startsWith(prefix));
}

/**
 * Кластерный флажок с буквой в ЛЮБОЙ позиции (-r, -rf, -Rf, -fr), а не путь
 * или строка, содержащая «-r». Буква не обязана быть последней: без этого
 * `rm -rf` не давал причину «рекурсивное удаление». Cluster — только короткие
 * флагопакеты (до 4 букв): `-recursive` не считается (это не кластер).
 */
function hasShortFlagWith(args: string[], letters: string): boolean {
	const cluster = /^-[a-zA-Z]{1,4}$/;
	const letter = new RegExp(`[${letters}]`);
	return args.some((a) => cluster.test(a) && letter.test(a));
}

/** Read-only git-подкоманды: не мутируют репозиторий и конфиг. Консервативный список: в сомнении — не read-only. */
function isGitReadonly(sub: string | undefined, subArgs: string[]): boolean {
	if (!sub) return false;
	switch (sub) {
		case "status": case "log": case "diff": case "show": case "describe":
		case "shortlog": case "whatchanged": case "ls-files": case "ls-tree":
		case "rev-parse": case "var": case "help": case "count-objects":
			return true;
		case "reflog":
			return !subArgs.includes("expire");
		case "branch":
			// Только список: нет аргументов или флажки без d/D/m/M/r/R (delete/merge/rename…)
			return subArgs.length === 0 || (subArgs.length > 0 && subArgs.every((a) => a.startsWith("-") && !/[dDmMrR]/.test(a.replace(/^-{1,2}/, ""))));
		case "tag":
			return subArgs.length === 0 || subArgs.includes("-l") || subArgs.includes("--list");
		case "remote":
			return subArgs[0] === "-v" || subArgs[0] === "-V" || subArgs[0] === "show";
		case "stash":
			return subArgs[0] === "list" || subArgs[0] === "show" || subArgs[0] === "status";
		case "config":
			return subArgs.length <= 1 || ["--get", "--list", "--get-regexp", "--get-regexp-all", "get", "list"].includes(subArgs[0]);
		default:
			return false;
	}
}

/**
 * Деструктивные утилиты дисков/томов (Linux: mkfs.*, wipefs, parted, fdisk,
 * gdisk/sgdisk, lsblk, cryptsetup, LVM, zpool; macOS: diskutil, hdiutil, gpt,
 * newfs_*, asr). «*» на конце — префикс имени. Sev по умолчанию «high»;
 * исключение помечено явно.
 */
const DISK_COMMANDS: Array<{ match: string; reason: string; sev?: Severity }> = [
	{ match: "mkfs*", reason: "mkfs (форматирование файловой системы)" },
	{ match: "newfs_*", reason: "newfs_* (форматирование файловой системы)" },
	{ match: "wipefs", reason: "wipefs (стирание сигнатуры диска)" },
	{ match: "diskutil", reason: "diskutil (команда управления дисками)" },
	{ match: "hdiutil", reason: "hdiutil (команда управления образами дисков)" },
	{ match: "gpt", reason: "gpt (манипуляции с таблицей разделов)" },
	{ match: "asr", reason: "asr (Apple Software Restore; может перезаписать тома)" },
	{ match: "parted", reason: "parted (управление дисками/разделами)" },
	{ match: "fdisk", reason: "fdisk (управление дисками/разделами)" },
	{ match: "gdisk", reason: "gdisk (управление дисками/разделами)" },
	{ match: "sgdisk", reason: "sgdisk (управление дисками/разделами)" },
	{ match: "cryptsetup", reason: "cryptsetup (управление шифрованием дисков)" },
	{ match: "pvcreate", reason: "pvcreate (управление томами LVM)" },
	{ match: "vgcreate", reason: "vgcreate (управление томами LVM)" },
	{ match: "lvcreate", reason: "lvcreate (управление томами LVM)" },
	{ match: "zpool", reason: "zpool (управление пулами ZFS)" },
	// lsblk обычно read-only, но тоже про диски; спрашиваем по требованию.
	{ match: "lsblk", reason: "lsblk (список дисков)", sev: "medium" },
];

/** Слить частичные риски: severity — максимальный, причины — без дубликатов.
 *  Пустой (или только с пустыми причинами) вход — null: «чисто». */
function mergeRisks(parts: Array<Risk | null>): Risk | null {
	const hit = parts.filter((r): r is Risk => !!r && r.reasons.length > 0);
	if (hit.length === 0) return null;
	return {
		severity: hit.some((r) => r.severity === "high") ? "high" : "medium",
		reasons: [...new Set(hit.flatMap((r) => r.reasons))],
	};
}

function analyzeSegment(seg: Token[], depth = 0, strictGit = false, skipRm = false): Risk | null {
	const reasons: string[] = [];
	// Уровень по умолчанию — «medium»; проверки лишь поднимают его до «high».
	let severity: Severity = "medium";
	const high = (reason: string) => {
		severity = "high";
		reasons.push(reason);
	};

	const ops = seg.filter(isOpToken).map((o) => o.op);
	const args = tokensToStrings(seg);
	// Префиксные присваивания окружения (`LC_ALL=C git push …`) — не команда.
	while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) args.shift();
	if (args.length === 0) return null;

	// Полный путь к бинарю (`/bin/rm`) — та же утилита, что и по имени.
	const cmd = args[0].slice(args[0].lastIndexOf("/") + 1);
	const rest = args.slice(1);

	// Редирекции/конвейеры обрабатываются на всю команду, но часть проверок оставляем и по сегментам.
	if (ops.includes("|") && (args.includes("sh") || args.includes("bash") || args.includes("zsh") || args.includes("fish"))) {
		high("конвейер в шелл (возможное выполнение удалённого кода)");
	}

	// sudo
	if (cmd === "sudo") {
		high("sudo (повышенные привилегии)");
	}

	// Вложенная команда внутри sh -c / bash -c / zsh -c / …: разбираем её тоже (глубина ≤ 2).
	// Без этого `bash -c "rm -rf x"` проходила бы неразобранной строкой-аргументом.
	if ((cmd === "sh" || cmd === "bash" || cmd === "zsh" || cmd === "dash" || cmd === "fish") && rest.includes("-c") && depth < 2) {
		const ci = rest.indexOf("-c");
		const inner = rest[ci + 1];
		if (typeof inner === "string" && inner.trim()) {
			const innerRisk = analyzeBashCommand(inner, depth + 1, strictGit, skipRm);
			if (innerRisk) {
				if (innerRisk.severity === "high") severity = "high";
				for (const r of innerRisk.reasons) reasons.push(`${cmd} -c: ${r}`);
			}
		}
	}

	// rm/rmdir/unlink
	if (!skipRm && (cmd === "rm" || cmd === "rmdir" || cmd === "unlink")) {
		high(`${cmd} (удаление файлов)`);
		if (hasShortFlagWith(rest, "rR") || rest.includes("--recursive")) reasons.push("рекурсивное удаление (-r/-R)");
		if (hasShortFlagWith(rest, "f") || rest.includes("--force")) reasons.push("принудительное удаление (-f)");
	}

	// find -delete
	if (cmd === "find" && rest.includes("-delete")) {
		high("find -delete (массовое удаление)");
	}

	// git-операции: спрашиваем на мутирующие команды; read-only (status/log/diff/…)
	// — без запроса, если не задан --bash-guard-git-strict
	if (cmd === "git") {
		const sub = rest[0];
		const subArgs = rest.slice(1);
		let gitHigh = false;
		const gitReasons: string[] = [];

		if (sub === "rm") {
			gitHigh = true;
			gitReasons.push("git rm (удаляет файлы из дерева и добавляет удаления в индекс)");
		}
		if (sub === "clean" && (hasShortFlagWith(subArgs, "f") || subArgs.includes("--force") || hasShortFlagWith(subArgs, "dx"))) {
			gitHigh = true;
			gitReasons.push("git clean (может удалить неотслеживаемые файлы)");
		}
		if (sub === "reset" && subArgs.includes("--hard")) {
			gitHigh = true;
			gitReasons.push("git reset --hard (сбрасывает изменения)");
		}
		if ((sub === "checkout" || sub === "restore") && (subArgs.includes(".") || subArgs.includes("--") || subArgs.includes("--source"))) {
			gitReasons.push("git checkout/restore (может перезаписать рабочее дерево)");
		}
		if (sub === "push" && (subArgs.includes("--force") || subArgs.includes("--force-with-lease") || hasShortFlagWith(subArgs, "f"))) {
			gitHigh = true;
			gitReasons.push("git push --force (переписывает историю на удалённом)");
		}
		if (sub === "reflog" && subArgs.includes("expire")) {
			gitHigh = true;
			gitReasons.push("git reflog expire (может удалить историю восстановления)");
		}
		if (sub === "gc" && subArgs.some((a) => a.startsWith("--prune"))) {
			gitHigh = true;
			gitReasons.push("git gc --prune (может безвозвратно удалить объекты)");
		}

		if (!gitHigh && !strictGit && isGitReadonly(sub, subArgs)) {
			// чистый read-only git — без запроса
		} else {
			if (gitReasons.length === 0) gitReasons.push(sub ? `git ${sub} (git-команда)` : "git (git-команда)");
			reasons.push(...gitReasons);
			if (gitHigh) severity = "high";
		}
	}

	// truncate
	if (cmd === "truncate") {
		reasons.push("truncate (изменение размера на месте, может стереть содержимое)");
	}

	// dd of=
	if (cmd === "dd" && (anyArgStartsWith(rest, "of=") || rest.includes("of"))) {
		high("dd с файлом/устройством вывода (может перезаписать данные)");
	}

	// Управление дисками/томами — по таблице DISK_COMMANDS
	const disk = DISK_COMMANDS.find((r) => (r.match.endsWith("*") ? cmd.startsWith(r.match.slice(0, -1)) : cmd === r.match));
	if (disk) {
		if (disk.sev === "high" || disk.sev === undefined) severity = "high";
		reasons.push(disk.reason);
		if (cmd === "diskutil" && (rest.includes("eraseDisk") || rest.includes("eraseVolume"))) {
			reasons.push("diskutil erase (разрушительная операция с диском)");
		}
	}

	// chmod/chown рекурсивные
	if (cmd === "chmod" && (rest.includes("-R") || rest.includes("--recursive"))) {
		reasons.push("chmod -R (рекурсивное изменение прав)");
	}
	if (cmd === "chown" && (rest.includes("-R") || rest.includes("--recursive"))) {
		reasons.push("chown -R (рекурсивное изменение владельцев)");
	}

	// mv/cp с перезаписью
	if (cmd === "mv" && (rest.includes("-f") || rest.includes("--force"))) {
		reasons.push("mv --force/-f (может перезаписать файлы)");
	}
	if (cmd === "cp" && (rest.includes("-f") || rest.includes("--force"))) {
		reasons.push("cp --force/-f (может перезаписать файлы)");
	}

	// sed/perl in-place
	if (cmd === "sed" && (hasFlag(rest, "-i") || rest.includes("--in-place"))) {
		reasons.push("sed -i (изменение файла на месте)");
	}
	if (cmd === "perl" && (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))) {
		reasons.push("perl -pi/-i (изменение файла на месте)");
	}

	// kill/shutdown/systemctl
	if (cmd === "kill" || cmd === "pkill" || cmd === "killall") {
		reasons.push(`${cmd} (завершение процессов)`);
		if (rest.includes("-9")) high("SIGKILL (-9)");
	}
	if (cmd === "shutdown" || cmd === "reboot") {
		high(`${cmd} (операции электропитания системы)`);
	}
	if (cmd === "systemctl" && (rest.includes("stop") || rest.includes("disable"))) {
		reasons.push("systemctl stop/disable (остановка сервисов)");
	}

	// Паттерны удалённого выполнения
	if ((cmd === "curl" || cmd === "wget") && ops.includes("|")) {
		high("конвейер curl/wget (возможное выполнение удалённого кода)");
	}

	// Удаления в инфраструктуре
	if (cmd === "kubectl" && rest[0] === "delete") {
		high("kubectl delete (удаление ресурсов)");
	}
	if (cmd === "terraform" && rest[0] === "destroy") {
		high("terraform destroy (снос инфраструктуры)");
	}
	if (cmd === "aws" && rest[0] === "s3" && rest[1] === "rm" && rest.includes("--recursive")) {
		high("aws s3 rm --recursive (массовое удаление)");
	}
	if (cmd === "gcloud" && rest.includes("delete")) {
		high("gcloud delete (удаление ресурсов)");
	}

	if (reasons.length === 0) return null;
	return { severity, reasons };
}

export function analyzeBashCommand(command: string, depth = 0, strictGit = false, skipRm = false): Risk | null {
	// Каждую строку разбираем отдельно: shell-quote теряет переносы строк, и без этого
	// опасная команда, «спрятанная» за безобидной первой строкой (echo 1\nrm -rf /),
	// ушла бы незамеченной.
	// physicalLines, а не split("\n"): перевод строки внутри кавычек
	// (`awk 'BEGIN\n{print}'`) — часть команды, а не новая команда.
	const lines = physicalLines(command);
	return mergeRisks(lines.map((l) => analyzeLine(l, depth, strictGit, skipRm)));
}

function analyzeLine(line: string, depth: number, strictGit: boolean, skipRm: boolean): Risk | null {
	let tokens: Token[];
	try {
		tokens = parseTokens(line);
	} catch {
		// Запасной вариант: если разобрать не удалось, считаем команду подозрительной
		return { severity: "medium", reasons: ["разобрать shell-команду не удалось (безопасный анализ невозможен)"] };
	}

	const reasons: string[] = [];

	// Проверки операторов на всю команду (уровень «medium»; высокий дают сегменты ниже)
	const ops = tokens.filter(isOpToken).map((t) => t.op);
	if (ops.some((op) => op === ">" || op === ">>" || op === "2>" || op === "2>>")) {
		reasons.push("редирекция вывода (может перезаписать файлы)");
	}
	if (ops.includes("<")) {
		reasons.push("редирекция ввода (подозрительно)");
	}
	if (ops.includes("|")) {
		reasons.push("оператор конвейера (составная команда)");
	}

	// Сегменты (разбивка по &&, ||, ;)
	const segments = splitOnOps(tokens, ["&&", "||", ";"]);
	return mergeRisks([
		{ severity: "medium", reasons },
		...segments.map((seg) => analyzeSegment(seg, depth, strictGit, skipRm)),
	]);
}

async function promptRunOrAbort(ctx: any, command: string, risk: Risk): Promise<"run" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const reasonsText = risk.reasons.map((r) => `• ${r}`).join("\n");
	const header = `Команда помечена как риск: ${risk.severity === "high" ? "высокий" : "средний"}:`;
	const body = `${header}\n\n${reasonsText}\n\nКоманда:\n${command}`;

	const items: SelectItem[] = [
		{ value: "run", label: "Выполнить", description: "Выполнить команду" },
		{ value: "abort", label: "Отменить", description: "Заблокировать эту команду" },
	];

	const choice = await ctx.ui.custom<"run" | "abort">((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
		container.addChild(new Text(theme.fg("warning", theme.bold("Потенциально разрушительная bash-команда")), 1, 0));
		container.addChild(new Text(body, 1, 0));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		list.onSelect = (item) => done(item.value as "run" | "abort");
		list.onCancel = () => done("abort");
		container.addChild(list);

		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	return choice ?? "abort";
}

// PI_SUBAGENT_DEPTH равен 0 (или не задан) в главной сессии и >= 1 в процессах субагентов.
// Поведение зависит от этого: интерактивный запрос в главной сессии, жёсткий блок
// катастрофических операций в субагентах (где stdin — /dev/null и UI недоступен).
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

// Паттерны жёсткого блока для режима субагента (без UI). Критерий: по умолчанию
// необратимо И маловероятно, что это осознанный шаг в автоматическом контексте.
// Меньше ложных срабатываний важнее широкого покрытия — остальное в главной
// сессии закрывает интерактивный запрос. `sessionOnly: true` — действует только
// в сессиях, а не в «поле» автономного режима главной сессии.
// Аргументы `sh/bash/zsh -c "…"` разворачиваем в отдельные варианты: якорные
// паттерны пола (sudo/shutdown) ловят `bash -c "sudo …"`, но не слово sudo
// внутри аргументов grep или кавычек безобидных команд.
/** Правила «пола». `head` — утилита-голова сегмента; без неё правило по строке. */
export type FloorRule = {
	pattern: RegExp;
	reason: string;
	sessionOnly?: boolean;
	rmOnly?: boolean;
	/** Утилита-голова (строка — точное имя, RegExp — префикс). Без неё правило матчится по строке. */
	head?: Array<string | RegExp>;
};

/**
 * Обёртки, за которыми прячется настоящая команда: `sudo rm -rf /`,
 * `env FOO=1 rm …`, `command rm …`. Флаги и `VAR=` между ними пропускаются.
 */
const WRAPPERS = new Set(["sudo", "env", "command", "time", "nohup", "nice", "stdbuf", "xon", "doas"]);

/**
 * Позиции команды в сегменте: сама голова и каждая обёртка на пути к ней.
 * `FOO=1 sudo rm -rf /` → [{sudo,"sudo rm -rf /"}, {rm,"rm -rf /"}] — чтобы
 * правило sudo сработало и не мешало правилу rm.
 */
function segmentPositions(argv: string[]): Array<{ head: string; text: string }> {
	const out: Array<{ head: string; text: string }> = [];
	let i = 0;
	for (;;) {
		const head = headUtility(argv.slice(i));
		if (!head) return out;
		out.push({ head, text: argv.slice(i).join(" ") });
		if (!WRAPPERS.has(head)) return out;
		let j = i + 1;
		while (j < argv.length && (argv[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[j]))) j++;
		if (j <= i) return out;
		i = j;
	}
}

/**
 * Первое сработавшее правило «пола». Матчинг по разобранным сегментам, а не по
 * сырой строке: `echo "rm -rf /"` — это echo, а не rm; `bash -c "rm -rf /"` —
 * это rm (сегмент развёрнут).
 */
export function floorMatch(command: string, rules: FloorRule[]): FloorRule | null {
	const positions = commandSegments(command, 2, true).flatMap(segmentPositions);
	const lines = physicalLines(command);
	for (const rule of rules) {
		if (!rule.head) {
			if (lines.some((l) => rule.pattern.test(l))) return rule;
			continue;
		}
		for (const pos of positions) {
			if (rule.head.some((h) => (typeof h === "string" ? h === pos.head : h.test(pos.head))) && rule.pattern.test(pos.text)) {
				return rule;
			}
		}
	}
	return null;
}

/**
 * Команда уже обёрнута песочницей (голова — bwrap/sandbox-exec). Проверяем по
 * тексту, а не по маркеру на событии: порядок загрузки расширений бывает любой,
 * и при «bash-guard раньше sandbox» маркер просто не успевает появиться.
 */
export function sandboxWrapped(command: string): boolean {
	const BACKENDS = new Set(["bwrap", "sandbox-exec"]);
	return commandSegments(command, 0, true)
		.flatMap(segmentPositions)
		.some((pos) => BACKENDS.has(pos.head));
}

export const HEADLESS_BLOCKED: FloorRule[] = [
	// Рекурсивное удаление (rmOnly — снимается /bash-guard:rm в главной сессии)
	{ head: ["rm"], pattern: /^rm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-\brecursive\b)/, reason: "рекурсивное удаление (rm -r / -rf / -Rf)", rmOnly: true },
	{ head: ["find"], pattern: /^find\b[^#]*\s-delete\b/, reason: "рекурсивное удаление через find -delete", rmOnly: true },
	// Рекурсивные права/владелец на корень или домашнюю: восстановление возможно
	// только по бэкапу, поэтому тоже пол.
	{
		head: ["chmod", "chown"],
		pattern: /^(?:chmod|chown)\b[^#]*\s-(?:[a-zA-Z]*R\b|--recursive)\b[^#]*\s(?:\/|~|\$HOME)(?:\s|\/\*|$)/,
		reason: "рекурсивная смена прав/владельца для / или домашней директории",
	},
	// Повышение привилегиями (head уже учитывает env-префиксы и обёртки)
	{ head: ["sudo", "doas"], pattern: /^(?:sudo|doas)\b/, reason: "повышенные привилегии (sudo)" },
	// Удалённое выполнение кода через pipe-to-shell (правило по строке: конвейер
	// — не сегмент)
	{ pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/, reason: "конвейер в шелл (удалённое выполнение кода)" },
	// Форк-бомба: `f() { f | f & }; f`
	{ pattern: /^[^(){}=]*\(\)\s*\{[^}]*\|[^}]*&[^}]*\}/, reason: "форк-бомба (рекурсивный фоновый процесс)" },
	// Разрушение дисков/файловых систем
	// /.+/ означает «достаточно головы»: утилита опасна в любомInvocation.
	{ head: [/^mkfs/, /^newfs_/], pattern: /.+/, reason: "форматирование файловой системы (mkfs/newfs)" },
	{ head: ["wipefs"], pattern: /^wipefs\b/, reason: "стирание сигнатуры диска" },
	{ head: ["diskutil"], pattern: /^diskutil\s+(erase|zeroDisk|secureErase|reformat)/i, reason: "разрушительная операция с диском (diskutil)" },
	{ head: ["dd"], pattern: /^dd\b[^#\n]*\bof=\/dev\//, reason: "запись сырым образом в диск (dd of=/dev/...)" },
	{ head: ["parted", "fdisk", "gdisk", "sgdisk"], pattern: /.+/, reason: "управление таблицей разделов" },
	{ head: ["cryptsetup"], pattern: /^cryptsetup\b/, reason: "управление шифрованием дисков" },
	{ head: ["zpool"], pattern: /^zpool\b/, reason: "управление пулами ZFS" },
	// Электропитание системы
	{ head: ["shutdown", "reboot", "halt", "poweroff"], pattern: /.+/, reason: "операции электропитания системы" },
	// Снос инфраструктуры
	{ head: ["terraform"], pattern: /^terraform\s+destroy\b/, reason: "снос инфраструктуры (terraform destroy)" },
	{ head: ["kubectl"], pattern: /^kubectl\s+delete\b/, reason: "удаление ресурсов Kubernetes" },
	{ head: ["aws"], pattern: /^aws\s+s3\s+rm\b[^#\n]*--recursive/, reason: "массовое удаление в S3 (aws s3 rm --recursive)" },
	// Разрушительные git-операции
	{ head: ["git"], pattern: /^git\s+commit\b/, reason: "git commit (коммиты — операция главной сессии)", sessionOnly: true },
	{ head: ["git"], pattern: /^git\s+pull\b/, reason: "git pull (pull — операция главной сессии)", sessionOnly: true },
	{ head: ["git"], pattern: /^git\s+push\b/, reason: "git push (push — операция главной сессии)", sessionOnly: true },
	{ head: ["git"], pattern: /^git\s+reset\b[^#\n]*--hard\b/, reason: "сброс всех несохранённых изменений (git reset --hard)" },
	{ head: ["git"], pattern: /^git\s+clean\b[^#\n]*-[a-zA-Z]*f/, reason: "удаление неотслеживаемых файлов (git clean -f)" },
	{ head: ["git"], pattern: /^git\s+reflog\s+expire\b/, reason: "истечение reflog (удаление истории восстановления)" },
	{ head: ["git"], pattern: /^git\s+gc\b[^#\n]*--prune\b/, reason: "очистка недостижимых объектов (git gc --prune)" },
];

// Подмножество HEADLESS_BLOCKED, работающее как «пол» жёсткого блока, когда
// bash-guard отключён в интерактивной (главной) сессии. Пользователь явно
// выбирает автономию, поэтому рутинные git-операции (commit/pull/push)
// разрешены; блокируются только по-настоящему катастрофические/необратимые
// паттерны. Помечены явно (sessionOnly), а не матчингом source регулярных
// выражений — изменение формулировок больше не ломает «пол» молча.
export const MAIN_DISABLED_BLOCKED: FloorRule[] = HEADLESS_BLOCKED.filter(
	(r) => !r.sessionOnly,
);

// Предупреждение, показываемое через ctx.ui.setStatus, когда bash-guard отключён.
// Pi объединяет статусы всех расширений в одну строку, сортируя их по алфавиту по ключу, поэтому:
//
// - Ключ начинается с пробела, чтобы сортироваться раньше любых буквенных ключей
//   других расширений — предупреждение не обрежется (truncateToWidth режет справа).
// - Текст намеренно НЕ выравнивается по полной ширине — это вытолкнуло бы
//   статусы других расширений за экран при обрезке.
// - Фон задан truecolor-красным (#FF0000), а не базовым цветом палитры 41
//   (терминалы переназначают его по теме, часто он выглядит коричнево-оранжевым).
// - NBSP (U+00A0) внутри предупреждения, потому что sanitizeStatusText в футере
//   схлопывает повторяющиеся ASCII-пробелы через / +/g.
// "z-" в начале ключа — бейдж после иконок graft/ponytail (футер сортирует ключи по localeCompare: цифры/символы — ПЕРЕД буквами)
const BASH_GUARD_STATUS_KEY = " z-bash-guard";

export default function (pi: ExtensionAPI) {
	// yolo проверяется в хендлере: `/yolo` работает в обе стороны.
	if (_isSubagent) {
		// Режим субагента: жёсткий блок катастрофических операций, без запросов.
		pi.on("tool_call", async (event) => {
			if (isYolo()) return;
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command;
			if (sandboxWrapped(command)) return;
			const hit = floorMatch(command, HEADLESS_BLOCKED);
			if (hit) {
				return {
					block: true,
					reason:
						`Заблокировано bash-guard: ${hit.reason}. ` +
						"Это неинтерактивная сессия субагента — катастрофические операции запрещены. " +
						"Предложи более безопасный вариант или попроси родительского агента уточнить у пользователя.",
				};
			}
		});
		return;
	}

	// Режим главной сессии: интерактивные запросы.
	pi.registerFlag("bash-guard-auto-allow", {
		description: "Если задан, bash-guard не будет блокировать при отсутствии UI (неинтерактивные режимы).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("bash-guard-disabled", {
		description: "Запустить сессию с отключённым bash-guard (автономный режим; «пол» жёсткого блока всё равно действует).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("bash-guard-git-strict", {
		description: "Строгий git-режим: спрашивать на ЛЮБУЮ git-команду, включая read-only (status/log/diff/…)",
		type: "boolean",
		default: false,
	});

	// Переключатели персистентны: <agentDir>/guard-state.json (переживает /reload
	// и продолжение pi -c; новая сессия pi стартует с дефолтом — сброс в session_start).
	let disabled = Boolean(loadGuard("bash-guard").disabled);
	let rmAllowed = Boolean(loadGuard("bash-guard").rmAllowed);

	// Бейдж в футер: собираем активные отключения; пусто → сбрасываем статус.
	const refreshStatus = (ctx: any) => {
		const { theme } = ctx.ui;
		const parts: string[] = [];
		if (disabled) parts.push(theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ BG OFF "))));
		if (rmAllowed) parts.push(theme.bg("toolErrorBg", theme.bold(theme.fg("error", " 🗑 RM OFF "))));
		ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, parts.length ? parts.join("") : undefined);
	};

	pi.on("session_start", async (event, ctx) => {
		// Новая сессия (startup с пустой историей, new) → дефолт (вся защита ON) + persist;
		// продолжение (pi -c / --session / resume / reload / fork) → сохранённое состояние.
		// Субагент не сбрасывает.
		if (!_isSubagent && shouldResetGuards(event, ctx)) {
			disabled = false;
			rmAllowed = false;
			saveGuard("bash-guard", { disabled, rmAllowed });
		}
		if (pi.getFlag("bash-guard-disabled") === true && !disabled) {
			disabled = true;
			saveGuard("bash-guard", { disabled });
		}
		refreshStatus(ctx);
	});

	pi.registerCommand("bash-guard", {
		description: "Переключить bash-guard между интерактивным (по умолчанию) и отключённым (автономным) режимом для этой сессии.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			saveGuard("bash-guard", { disabled });
			refreshStatus(ctx);
			if (disabled) {
				ctx.ui.notify(
					"bash-guard ОТКЛЮЧЁН (запомнено: переживёт /reload и pi -c; новая сессия pi стартует с дефолтом). Катастрофические операции по-прежнему блокируются жёстко. Снова выполни /bash-guard, чтобы включить.",
					"warning",
				);
			} else {
				ctx.ui.notify("bash-guard снова включён.", "info");
			}
		},
	});

	pi.registerCommand("bash-guard:rm", {
		description: "Переключить запрет rm для этой сессии: агент сможет удалять файлы (тесты, tmp) без подтверждения и без жёсткого блока в автономном режиме.",
		handler: async (_args, ctx) => {
			rmAllowed = !rmAllowed;
			saveGuard("bash-guard", { rmAllowed });
			refreshStatus(ctx);
			ctx.ui.notify(
				rmAllowed
					? "bash-guard: rm ОТКЛЮЧЁН на эту сессию — удаление файлов разрешено без подтверждения. Снова выполни /bash-guard:rm, чтобы вернуть защиту."
					: "bash-guard: защита rm снова включена.",
				rmAllowed ? "warning" : "info",
			);
		},
	});

	// Защита от раздражающих циклов повторных попыток: если команду недавно отменили, блокируем её автоматически.
	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;
	// Ключ нормализуем (схлопываем пробелы), чтобы `rm -rf  x` не была «новой» командой.
	const normalizeCmd = (c: string) => c.replace(/\s+/g, " ").trim();

	pi.on("tool_call", async (event, ctx) => {
		// yolo: ни запросов, ни блоков, «пол» тоже снят по явному запросу
		// пользователя (см. extensions/yolo).
		if (isYolo()) return;
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		// Команда в песочнице (bwrap/Seatbelt) — повторное подтверждение не нужно:
		// изоляция уже сделала свою работу.
		if (sandboxWrapped(command)) return;

		// Отключённый (автономный) режим: без интерактивных запросов, но
		// сохраняем «пол» жёсткого блока для катастрофических операций.
		if (disabled) {
			// /bash-guard:rm снимает только rm-правила (rm -r, find -delete)
			const rules = rmAllowed ? MAIN_DISABLED_BLOCKED.filter((r) => !r.rmOnly) : MAIN_DISABLED_BLOCKED;
			const hit = floorMatch(command, rules);
			if (hit) {
				return {
					block: true,
					reason:
						`Заблокировано bash-guard («пол» автономного режима): ${hit.reason}. ` +
						"Даже при отключённом bash-guard этот шаблон слишком разрушителен для автономного выполнения. " +
						"Включи bash-guard через /bash-guard и подтверди интерактивно, или предложи более безопасный вариант.",
				};
			}
			return;
		}

		const risk = analyzeBashCommand(command, 0, pi.getFlag("bash-guard-git-strict") === true, rmAllowed);
		if (!risk) return;

		const now = Date.now();
		// Подчищаем просроченные записи (карта маленькая, проход дешёвый)
		for (const [k, t] of recentlyAborted) {
			if (now - t >= ABORT_REMEMBER_MS) recentlyAborted.delete(k);
		}
		const key = normalizeCmd(command);
		const lastAbort = recentlyAborted.get(key);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason:
					"Заблокировано bash-guard: команда недавно была отменена пользователем. Уточни у пользователя более безопасный вариант; не повторяй ту же команду.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("bash-guard-auto-allow")) {
			// Неинтерактивный режим: разрешаем при явном запросе.
			return;
		}

		const choice = await promptRunOrAbort(ctx, command, risk);
		if (choice === "run") return;

		recentlyAborted.set(key, now);
		return {
			block: true,
			reason:
				"Заблокировано пользователем через bash-guard (потенциально разрушительная команда). Уточни подтверждение у пользователя или предложи безопасную альтернативу.",
		};
	});
}
