import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGuard, saveGuard, shouldResetGuards } from "../guard-state.ts";
import { pathCandidates } from "../shell-parse.ts";
import { isSecretPath } from "../secret-paths.ts";
import { isYolo } from "../yolo-mode.ts";

/**
 * dir-guard: жёсткий блок tool-вызовов, чьи пути уходят ВНЕ рабочей директории
 * сессии (CWD) и её allowlist'а. Проверяются read/write/edit (input.path),
 * find/grep/ls (input.path — у поиска он тоже есть, и `grep -r x ~/.ssh`
 * обязан ловиться так же, как `cat ~/.ssh/...`), и bash.
 *
 * Механика:
 * - CWD берётся из ExtensionContext (ctx.cwd), канонизируется (realpath) и
 *   pin'ится на сессию (пересчёт один раз, не на каждый tool call).
 * - Каждый проверяемый путь: resolve против CWD → canonical (realpath; для
 *   несуществующего пути — realpath ближайшего существующего родителя + хвост).
 *   Это закрывает symlink-escape: symlink внутри CWD, указывающий наружу,
 *   разрешается в реальный внешний путь и блокируется.
 * - Bash: токены из shell-quote (extensions/shell-parse.ts), а не `split(/\s+/)`:
 *   путь в кавычках, путь после флага (`--file=/etc/x`) и путь в присваивании
 *   (`HOME=/etc cmd`) видны так же хорошо, как без кавычек. Неразрешимые токены
 *   ($VAR, глобы `*`, обратные кавычки) сознательно НЕ блокируются — осознанный
 *   компромисс, см. README. Односегментные абсолютные пути (`/models`, `/app`)
 *   тоже: в bash-командах это пути внутри контейнера.
 * - Allowlist — корневые директории (сам путь и всё в нём): дефолт $HOME/.pi,
 *   флаг --dir-guard-allow (коммат-список) и файл .dir-guard.json в CWD.
 *   Symlink-escape блокируется ВСЕГДА: проверка идёт по canonical (realpath)
 *   пути, а не по строковому виду.
 * - Файлы учётных данных (secret-paths.ts: ~/.ssh, ~/.aws, auth.json, *.pem,
 *   .env…) блокируются СВЕРХУ allowlist'а: дефолтный корень $HOME/.pi иначе
 *   открывал бы ~/.pi/agent/auth.json с токенами провайдеров. Только для путей
 *   вне CWD — `.env` и тестовые ключи внутри проекта остаются рабочими файлами.
 *   Снять: "secrets": "allow" в .dir-guard.json или --dir-guard-allow-secrets.
 *
 * Субагент (PI_SUBAGENT_DEPTH >= 1): те же правила, жёсткий блок, без UI.
 */

// Ключ с пробелом в начале: футер сортирует статусы по алфавиту, и предупреждение
// не обрезается truncateToWidth (см. аналогичный комментарий в bash-guard).
const STATUS_KEY = " z-dir-guard"; // "z-": бейдж после иконок graft/ponytail (localeCompare)

const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

