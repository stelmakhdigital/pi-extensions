/**
 * Sandbox — пер-командная изоляция bash-вызовов агента (L1 trust-лестницы).
 *
 * Механика: перехват `tool_call` на `bash` и мутация `event.input.command` —
 * команда оборачивается бэкендом песочницы и исполняется штатным bash-тулом.
 * Пользователь (и bash-guard) видят полную команду, включая бэкенд;
 * если bash-guard загружен после sandbox, маркер __sandboxWrapped на событии
 * ему подскажет, что команда уже в песочнице.
 *
 * Бэкенды:
 * - Linux: bubblewrap (bwrap) — mount-namespace (видна только курируемая
 *   подсистема + workspace rw), PID-namespace, --unshare-net для untrusted.
 * - macOS: sandbox-exec (Seatbelt) — сгенерированный SBPL-профиль.
 *
 * Уровни (trust-лестница):
 * - off        (L0): расширение ничего не меняет
 * - dev        (L1): FS-изоляция (секреты не монтируются), сеть разрешена
 * - untrusted  (L1+): как dev + --unshare-net / network-outbound deny
 * - vm         (L2): пер-команда VM-изоляцию не делает — fail-closed с
 *   инструкцией запустить pi внутри Gondolin/Docker (см. sandbox/README.md)
 *
 * Выбор уровня: флаг --sandbox-level > файл-маркер `.sandbox` в дереве проекта
 * (первый найденный вверх от корня) > off. Переопределяется в сессии:
 * /sandbox on <dev|untrusted|vm> | off.
 *
 * Доверие: пользовательские `!`-команды (user_bash) НАЦЕЛЕННО не трогаем —
 * человек = хост, агент = песочница.
 *
 * Гигиена: env scrub (API_KEY/TOKEN/SECRET/…), fake $HOME с чистым .gitconfig,
 * в workspace не монтируются ~/.pi/agent (ключи!), ~/.ssh, ~/.aws и т.п.
 *
 * Границы (v1): нет seccomp-фильтра и user-namespace (если ОС не даёт),
 * нет cgroup-лимитов — TODO v2. Fail-closed: если бэкенд недоступен
 * (нет bwrap), агентские bash-команды блокируются, а не «выполняются
 * без песочницы».
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Level = "off" | "dev" | "untrusted" | "vm";
type Platform = "linux" | "macos" | "unsupported";

const STATUS_KEY = " sandbox"; // ведущий пробел: бейдж не обрезается футером
const SCRIPT_IN_SANDBOX = "/run/pi-sbx-cmd.sh";

/** Варианты стартового промпта «Доверяешь ли ты этому проекту?» */
const TRUST_PROMPT_OPTIONS: Array<{ label: string; level: Level }> = [
	{ label: "Доверяю (L0 — без песочницы)", level: "off" },
	{ label: "Изолировать: dev (L1 — песочница, сеть разрешена)", level: "dev" },
	{ label: "Изолировать: untrusted (L1+ — песочница, без сети)", level: "untrusted" },
];

/** Глобальное хранилище решений о доверии (per-user): корень проекта → уровень.
 *  pi-нативное доверие (project_trust) — бинарное yes/no и спрашивается только
 *  для проектов с .pi-ресурсами. Наше хранилище расширяет его до уровней и
 *  покрывает проекты БЕЗ .pi (через session_start-фолбэк). */
const trustStoreFile = (): string => process.env.PI_SANDBOX_TRUST_FILE ?? join(homedir(), ".pi", "agent", "sandbox-trust.json");
type TrustStore = Record<string, { level: Level; at: number }>;
function loadTrustStore(): TrustStore {
	try {
		return JSON.parse(readFileSync(trustStoreFile(), "utf8")) as TrustStore;
	} catch {
		return {};
	}
}
function savedLevel(root: string): Level | null {
	const e = loadTrustStore()[root];
	return e && (e.level === "off" || e.level === "dev" || e.level === "untrusted" || e.level === "vm") ? e.level : null;
}
function rememberLevel(root: string, level: Level) {
	const store = loadTrustStore();
	if (level === "off") delete store[root];
	else store[root] = { level, at: Date.now() };
	try {
		mkdirSync(dirname(trustStoreFile()), { recursive: true });
		writeFileSync(trustStoreFile(), JSON.stringify(store, null, 2));
	} catch {
		// не критично: решение действует в этой сессии в любом случае
	}
}
function forgetLevel(root: string) {
	const store = loadTrustStore();
	delete store[root];
	try {
		writeFileSync(trustStoreFile(), JSON.stringify(store, null, 2));
	} catch {}
}

