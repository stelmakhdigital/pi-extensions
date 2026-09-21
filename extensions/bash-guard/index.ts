import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { parse as shellParse } from "shell-quote";

type Severity = "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};

type OpToken = { op: string; [k: string]: unknown };

type Token = string | OpToken;

function isOpToken(t: Token): t is OpToken {
	return typeof t === "object" && t !== null && "op" in t;
}

function tokensToStrings(tokens: Token[]): string[] {
	return tokens.filter((t) => typeof t === "string") as string[];
}

function splitOnOps(tokens: Token[], splitOps: string[]): Token[][] {
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

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((a) => a.startsWith(flag) && flag.length === 2 && a.startsWith("-"));
}

function anyArgStartsWith(args: string[], prefix: string): boolean {
	return args.some((a) => a.startsWith(prefix));
}

function analyzeSegment(seg: Token[]): Risk | null {
	const reasons: string[] = [];
	let severity: Severity = "medium";

	const ops = seg.filter(isOpToken).map((o) => o.op);
	const args = tokensToStrings(seg);
	if (args.length === 0) return null;

	const cmd = args[0];
	const rest = args.slice(1);

	// Редирекции/конвейеры обрабатываются на всю команду, но часть проверок оставляем и по сегментам.
	if (ops.includes("|") && (args.includes("sh") || args.includes("bash") || args.includes("zsh") || args.includes("fish"))) {
		reasons.push("конвейер в шелл (возможное выполнение удалённого кода)");
		severity = "high";
	}

	// sudo
	if (cmd === "sudo") {
		reasons.push("sudo (повышенные привилегии)");
		severity = "high";
	}

	// rm/rmdir/unlink
	if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
		severity = "high";
		reasons.push(`${cmd} (удаление файлов)`);
		if (rest.some((a) => a.includes("-r") || a.includes("-R"))) reasons.push("рекурсивное удаление (-r/-R)");
		if (rest.some((a) => a.includes("-f"))) reasons.push("принудительное удаление (-f)");
		if (ops.includes("glob")) reasons.push("расширение glob-шаблона (можно удалить много файлов)");
	}

	// find -delete
	if (cmd === "find" && rest.includes("-delete")) {
		severity = "high";
		reasons.push("find -delete (массовое удаление)");
	}

	// git-операции (спрашивать при ЛЮБОЙ git-команде)
	if (cmd === "git") {
		const sub = rest[0];
		const subArgs = rest.slice(1);

		// Всегда спрашивать на git-команды (по требованию пользователя). Тяжесть — medium, если не выявлен явно рискованный паттерн.
		reasons.push(sub ? `git ${sub} (git-команда)` : "git (git-команда)");

		if (sub === "rm") {
			severity = "high";
			reasons.push("git rm (удаляет файлы из дерева и добавляет удаления в индекс)");
		}
		if (sub === "clean" && (subArgs.some((a) => a.includes("-f")) || subArgs.includes("-d") || subArgs.includes("-x"))) {
			severity = "high";
			reasons.push("git clean (может удалить неотслеживаемые файлы)");
		}
		if (sub === "reset" && subArgs.includes("--hard")) {
			severity = "high";
			reasons.push("git reset --hard (сбрасывает изменения)");
		}
		if ((sub === "checkout" || sub === "restore") && (subArgs.includes(".") || subArgs.includes("--") || subArgs.includes("--source"))) {
			severity = severity === "high" ? "high" : "medium";
			reasons.push("git checkout/restore (может перезаписать рабочее дерево)");
		}
		if (sub === "push" && (subArgs.includes("--force") || subArgs.includes("--force-with-lease") || subArgs.includes("-f"))) {
			severity = "high";
			reasons.push("git push --force (переписывает историю на удалённом)");
		}
		if (sub === "reflog" && subArgs.includes("expire")) {
			severity = "high";
			reasons.push("git reflog expire (может удалить историю восстановления)");
		}
		if (sub === "gc" && subArgs.some((a) => a.startsWith("--prune"))) {
			severity = "high";
			reasons.push("git gc --prune (может безвозвратно удалить объекты)");
		}
	}

	// truncate
	if (cmd === "truncate") {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("truncate (изменение размера на месте, может стереть содержимое)");
	}

	// dd of=
	if (cmd === "dd" && (anyArgStartsWith(rest, "of=") || rest.includes("of"))) {
		severity = "high";
		reasons.push("dd с файлом/устройством вывода (может перезаписать данные)");
	}

	// Управление дисками/томами (спрашивать агрессивно; высокий риск)
	// Linux: mkfs.*, wipefs, parted, fdisk, gdisk/sgdisk, lsblk, cryptsetup, LVM-инструменты, zpool
	// macOS: diskutil, hdiutil, gpt, newfs_*, asr
	if (cmd.startsWith("mkfs")) {
		severity = "high";
		reasons.push("mkfs (форматирование файловой системы)");
	}
	if (cmd.startsWith("newfs_")) {
		severity = "high";
		reasons.push("newfs_* (форматирование файловой системы)");
	}
	if (cmd === "wipefs") {
		severity = "high";
		reasons.push("wipefs (стирание сигнатуры диска)");
	}
	if (cmd === "diskutil") {
		severity = "high";
		reasons.push("diskutil (команда управления дисками)");
		if (rest.includes("eraseDisk") || rest.includes("eraseVolume")) {
			reasons.push("diskutil erase (разрушительная операция с диском)");
		}
	}
	if (cmd === "hdiutil") {
		severity = "high";
		reasons.push("hdiutil (команда управления образами дисков)");
	}
	if (cmd === "gpt") {
		severity = "high";
		reasons.push("gpt (манипуляции с таблицей разделов)");
	}
	if (cmd === "asr") {
		severity = "high";
		reasons.push("asr (Apple Software Restore; может перезаписать тома)");
	}
	if (cmd === "parted" || cmd === "fdisk" || cmd === "gdisk" || cmd === "sgdisk") {
		severity = "high";
		reasons.push(`${cmd} (управление дисками/разделами)`);
	}
	if (cmd === "lsblk") {
		// Обычно read-only, но тоже про диски; спрашиваем по требованию.
		severity = severity === "high" ? "high" : "medium";
		reasons.push("lsblk (список дисков)");
	}
	if (cmd === "cryptsetup") {
		severity = "high";
		reasons.push("cryptsetup (управление шифрованием дисков)");
	}
	if (cmd === "pvcreate" || cmd === "vgcreate" || cmd === "lvcreate") {
		severity = "high";
		reasons.push(`${cmd} (управление томами LVM)`);
	}
	if (cmd === "zpool") {
		severity = "high";
		reasons.push("zpool (управление пулами ZFS)");
	}

	// chmod/chown рекурсивные
	if (cmd === "chmod" && (rest.includes("-R") || rest.includes("--recursive"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("chmod -R (рекурсивное изменение прав)");
	}
	if (cmd === "chown" && (rest.includes("-R") || rest.includes("--recursive"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("chown -R (рекурсивное изменение владельцев)");
	}

	// mv/cp с перезаписью
	if (cmd === "mv" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("mv --force/-f (может перезаписать файлы)");
	}
	if (cmd === "cp" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("cp --force/-f (может перезаписать файлы)");
	}

	// sed/perl in-place
	if (cmd === "sed" && (hasFlag(rest, "-i") || rest.includes("--in-place"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("sed -i (изменение файла на месте)");
	}
	if (cmd === "perl" && (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("perl -pi/-i (изменение файла на месте)");
	}

	// kill/shutdown/systemctl
	if (cmd === "kill" || cmd === "pkill" || cmd === "killall") {
		severity = severity === "high" ? "high" : "medium";
		reasons.push(`${cmd} (завершение процессов)`);
		if (rest.includes("-9")) {
			severity = "high";
			reasons.push("SIGKILL (-9)");
		}
	}
	if (cmd === "shutdown" || cmd === "reboot") {
		severity = "high";
		reasons.push(`${cmd} (операции электропитания системы)`);
	}
	if (cmd === "systemctl" && (rest.includes("stop") || rest.includes("disable"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("systemctl stop/disable (остановка сервисов)");
	}

	// Паттерны удалённого выполнения
	if ((cmd === "curl" || cmd === "wget") && ops.includes("|")) {
		severity = "high";
		reasons.push("конвейер curl/wget (возможное выполнение удалённого кода)");
	}

	// Удаления в инфраструктуре
	if (cmd === "kubectl" && rest[0] === "delete") {
		severity = "high";
		reasons.push("kubectl delete (удаление ресурсов)");
	}
	if (cmd === "terraform" && rest[0] === "destroy") {
		severity = "high";
		reasons.push("terraform destroy (снос инфраструктуры)");
	}
	if (cmd === "aws" && rest[0] === "s3" && rest[1] === "rm" && rest.includes("--recursive")) {
		severity = "high";
		reasons.push("aws s3 rm --recursive (массовое удаление)");
	}
	if (cmd === "gcloud" && rest.includes("delete")) {
		severity = "high";
		reasons.push("gcloud delete (удаление ресурсов)");
	}

	if (reasons.length === 0) return null;
	return { severity, reasons };
}

function analyzeBashCommand(command: string): Risk | null {
	let tokens: Token[];
	try {
		tokens = shellParse(command) as Token[];
	} catch {
		// Запасной вариант: если разобрать не удалось, считаем команду подозрительной
		return { severity: "medium", reasons: ["разобрать shell-команду не удалось (безопасный анализ невозможен)"] };
	}

	const reasons: string[] = [];
	let severity: Severity = "medium";

	// Проверки операторов на всю команду
	const ops = tokens.filter(isOpToken).map((t) => t.op);
	if (ops.some((op) => op === ">" || op === ">>" || op === "2>" || op === "2>>")) {
		reasons.push("редирекция вывода (может перезаписать файлы)");
		severity = severity === "high" ? "high" : "medium";
	}
	if (ops.includes("<")) {
		reasons.push("редирекция ввода (подозрительно)");
	}
	if (ops.includes("|")) {
		reasons.push("оператор конвейера (составная команда)");
	}

	// Анализ сегментов (разбивка по &&, ||, ;)
	const segments = splitOnOps(tokens, ["&&", "||", ";"]);
	for (const seg of segments) {
		const segRisk = analyzeSegment(seg);
		if (!segRisk) continue;
		if (segRisk.severity === "high") severity = "high";
		for (const r of segRisk.reasons) reasons.push(r);
	}

	// Убираем дубликаты причин
	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq };
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
// сессии закрывает интерактивный запрос.
const HEADLESS_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
	// Рекурсивное удаление
	{ pattern: /(?<!\bgit\s+)\brm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-\brecursive\b)/, reason: "рекурсивное удаление (rm -r / -rf / -Rf)" },
	// Повышение привилегий
	{ pattern: /\bsudo\b/, reason: "повышенные привилегии (sudo)" },
	// Удалённое выполнение кода через pipe-to-shell
	{ pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/, reason: "конвейер в шелл (удалённое выполнение кода)" },
	// Разрушение дисков/файловых систем
	{ pattern: /\bmkfs/, reason: "форматирование файловой системы (mkfs)" },
	{ pattern: /\bnewfs_\w+/, reason: "форматирование файловой системы (newfs_*)" },
	{ pattern: /\bwipefs\b/, reason: "стирание сигнатуры диска" },
	{ pattern: /\bdiskutil\s+(erase|zeroDisk|secureErase|reformat)/i, reason: "разрушительная операция с диском (diskutil)" },
	{ pattern: /\bdd\b[^#\n]*\bof=\/dev\//, reason: "запись сырым образом в диск (dd of=/dev/...)" },
	{ pattern: /\b(parted|fdisk|gdisk|sgdisk)\b/, reason: "управление таблицей разделов" },
	{ pattern: /\bcryptsetup\b/, reason: "управление шифрованием дисков" },
	{ pattern: /\bzpool\b/, reason: "управление пулами ZFS" },
	// Электропитание системы
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "операции электропитания системы" },
	// Снос инфраструктуры
	{ pattern: /\bterraform\s+destroy\b/, reason: "снос инфраструктуры (terraform destroy)" },
	{ pattern: /\bkubectl\s+delete\b/, reason: "удаление ресурсов Kubernetes" },
	{ pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive/, reason: "массовое удаление в S3 (aws s3 rm --recursive)" },
	// Разрушительные git-операции
	{ pattern: /\bgit\s+commit\b/, reason: "git commit (коммиты — операция главной сессии)" },
	{ pattern: /\bgit\s+pull\b/, reason: "git pull (pull — операция главной сессии)" },
	{ pattern: /\bgit\s+push\b/, reason: "git push (push — операция главной сессии)" },
	{ pattern: /\bgit\s+reset\b[^#\n]*--hard\b/, reason: "сброс всех несохранённых изменений (git reset --hard)" },
	{ pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/, reason: "удаление неотслеживаемых файлов (git clean -f)" },
	{ pattern: /\bgit\s+reflog\s+expire\b/, reason: "истечение reflog (удаление истории восстановления)" },
	{ pattern: /\bgit\s+gc\b[^#\n]*--prune\b/, reason: "очистка недостижимых объектов (git gc --prune)" },
];

// Подмножество HEADLESS_BLOCKED, работающее как «пол» жёсткого блока, когда
// bash-guard отключён в интерактивной (главной) сессии. Пользователь явно
// выбирает автономию, поэтому рутинные git-операции (commit/pull/push)
// разрешены; блокируются только по-настоящему катастрофические/необратимые
// паттерны.
const MAIN_DISABLED_BLOCKED: Array<{ pattern: RegExp; reason: string }> = HEADLESS_BLOCKED.filter(
	({ pattern }) => {
		const src = pattern.source;
		return !(
			src.includes("git\\s+commit") ||
			src.includes("git\\s+pull") ||
			// git push --force остаётся заблокированным, обычный git push разрешён.
			src === "\\bgit\\s+push\\b"
		);
	},
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
const BASH_GUARD_STATUS_KEY = " bash-guard";

export default function (pi: ExtensionAPI) {
	if (_isSubagent) {
		// Режим субагента: жёсткий блок катастрофических операций, без запросов.
		pi.on("tool_call", async (event) => {
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command;
			for (const { pattern, reason } of HEADLESS_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Заблокировано bash-guard: ${reason}. ` +
							"Это неинтерактивная сессия субагента — катастрофические операции запрещены. " +
							"Предложи более безопасный вариант или попроси родительского агента уточнить у пользователя.",
					};
				}
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

	// Переключатель живёт только внутри сессии. Намеренно не сохраняется между перезагрузками и перезапусками.
	let disabled = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--bash-guard-disabled") === true) {
			disabled = true;
			const { theme } = ctx.ui;
			const badge = theme.bg(
				"toolErrorBg",
				theme.bold(theme.fg("error", " ⚠ BG OFF ")),
			);
			ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
		}
	});

	pi.registerCommand("bash-guard", {
		description: "Переключить bash-guard между интерактивным (по умолчанию) и отключённым (автономным) режимом для этой сессии.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				const { theme } = ctx.ui;
				const badge = theme.bg(
					"toolErrorBg",
					theme.bold(theme.fg("error", " ⚠ BG OFF ")),
				);
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
				ctx.ui.notify(
					"bash-guard ОТКЛЮЧЁН на эту сессию. Катастрофические операции по-прежнему блокируются жёстко. Снова выполни /bash-guard, чтобы включить.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, undefined);
				ctx.ui.notify("bash-guard снова включён.", "info");
			}
		},
	});

	// Защита от раздражающих циклов повторных попыток: если команду недавно отменили, блокируем её автоматически.
	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;

		// Отключённый (автономный) режим: без интерактивных запросов, но
		// сохраняем «пол» жёсткого блока для катастрофических операций.
		if (disabled) {
			for (const { pattern, reason } of MAIN_DISABLED_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Заблокировано bash-guard («пол» автономного режима): ${reason}. ` +
							"Даже при отключённом bash-guard этот шаблон слишком разрушителен для автономного выполнения. " +
							"Включи bash-guard через /bash-guard и подтверди интерактивно, или предложи более безопасный вариант.",
					};
				}
			}
			return;
		}

		const risk = analyzeBashCommand(command);
		if (!risk) return;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason:
					"Заблокировано bash-guard: команда недавно была отменена пользователем. Уточни у пользователя более безопасный вариант; не повторяй ту же команду.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--bash-guard-auto-allow")) {
			// Неинтерактивный режим: разрешаем при явном запросе.
			return;
		}

		const choice = await promptRunOrAbort(ctx, command, risk);
		if (choice === "run") return;

		recentlyAborted.set(command, now);
		return {
			block: true,
			reason:
				"Заблокировано пользователем через bash-guard (потенциально разрушительная команда). Уточни подтверждение у пользователя или предложи безопасную альтернативу.",
		};
	});
}