/** Раскрывает `~` и `~/...` в домашнюю директорию. */
function expandHome(p: string): string {
	p = p.trim();
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Канонизирует путь, который может ещё не существовать: realpath ближайшего
 * существующего предка + дописанный хвост. Без этого проверка несуществующего
 * пути `cat /etc/new` прошла бы по строковому виду, а symlink-escape в
 * несуществующий хвост — остался бы незамеченным.
 */
function canonical(p: string): string {
	let cur = p;
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(p, ...tail); // канонизировать нечего
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

function isInside(p: string, root: string): boolean {
	const r = root.length > 1 && root.endsWith(path.sep) ? root.slice(0, -1) : root;
	if (r === path.sep) return p === path.sep || p.startsWith(path.sep);
	return p === r || p.startsWith(r + path.sep);
}

type Verdict = { blocked: boolean; reason?: string };

export default function (pi: ExtensionAPI) {
	// Состояние персистентно: <agentDir>/guard-state.json (переживает /reload и
	// продолжение pi -c; новая сессия pi стартует с дефолтом). В субагентах файл
	// сознательно не читается — свежее включённое состояние (fail-safe по умолчанию).
	let disabled = _isSubagent ? false : Boolean(loadGuard("dir-guard").disabled);
	let ready = false;
	let root = "";
	let allowRoots: string[] = [];
	let secretsBlocked = true;

	/** Pin'ит CWD (однократно) и собирает allowlist. */
	function ensureReady(ctx: ExtensionContext): void {
		if (ready) return;
		const cwd = ctx.cwd || process.cwd();
		root = canonical(cwd);

		// Встроенный дефолт: ~/.pi + read-only системные root'ы и scratch /tmp —
	// иначе каждый `bash /bin/...`, `tar -C /tmp` и `docker exec ... /tmp/...`
	// даёт ложный блок. Риск осознанный: запись в /tmp не ограничивается.
	// shortcut: /tmp наружу открыт; при жалобе на мусор в /tmp убрать и держать
	// per-project allowlist в .dir-guard.json.
	const raw: string[] = [
		path.join(os.homedir(), ".pi"),
		"/tmp", "/private/tmp",            // scratch (на macOS /tmp — symlink в /private/tmp)
		"/dev",                            // устройства, уже был частный кейс /dev/null
		"/bin", "/usr/bin", "/sbin",       // вызов системных бинарей
		// Локально установленные бинари (Intel/Apple Silicon). Целые root'ы:
		// brew-бинари — симлинки в Cellar, canonical-проверка иначе резонно блокирует.
		"/usr/local", "/opt/homebrew",
	];
		const flagVal = pi.getFlag("dir-guard-allow");
		// Парсер флагов pi знает только одиночные значения (Map, последнее
		// переопределяет) → поддерживаем коммат-список в одном флаге.
		if (typeof flagVal === "string" && flagVal.trim()) {
			raw.push(...flagVal.split(",").map((s) => s.trim()).filter(Boolean));
		}
		const cfgFile = path.join(cwd, ".dir-guard.json");
		if (fs.existsSync(cfgFile)) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
				const allow = (parsed as { allow?: unknown }).allow;
				if (Array.isArray(allow)) {
					raw.push(...allow.filter((x): x is string => typeof x === "string"));
				}
				if ((parsed as { secrets?: unknown }).secrets === "allow") secretsBlocked = false;
			} catch {
				if (ctx.hasUI) {
					ctx.ui.notify(`dir-guard: невалидный JSON в ${cfgFile} — файл проигнорирован`, "warning");
				}
			}
		}
		allowRoots = [...new Set(raw.map((p) => canonical(expandHome(p))))];
		if (pi.getFlag("dir-guard-allow-secrets") === true) secretsBlocked = false;
		ready = true;
	}

	/** Проверка одного пути. Возвращает verdict; reason — человекочитаемый. */
	function checkPath(raw: string): Verdict {
		const expanded = expandHome(raw);
		const abs = path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
		const resolved = canonical(abs);
		if (isInside(resolved, root)) return { blocked: false };
		// Сверху allowlist'а: $HOME/.pi открыт целиком, а auth.json с токенами — там.
		if (secretsBlocked && isSecretPath(resolved)) {
			return {
				blocked: true,
				reason:
					`dir-guard: ${raw} (→ ${resolved}) — файл с учётными данными вне рабочей директории. ` +
					"Читай и меняй их только по явной просьбе пользователя; если доступ нужен постоянно — " +
					'"secrets": "allow" в .dir-guard.json или флаг --dir-guard-allow-secrets.',
			};
		}
		for (const a of allowRoots) {
			if (isInside(resolved, a)) return { blocked: false };
		}
		return {
			blocked: true,
			reason:
				`dir-guard: путь ${raw} (→ ${resolved}) вне рабочей директории ${root}. ` +
				"Действуй только внутри рабочей директории; если путь нужен легитимно — " +
				"попроси пользователя добавить его в allowlist (--dir-guard-allow или .dir-guard.json в CWD).",
		};
	}

	function offBadge(ctx: ExtensionContext): string {
		const { theme } = ctx.ui;
		return theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ DR OFF ")));
	}

	/** Какой путь проверяем у не-bash инструмента. У поиска path опционален: без него — CWD. */
	function checkedPath(event: ToolCallEvent): string | null {
		for (const tool of ["read", "write", "edit", "find", "grep", "ls"] as const) {
			if (!isToolCallEventType(tool, event)) continue;
			const raw = (event.input as { path?: unknown }).path;
			// Опущенный path у find/grep/ls значит «текущий каталог» — он внутри CWD по определению.
			return typeof raw === "string" && raw.trim() ? raw : null;
		}
		return null;
	}

	const onToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		const isBash = isToolCallEventType("bash", event);
		const pathArg = isBash ? null : checkedPath(event);
		if (!isBash && pathArg === null) return;
		// yolo: путь-блокировки сняты (см. extensions/yolo). Проверка в хендлере,
		// а не в factory: тогда `/yolo` работает и на включение, и на возврат защиты.
		if (disabled || isYolo()) return;
		ensureReady(ctx);

		const candidates = isBash ? pathCandidates(event.input.command) : [pathArg as string];
		for (const tok of candidates) {
			const v = checkPath(tok);
			if (v.blocked) return { block: true, reason: v.reason };
		}
	};

	if (_isSubagent) {
		// Режим субагента: те же правила, жёсткий блок, без UI и команд.
		pi.on("tool_call", onToolCall);
		return;
	}

	// Режим главной сессии.
	pi.registerFlag("dir-guard-disabled", {
		description: "Запустить сессию с отключённым dir-guard (путь-блокировки не действуют).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("dir-guard-allow", {
		description: "Разрешённые пути вне CWD, список через запятую (например: ~/notes,/opt/reference).",
		type: "string",
	});

	pi.registerFlag("dir-guard-allow-secrets", {
		description: "Не блокировать файлы учётных данных вне рабочей директории (~/.ssh, ~/.aws, auth.json, *.pem, .env).",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		// Смена сессии внутри процесса (/resume, /new, /fork) может сменить cwd —
		// сбрасываем пин root/allowlist, ensureReady пересчитает на первом же вызове.
		ready = false;
		// Новая сессия (startup с пустой историей, new) → дефолт (защита ON) + persist;
		// продолжение (pi -c / --session / resume / reload / fork) → сохранённое состояние.
		// Субагент не сбрасывает.
		if (!_isSubagent && shouldResetGuards(event, ctx)) {
			disabled = false;
			saveGuard("dir-guard", { disabled });
		}
		// Флаг «запустить отключённым» применяется на каждой новой сессии процесса
		// (единообразно с bash-guard), а не только на startup.
		if (pi.getFlag("dir-guard-disabled") === true && !disabled) {
			disabled = true;
			saveGuard("dir-guard", { disabled });
		}
		// Синхронизируем бейдж при любой причине (включая "reload": factory
		// перезапускается, а состояние восстанавливается из guard-state.json).
		ctx.ui.setStatus(STATUS_KEY, disabled ? offBadge(ctx) : undefined);
	});

	pi.registerCommand("dir-guard", {
		description: "Переключить dir-guard (жёсткий блок путей вне рабочей директории) для этой сессии.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			saveGuard("dir-guard", { disabled });
			if (disabled) {
				ctx.ui.setStatus(STATUS_KEY, offBadge(ctx));
				ctx.ui.notify(
					"dir-guard ОТКЛЮЧЁН (запомнено: переживёт /reload и pi -c; новая сессия pi стартует с дефолтом). Пути вне рабочей директории больше не блокируются. Снова выполни /dir-guard, чтобы включить.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("dir-guard снова включён.", "info");
			}
		},
	});

	pi.on("tool_call", onToolCall);
}
