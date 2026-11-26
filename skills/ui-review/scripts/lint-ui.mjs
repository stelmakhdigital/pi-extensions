#!/usr/bin/env node
/**
 * Статический лимт исходников на типовые AI-поломками вёрстки и кода.
 *
 * Отличается от a11y.mjs тем, что смотрит на код, а не на отрендеренный экран:
 * часть дефектов (маскировка переполнения, подставные тексты, декоративные
 * градиенты, suppressed focus) в браузере не видны вообще, а часть видна только
 * на текущем состоянии. Заодно работает без браузера.
 *
 * Запуск:
 *   node lint-ui.mjs [путь или url] [--json] [--strict] [--rule-allow id,id]
 *
 * Правила не абсолютны: у части есть честные причины (например transition: all
 * в демке). Строку можно отключить комментарием:
 *   // ui-lint-disable no-100vw
 */
import { lstatSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, relative, resolve } from "node:path";

const SOURCE_EXT = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".jsx", ".tsx", ".vue", ".svelte", ".astro"]);
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less"]);
const TEMPLATE_EXT = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt", "ui-review"]);
const MAX_FILES = 3000;

// severity: fail (почти всегда поломка) | warn (нужна причина)
const RULES = [
	{ id: "no-transition-all", level: "fail", exts: STYLE_EXT, re: /transition(?:-property)?\s*:\s*all\b|transition-all\b/, msg: "transition: all — перечисляй свойства явно" },
	{ id: "no-100vw", level: "fail", exts: SOURCE_EXT, re: /\b100vw\b|[^-\w]w-screen\b/, msg: "100vw/w-screen дают горизонтальный скролл — бери 100% или 100dvw" },
	{ id: "no-dvh-only", level: "warn", exts: SOURCE_EXT, re: /\b100vh\b/, msg: "100vh на мобильных не учитывает адресную строку — нужен fallback + 100dvh" },
	{ id: "no-outline-none", level: "fail", exts: SOURCE_EXT, re: /outline\s*:\s*(?:none|0)\b|outline-(?:none|0)\b(?![^;\n]*focus-visible)/, msg: "убран focus outline без замены на :focus-visible" },
	{ id: "no-important-size", level: "fail", exts: SOURCE_EXT, re: /[^;\n]*!important\s*[;}]/, msg: "!important по размеру/отступу: чини каскад, а не перебивай его" },
	{ id: "no-placeholder-copy", level: "fail", exts: TEMPLATE_EXT, re: /\b(lorem ipsum|dolor sit amet|acme (corp|inc|co)?|john doe|jane doe|TODO|FIXME)\b/i, msg: "подставной текст или TODO в интерфейсе — замени реальным содержанием" },
	{ id: "no-generic-cta", level: "warn", exts: TEMPLATE_EXT, re: />\s*(Learn more|Подробнее|Узнать больше|Submit|Отправить)\s*</i, msg: "кнопка без глагола и объекта: что именно произойдёт" },
	{ id: "no-emoji-icon", level: "warn", exts: TEMPLATE_EXT, re: /<(?:button|a|h[1-6]|span|li)[^>]*>\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, msg: "emoji вместо иконки" },
	{ id: "no-purple-gradient", level: "warn", exts: SOURCE_EXT, re: /(?:from|via|to)-(?:purple|violet|indigo)-\d+|#[0-9a-f]*(?:7c3aed|8b5cf6|6366f1)/i, msg: "сине-фиолетовый градиент — дефолт генерации, а не выбор" },
	{ id: "no-gradient-text", level: "warn", exts: SOURCE_EXT, re: /background-clip\s*:\s*text|bg-clip-text/, msg: "градиентный текст: акцент делается размером и весом" },
	{ id: "no-side-stripe", level: "warn", exts: SOURCE_EXT, re: /border-(?:left|right|inline-start|inline-end)\s*:\s*[3-9]px/, msg: "цветная полоса с одной стороны карточки — замена недостающей иерархии" },
	{ id: "no-eyebrow-numbers", level: "warn", exts: TEMPLATE_EXT, re: />\s*(?:0[1-9]|1[0-9])\s*\/\s*(?:0[1-9]|1[0-9])\s*</, msg: "номера 01/02/03 уместны, только если это правда последовательность" },
	{ id: "no-middot-meta", level: "warn", exts: TEMPLATE_EXT, re: /\S\s·\s\S/, msg: "метаданные через middle dot — фирменный признак сгенерированной страницы" },
	{ id: "no-allcaps-label", level: "warn", exts: SOURCE_EXT, re: /text-transform\s*:\s*uppercase|[^-\w\"]uppercase(?![\w-])/ , msg: "ALL CAPS лейбл над контентом: проверь, что он несёт смысл, а не декор" },
	{ id: "no-disabled-opacity", level: "warn", exts: SOURCE_EXT, re: /:disabled[^{]*\{[^}]*opacity\s*:/, msg: "disabled через opacity роняет контраст — меняй цвета токенов" },
	{ id: "no-overflow-x-hidden-root", level: "fail", exts: STYLE_EXT, re: /(?:html|body)[^{}]*\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/, msg: "overflow-x на html/body маскирует переполнение, а не чинит его" },
	{ id: "no-native-select-unstyled", level: "warn", exts: TEMPLATE_EXT, re: /<select(?![^>]*class)[^>]*>/i, msg: "нативный select без стилей: свой chevron и состояние придётся делать руками и проверить клавиатуру" },
	{ id: "no-hardcoded-blank", level: "warn", exts: SOURCE_EXT, re: /(?:color|background(?:-color)?)\s*:\s*#(?:fff|ffffff|000|000000)\b/, msg: "чистый белый/чёрный вместо токенов поверхности" },
	{ id: "no-js-xss", level: "fail", exts: SOURCE_EXT, re: /(?:\.innerHTML\s*=|dangerouslySetInnerHTML)/, msg: "вставка HTML строкой: экранируй или используй текстовые узлы" },
];

function usage(msg) {
	if (msg) console.error(`lint-ui.mjs: ${msg}`);
	console.error('usage: node lint-ui.mjs [path] [--json] [--strict] [--rule-allow id,id]');
	process.exit(2);
}

function parseArgs(argv) {
	const opts = { target: ".", allow: new Set() };
	const args = [...argv];
	while (args.length) {
		const flag = args.shift();
		if (flag === "--json") { opts.json = true; continue; }
		if (flag === "--strict") { opts.strict = true; continue; }
		if (flag === "--rule-allow") {
			const value = args.shift() ?? usage("--rule-allow требует значения");
			for (const id of value.split(",")) opts.allow.add(id.trim());
			continue;
		}
		if (flag.startsWith("--")) usage(`неизвестный флаг ${flag}`);
		args.unshift(flag);
		opts.target = args.shift();
	}
	if (!existsSync(opts.target)) usage(`нет пути ${opts.target}`);
	const key = resolve(opts.target);
	if (key === "/" || key === resolve(homedirHint())) usage("это ключевой каталог: целься в каталог проекта, а не в HOME или /");
	return opts;
}

/** Домашний каталог: в него рекурсировать нельзя, там чужие проекты. */
function homedirHint() {
	return process.env.HOME || "";
}

/** Обходим каталоги: symlink'ы не вспрыгиваем, нечитаемые и слишком глубокие пропускаем. */
function collect(target, depth = 0, out = []) {
	let stat;
	try {
		stat = lstatSync(target);
	} catch {
		return out; // недоступно или битый symlink
	}
	if (stat.isSymbolicLink()) return out;
	if (stat.isFile()) {
		if (SOURCE_EXT.has(extname(target).toLowerCase())) out.push(target);
		return out;
	}
	if (!stat.isDirectory() || depth > 12 || out.length > MAX_FILES) return out;
	let entries = [];
	try {
		entries = readdirSync(target, { withFileTypes: true });
	} catch {
		return out; // EPERM на системных каталогах — не наша задача
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		collect(join(target, entry.name), depth + 1, out);
	}
	return out;
}

/** true, если над строкой стоит комментарий `ui-lint-disable <id>` или `ui-lint-disable-line`. */
function isAllowed(lines, index, id) {
	const own = lines[index];
	const above = lines[index - 1] ?? "";
	if (new RegExp(`ui-lint-disable-line\\s+${id}\\b`).test(own)) return true;
	if (new RegExp(`ui-lint-disable(-next)?\\s+${id}\\b`).test(above)) return true;
	return new RegExp(`ui-lint-disable\\s+all\\b`).test(above);
}

function lintFile(file) {
	const ext = extname(file).toLowerCase();
	const text = readFileSync(file, "utf8");
	const lines = text.split(/\r?\n/);
	const found = [];
	for (const rule of RULES) {
		if (!rule.exts.has(ext)) continue;
		lines.forEach((line, index) => {
			if (!rule.re.test(line)) return;
			// !important разрешён только на размерах/отступах — на всём остальном это борьба со специфичностью
			if (rule.id === "no-important-size" && !/\b(width|height|padding|margin|gap|font-size|top|left|right|bottom)\s*:/.test(line)) return;
			if (isAllowed(lines, index, rule.id)) return;
			found.push({ rule: rule.id, level: rule.level, line: index + 1, text: line.trim().slice(0, 120), msg: rule.msg });
		});
	}
	// @keyframes без prefers-reduced-motion считаем по файлу целиком
	if (STYLE_EXT.has(ext) && /@keyframes/.test(text) && !/prefers-reduced-motion/.test(text)) {
		found.push({ rule: "no-keyframes-without-reduced-motion", level: "fail", line: 1, text: "@keyframes", msg: "анимации есть, prefers-reduced-motion нет" });
	}
	return found;
}

const opts = parseArgs(process.argv.slice(2));
const files = collect(opts.target);
if (!files.length) usage(`в ${opts.target} нет файлов, которые я умею читать (${[...SOURCE_EXT].join(" ")}), или их больше ${MAX_FILES}`);
const findings = files
	.flatMap((file) => lintFile(file).map((f) => ({ ...f, file: relative(opts.target === "." ? process.cwd() : "", file) || file })))
	.filter((f) => !opts.allow.has(f.rule))
	.sort((a, b) => (a.level === b.level ? a.file.localeCompare(b.file) : a.level === "fail" ? -1 : 1));

if (opts.json) {
	console.log(JSON.stringify({ target: opts.target, files: files.length, findings }, null, 1));
} else {
	console.log(`# ui-lint ${opts.target} — файлов ${files.length}, замечаний ${findings.length}${opts.strict ? ", --strict" : ""}`);
		for (const f of findings) console.log(`${f.level === "fail" ? "FAIL" : "warn"} ${f.file}:${f.line} [${f.rule}] ${f.msg}\n     ${f.text}`);
	if (findings.length > 60) console.log(`... ещё ${findings.length - 60} не показаны: --json или целься в каталог поуже`);
	if (!findings.length) console.log("замечаний нет");
	console.log("\nЛимт смотрит на код и не заменяет a11y.mjs: состояние, переполнение и контраст считаются в браузере.");
}

process.exit(opts.strict && findings.some((f) => f.level === "fail") ? 1 : 0);