function isDir(p: string): boolean {
	try {
		return existsSync(p) && statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function detectPlatform(): Platform {
	if (process.platform === "linux") return "linux";
	if (process.platform === "darwin") return "macos";
	return "unsupported";
}

/** Корень проекта: ближайший вверх от cwd каталог с .git (иначе сам cwd).
 *  Кэшируем по ПРОВЕРЕННОМУ каталогу (а не по cwd), чтобы создание/удаление
 *  .git не заставляло повторно ползти вверх, но и не кэшировало устаревшие «нет». */
const gitDirCache = new Map<string, boolean>();
function hasGit(dir: string): boolean {
	const hit = gitDirCache.get(dir);
	if (hit !== undefined) return hit;
	const v = isDir(join(dir, ".git"));
	gitDirCache.set(dir, v);
	return v;
}
function projectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (hasGit(dir)) return dir;
		const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
		if (parent === dir) break;
		dir = parent;
	}
	return resolve(cwd);
}

/** Файл-маркер `.sandbox` с уровнем, найденный вверх от корня проекта. */
function markerLevel(cwd: string): Level | null {
	let dir = projectRoot(cwd);
	for (;;) {
		const p = join(dir, ".sandbox");
		if (existsSync(p)) {
			const raw = readFileSync(p, "utf8").trim();
			return raw === "dev" || raw === "untrusted" || raw === "vm" || raw === "off" ? (raw as Level) : null;
		}
		const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Fake HOME: один раз на сессию, чистая среда для команд (identity git сохраняется). */
let fakeHome: string | null = null;
function getFakeHome(): string {
	if (!fakeHome) {
		fakeHome = mkdtempSync(join(tmpdir(), "pi-sandbox-home-"));
		try {
			const hostGitconfig = join(homedir(), ".gitconfig");
			if (existsSync(hostGitconfig)) copyFileSync(hostGitconfig, join(fakeHome, ".gitconfig"));
		} catch {
			// git-identity — не критично
		}
	}
	return fakeHome;
}

/** Env для песочницы: явный allowlist (не scrub полного env — он мог бы
 *  утечь через bwrap-наследование). Секретов в allowlistе по построению нет. */
function sandboxEnv(): Record<string, string> {
	const allow = ["PATH", "USER", "SHELL", "TERM", "LANG", "LC_ALL"];
	const out: Record<string, string> = {};
	for (const k of allow) {
		const v = process.env[k];
		if (typeof v === "string") out[k] = v;
	}
	out.HOME = getFakeHome();
	out.TMPDIR = "/tmp";
	return out;
}

/** POSIX-квоутинг аргумента: single quotes, вложенные ' → '\'' */
function q(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Команда bwrap/скрипт в строку для встраивания в event.input.command. */
function shellJoin(argv: string[]): string {
	return argv.map(q).join(" ");
}

/** Linux: bwrap. Порядок bind важен: tmpfs ДО workspace, иначе перекроет его.
 *  --clearenv: в песочницу — только allowlist-окружение (без ключей провайдеров). */
function bwrapArgs(workspace: string, opts: { net: boolean }): string[] {
	const args: string[] = [];
	for (const d of ["/usr", "/bin", "/lib", "/lib64", "/lib32", "/opt", "/snap"]) {
		if (isDir(d)) args.push("--ro-bind", d, d);
	}
	if (opts.net && existsSync("/etc/resolv.conf")) args.push("--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf");
	if (isDir("/etc/ssl")) args.push("--ro-bind", "/etc/ssl", "/etc/ssl");
	args.push("--tmpfs", "/tmp");
	// /home и /root маскируем явно: даже stub-каталоги bind-родителей (bwrap делает
	// mkdir -p под точку монтирования) не должны раскрывать хостовые home-директории.
	args.push("--tmpfs", "/home", "--tmpfs", "/root");
	args.push("--bind", workspace, workspace);
	args.push("--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "--new-session");
	if (!opts.net) args.push("--unshare-net");
	args.push("--clearenv");
	for (const [k, v] of Object.entries(sandboxEnv())) args.push("--setenv", k, v);
	return args;
}

/** macOS: SBPL-профиль. (Проверен ревьюем; на Linux-машине сборки не запускался.) */
function sbplProfile(workspace: string, opts: { net: boolean }): string {
	const home = homedir();
	const deny = [".pi", ".ssh", ".aws", ".gnupg", ".config"]
		.map((p) => `(literal "${join(home, p)}")`)
		.join(" ");
	return [
		"(version 1)",
		"(deny default)",
		'(allow process-fork process-exec signal (target self))',
		"(allow sysctl-read)",
		'(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/var/db"))',
		`(allow file-read* (literal "${getFakeHome()}"))`,
		`(allow file-read* file-write* (subpath "${workspace}"))`,
		'(allow file-read* file-write* (subpath "/private/tmp") (subpath "/var/folders") (subpath "/dev"))',
		`(deny file-read* ${deny})`,
		opts.net ? "(allow network-outbound network-inbound)" : "(deny network-outbound network-inbound)",
		"(allow system-fscache)",
	].join("\n");
}

/**
 * Оборачивает команду: пишем её в скрипт-файл (без хрупкого квоутинга телa),
 * бэкенд монтирует/разрешает скрипт и исполняет. Возвращает строку для
 * event.input.command (исполнит штатный bash-тул на хосте).
 */
function wrapCommand(command: string, workspace: string, level: Level): string {
	const net = level === "dev";
	const platform = detectPlatform();
	const script = join(tmpdir(), `pi-sbx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
	// set -e НЕ ставим: семантика должна совпадать со штатным bash -c
	// (команды после падшего звена должны выполняться, как и без песочницы).
	writeFileSync(script, "#!/bin/sh\n" + command + "\n");
	const comment = `# ⧉ sandbox:${level} (workspace: ${workspace}; скрипт: ${script})\n`;

	if (platform === "linux") {
		const argv = ["bwrap", ...bwrapArgs(workspace, { net }), "--ro-bind", script, SCRIPT_IN_SANDBOX, "--", "bash", SCRIPT_IN_SANDBOX];
		return comment + shellJoin(argv);
	}
	const profile = script + ".sbpl";
	writeFileSync(profile, sbplProfile(workspace, { net }));
	// env -i + явные переменные: sandbox-exec наследует окружение, scrub руками
	const envAssign = Object.entries(sandboxEnv())
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	const argv = ["env", "-i", envAssign, "--", "sandbox-exec", "-f", profile, "bash", "-c", `source "${script}"`];
	return comment + shellJoin(argv);
}

export default function (pi: ExtensionAPI) {
	const platform = detectPlatform();
	let backendOk: boolean | null = null;
	function checkBackend(): boolean {
		if (backendOk === null) {
			if (platform === "linux") {
				backendOk =
					spawnSync("bwrap", ["--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--", "true"]).status === 0;
			} else {
				backendOk = platform === "macos"; // sandbox-exec есть на всех современных macOS
			}
		}
		return backendOk;
	}

	pi.registerFlag("sandbox-level", {
		description: "Уровень sandbox для bash-команд агента: off | dev | untrusted | vm (по умолчанию — из файла .sandbox)",
		type: "string",
	});

	// Переопределение живёт в сессии (не сохраняется между запусками).
	let sessionLevel: Level | null = null;
	// Корни, по которым уже показан доверительный промпт (project_trust или
	// session_start-фолбэк), чтобы не спрашивать дважды за один запуск.
	const trustPromptedRoots = new Set<string>();

	function activeLevel(ctx: ExtensionContext): Level {
		if (sessionLevel) return sessionLevel;
		const flag = pi.getFlag("--sandbox-level");
		if (typeof flag === "string" && flag) return flag as Level;
		const root = projectRoot(ctx.cwd);
		return markerLevel(root) ?? savedLevel(root) ?? "off";
	}

	function levelSource(ctx: ExtensionContext): string {
		if (sessionLevel) return "сессия (/sandbox on)";
		const flag = pi.getFlag("--sandbox-level");
		if (typeof flag === "string" && flag) return "флаг --sandbox-level";
		if (markerLevel(ctx.cwd)) return "файл .sandbox";
		if (savedLevel(projectRoot(ctx.cwd))) return "сохранённое решение о доверии";
		return "по умолчанию (off)";
	}

	/** Уровень → бинарное доверие pi: L0/L1-dev — ресурсы проекта грузим
	 *  (доверие с изоляцией выполнения), L1+/vm — не грузим. */
	const trustFlag = (l: Level): "yes" | "no" => (l === "off" || l === "dev" ? "yes" : "no");

	/** Нативное событие pi: спрашивается при старте, если у проекта есть .pi-ресурсы.
	 *  Отвечаем за pi: показываем свой (более богатый) выбор уровня. */
	pi.on("project_trust", async (event, tctx) => {
		const root = projectRoot(event.cwd);
		trustPromptedRoots.add(root);
		const marker = markerLevel(root);
		if (marker) return { trusted: trustFlag(marker) };
		const saved = savedLevel(root);
		if (saved) return { trusted: trustFlag(saved) };
		if (!tctx.hasUI) return { trusted: "undecided" };
		const label = await tctx.ui.select(`Доверяешь ли ты проекту ${root}?`, TRUST_PROMPT_OPTIONS.map((o) => o.label));
		const opt = TRUST_PROMPT_OPTIONS.find((o) => o.label === label);
		if (!opt) return { trusted: "undecided" };
		rememberLevel(root, opt.level);
		return { trusted: trustFlag(opt.level), remember: true };
	});

	pi.on("session_start", async (event, ctx) => {
		badge(ctx, activeLevel(ctx));
		// Фолбэк для проектов БЕЗ .pi-ресурсов (pi их сам не спрашивает):
		// первый интерактивный старт в неизвестной директории — разовый промпт.
		if (event.reason !== "startup" || !ctx.hasUI) return;
		const root = projectRoot(ctx.cwd);
		if (trustPromptedRoots.has(root)) return;
		if (markerLevel(root) || savedLevel(root)) return;
		const flag = pi.getFlag("--sandbox-level");
		if (typeof flag === "string" && flag) return;
		const label = await ctx.ui.select(`Проект ${root}: доверяешь ли ты ему? (первый запуск)`, TRUST_PROMPT_OPTIONS.map((o) => o.label));
		const opt = TRUST_PROMPT_OPTIONS.find((o) => o.label === label);
		if (!opt) return;
		trustPromptedRoots.add(root);
		rememberLevel(root, opt.level);
		badge(ctx, opt.level);
		ctx.ui.notify(
			opt.level === "off" ? "Проект отмечен как доверенный (L0, без песочницы)." : `Песочница включена (${opt.level}) для ${root}.`,
			opt.level === "off" ? "info" : "warning",
		);
	});

	function badge(ctx: ExtensionContext, level: Level) {
		if (!ctx.hasUI) return;
		if (level === "off") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const t = ctx.ui.theme;
		const label = level === "vm" ? "⧉ sandbox: vm (нужен контейнер)" : level === "untrusted" ? "⧉ sandbox: untrusted" : "⧉ sandbox: dev";
		ctx.ui.setStatus(STATUS_KEY, level === "untrusted" ? t.fg("warning", label) : t.fg("accent", label));
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const level = activeLevel(ctx);
		if (level === "off") return;
		if (level === "vm") {
			return {
				block: true,
				reason:
					"Уровень sandbox: vm — пер-командная песочница не даёт VM-изоляцию (это L2). Запусти pi внутри Gondolin " +
					"(pi -e ~/.pi/agent/extensions/gondolin) или Docker-контура (см. sandbox/README.md в pi-extensions), " +
					"либо понизь уровень: /sandbox on dev",
			};
		}
		if (!checkBackend()) {
			return {
				block: true,
				reason:
					`Sandbox включён (${level}), но бэкенд недоступен (${platform}: ${platform === "linux" ? "bwrap не найден или не запускается" : "нет sandbox-exec"}). ` +
					(platform === "linux" ? "Установи bubblewrap (apt install bwrap). " : "") +
					"Или отключи: /sandbox off. Выполнять команды без песочницы отказываемся (fail-closed).",
			};
		}

		const input = event.input as { command: string };
		const workspace = projectRoot(ctx.cwd);
		input.command = wrapCommand(input.command, workspace, level);
		// Маркер для bash-guard (если он загружен позже): команда уже в песочнице.
		(event as unknown as Record<string, unknown>).__sandboxWrapped = { level, workspace };
	});

	/** Self-test: короткая команда в песочнице с проверкой изоляции. */
	async function selfTest(ctx: ExtensionContext): Promise<void> {
		const level = activeLevel(ctx);
		const workspace = projectRoot(ctx.cwd);
		const wrapped = wrapCommand(
			`echo "uid=$(id -u)"; ls /home >/dev/null 2>&1 && echo HOME-VISIBLE || echo HOME-HIDDEN; touch "${workspace}/.sbx-write-test" && echo WS-RW || echo WS-FAIL; rm -f "${workspace}/.sbx-write-test"`,
			workspace,
			level === "off" ? "dev" : level,
		);
		const { execFile } = await import("node:child_process");
		const r = await new Promise<{ code: number | null; out: string }>((res) => {
			execFile("bash", ["-c", wrapped], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
				res({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: (stdout + (stderr ? `\n${stderr}` : "")).trim() });
			});
		});
		const ok = r.out.includes("HOME-HIDDEN") && r.out.includes("WS-RW");
		const verdict = ok
			? `⧉ self-test OK (${platform}, ${level}): ${r.out.replace(/\n/g, " · ")}`
			: `⧉ self-test требует внимания (exit ${r.code}): ${r.out.replace(/\n/g, " · ").slice(0, 400)}`;
		ctx.ui.notify(verdict, ok ? "info" : "warning");
	}

	pi.registerCommand("sandbox", {
		description: "Sandbox: /sandbox status | on <dev|untrusted|vm|off> | test | forget",
		handler: async (args: string, ctx) => {
			const a = args.trim().split(/\s+/);
			if (a[0] === "on" || a[0] === "off") {
				const want: Level = a[0] === "off" ? "off" : ((a[1] as Level) ?? "dev");
				if (!["off", "dev", "untrusted", "vm"].includes(want)) {
					ctx.ui.notify("Неизвестный уровень: " + want, "warning");
					return;
				}
				sessionLevel = want;
				badge(ctx, want);
				ctx.ui.notify(`sandbox: ${want === "off" ? "выключен" : "включён (" + want + ")"} на эту сессию`, "info");
				return;
			}
			if (a[0] === "forget") {
			forgetLevel(projectRoot(ctx.cwd));
			sessionLevel = null;
			badge(ctx, activeLevel(ctx));
			ctx.ui.notify("Решение о доверии для текущего проекта удалено — при следующем старте спросят снова.", "info");
			return;
		}
		if (a[0] === "test") {
				await selfTest(ctx);
				return;
			}
			// status
			const level = activeLevel(ctx);
			const lines = [
				`Sandbox: уровень ${level} (источник: ${levelSource(ctx)})`,
				`Платформа: ${platform}; бэкенд: ${platform === "linux" ? "bwrap" : "sandbox-exec"}; доступен: ${checkBackend() ? "да" : "НЕТ"}`,
				`Workspace: ${projectRoot(ctx.cwd)}`,
				`Правило: пользовательские !-команды всегда исполняются на хосте`,
			];
			if (level === "vm") lines.push("L2: запусти pi под Gondolin/Docker — см. sandbox/README.md");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
