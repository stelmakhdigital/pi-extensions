#!/usr/bin/env node
/**
 * Машинная проверка UI: нарушения axe-core, типовые поломки вёрстки, скриншоты по ширинам.
 *
 * Запуск:
 *   node a11y.mjs <url> [--widths 375,768,1440] [--out DIR] [--baseline DIR]
 *                       [--click "css,css"] [--wait MS] [--axe PATH] [--diff-threshold 0.12]
 *                       [--json] [--strict]
 *
 * Требует playwright (один раз на проект):
 *   npm i -D playwright && npx playwright install chromium
 *
 * axe-core берётся с CDN; для офлайна — --axe ./node_modules/axe-core/axe.min.js
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { decodePng, diffImages, encodePng } from "./png-diff.mjs";

const AXE_CDN = "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js";
const IMPACT_RANK = { minor: 0, moderate: 1, serious: 2, critical: 3 };
// Порог как в pixelmatch: канал должен отличаться больше чем на 12%, иначе шум сжатия
// и антиалиасинг считаются изменением.
const DEFAULT_THRESHOLD = 0.12;

function usage(msg) {
	if (msg) console.error(`a11y.mjs: ${msg}`);
	console.error(
		"usage: node a11y.mjs <url> [--widths 375,768,1440] [--out DIR] [--baseline DIR] [--click \"css,css\"] [--wait MS] [--axe PATH] [--diff-threshold 0.12] [--json] [--strict]"
	);
	process.exit(2);
}

/** Флаги с значением и флаги-переключатели; неизвестное имя — сразу usage, а не « съест следующий аргумент». */
const VALUE_FLAGS = new Set(["--widths", "--out", "--baseline", "--axe", "--wait", "--click", "--diff-threshold"]);
const SWITCH_FLAGS = new Set(["--json", "--strict"]);

function parseArgs(argv) {
	const opts = { widths: [375, 768, 1440], wait: 500, clicks: [], threshold: DEFAULT_THRESHOLD };
	const args = [...argv];
	opts.url = args.shift();
	while (args.length) {
		const flag = args.shift();
		if (SWITCH_FLAGS.has(flag)) {
			opts[flag.slice(2)] = true;
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) usage(`неизвестный флаг ${flag}`);
		const value = args.shift();
		if (value === undefined || value.startsWith("--")) usage(`${flag} требует значение`);
		switch (flag) {
			case "--widths": opts.widths = value.split(",").map((n) => Number.parseInt(n, 10)).filter(Number.isFinite); break;
			case "--out": opts.out = value; break;
			case "--baseline": opts.baseline = value; break;
			case "--axe": opts.axe = value; break;
			case "--wait": opts.wait = Number.parseInt(value, 10); break;
			case "--click": opts.clicks = value.split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--diff-threshold":
				opts.threshold = Number.parseFloat(value);
				if (!Number.isFinite(opts.threshold) || opts.threshold <= 0 || opts.threshold > 1) usage("--diff-threshold — число от 0 до 1");
				break;
		}
	}
	if (!opts.url || !/^(https?|file):\/\//.test(opts.url)) usage("нужен http(s):// или file:// url");
	if (!opts.widths.length) usage("--widths пустой");
	opts.out ??= join("ui-review", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
	return opts;
}
/**
 * playwright ищется от каталога, из которого запустили скрипт (обычно корень проверяемого
 * проекта), а не от каталога скилла: скилл живёт в пакете pi-extensions, а зависимость — в проекте.
 */
async function loadPlaywright() {
	const hints = [];
	try {
		return createRequire(join(process.cwd(), "index.js"))("playwright");
	} catch (e) {
		hints.push(`из ${process.cwd()}: ${e?.code ?? e?.message}`);
	}
	try {
		return await import("playwright");
	} catch (e) {
		hints.push(`от скрипта: ${e?.code ?? e?.message}`);
	}
	console.error(
		`playwright не найден (${hints.join("; ")}).\n` +
			"Один раз в проверяемом проекте: npm i -D playwright && npx playwright install chromium,"
	);
	process.exit(3);
}

/** Проверки, которые решаются в браузере. Возвращает плоский объект под формат отчёта. */
function probe() {
	const sel = (el) => {
		const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
		return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "");
	};
	const box = (el) => el.getBoundingClientRect();
	const visible = (el) => {
		const cs = getComputedStyle(el);
		return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
	};
	const hasOwnText = (el) =>
		[...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);

	const doc = document.documentElement;
	const vw = Math.max(doc.clientWidth, window.innerWidth || 0);
	const f = {
		title: document.title,
		lang: document.documentElement.getAttribute("lang") || "",
		hscroll: doc.scrollWidth > vw + 1 ? doc.scrollWidth : 0,
		overflow: [],
		tiny_font: [],
		small_target: [],
		css: { transition_all: 0, will_change: [], reduced_motion: false, contrast_media: false },
		viewport: "",
	};

	for (const el of document.querySelectorAll("body *")) {
		if (!visible(el)) continue;
		const r = box(el);
		if (r.width === 0 && r.height === 0) continue;

		// элемент вылез за вьюпорт, а внутри него уже никто не вылезает: это он сам (typical min-width: 0)
		if (r.right > vw + 1 || r.left < -1) {
			const childOverflows = [...el.children].some((k) => {
				const kr = box(k);
				return kr.right > vw + 1 || kr.left < -1;
			});
			if (!childOverflows) f.overflow.push(`${sel(el)} ${Math.round(r.width)}px при вьюпорте ${vw}px`);
		}

		const size = Number.parseFloat(getComputedStyle(el).fontSize);
		if (size && size < 12 && hasOwnText(el)) f.tiny_font.push(`${sel(el)} ${size}px`);

		const clickable = el.matches("a[href],button,input,select,summary,[role=button],[role=link],[role=checkbox],[role=tab]");
		if (clickable && (r.width < 24 || r.height < 24)) f.small_target.push(`${sel(el)} ${Math.round(r.width)}x${Math.round(r.height)}px`);
	}

	// transition: all в cssText не найти: Chromium сериализует `transition: all .3s` как `transition: 0.3s`,
	// поэтому берем specified value из rule.style и обходим вложенные правила (@media, @supports) рекурсивно.
	const walkRules = (rules) => {
		for (const rule of rules || []) {
			if (rule.style) {
				if (rule.style.getPropertyValue("transition-property") === "all") f.css.transition_all++;
				const wc = rule.style.getPropertyValue("will-change");
				if (wc) f.css.will_change.push(wc);
			}
			const cond = rule.conditionText || (rule.media && rule.media.mediaText) || "";
			if (/prefers-reduced-motion/.test(cond)) f.css.reduced_motion = true;
			if (/prefers-contrast|prefers-reduced-transparency/.test(cond)) f.css.contrast_media = true;
			if (rule.cssRules) walkRules(rule.cssRules);
		}
	};
	for (const sheet of document.styleSheets) {
		try {
			walkRules(sheet.cssRules);
		} catch {
			/* сторонняя таблица стилей: cssRules недоступен */
		}
	}

	const meta = document.querySelector('meta[name="viewport"]');
	f.viewport = meta ? meta.getAttribute("content") || "" : "(нет meta viewport)";
	return f;
}

async function runAxe(page, axePath) {
	if (axePath) await page.addScriptTag({ path: axePath });
	else await page.addScriptTag({ url: AXE_CDN });
	return page.evaluate(async () => {
		const res = await window.axe.run(document, { resultTypes: ["violations"] });
		return res.violations.map((v) => ({
			impact: v.impact,
			id: v.id,
			help: v.help,
			nodes: v.nodes
				.slice(0, 5)
				.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary || "").replace(/\s+/g, " ").slice(0, 200) })),
		}));
	});
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

/** axe ищется в проверяемом проекте, а при запуске из репозитория скиллов — рядом со скриптом. */
function findAxe() {
	const candidates = [
		join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "node_modules", "axe-core", "axe.min.js"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Сравнение кадра с baseline: совпали хеши — decoding не нужен; различаются — побитовый
 * diff и размеченный PNG, чтобы было видно, что именно сдвинулось, а не только «что-то».
 */
function compareWithBaseline(baselineFile, currentFile, diffFile, threshold) {
	if (sha256(baselineFile) === sha256(currentFile)) return { same: true, baseline: baselineFile };
	try {
		const result = diffImages(decodePng(readFileSync(baselineFile)), decodePng(readFileSync(currentFile)), threshold);
		if (result.sizeDiff) return { sizeDiff: result.sizeDiff, baseline: baselineFile };
		writeFileSync(diffFile, encodePng(result.image));
		return {
			baseline: baselineFile,
			diffFile,
			changed: result.changed,
			percent: (100 * result.changed) / result.total,
		};
	} catch (e) {
		// PNG не разобран (палитра, 16 бит, interlace) — остаётся факт «отличается»
		return { baseline: baselineFile, changed: -1, note: `${e?.message ?? e}` };
	}
}

/** Нарушения axe уровня moderate и выше — по ним решает --strict. */
function worstViolations(pages) {
	return pages.flatMap((p) => p.violations.filter((v) => (IMPACT_RANK[v.impact] ?? 0) >= 1));
}

function report(opts, pages) {
	const lines = [];
	const worst = worstViolations(pages);
	lines.push(`# ui-check ${opts.url}`);

	for (const p of pages) {
		lines.push(`\n## ${p.width}px — нарушений axe: ${p.violations.length}`);
		if (p.error) {
			lines.push(`ошибка прогона: ${p.error}`);
			continue;
		}
		for (const v of p.violations) {
			lines.push(`- [${v.impact}] ${v.id} — ${v.help}`);
			for (const n of v.nodes) lines.push(`    ${n.target}${n.summary ? ` :: ${n.summary.replace(/\s+/g, " ")}` : ""}`);
		}
		const f = p.findings;
		if (f) {
			if (!f.lang) lines.push("- нет `<html lang>`");
			if (f.hscroll) lines.push(`- горизонтальный скролл: scrollWidth ${f.hscroll} > вьюпорт ${p.width}`);
			for (const o of f.overflow) lines.push(`- вылезает за вьюпорт: ${o} (проверить min-width: 0 у детей flex/grid)`);
			for (const t of f.tiny_font) lines.push(`- шрифт меньше 12px: ${t}`);
			for (const t of f.small_target) lines.push(`- кликабельная цель меньше 24px: ${t}`);
			if (f.css.transition_all) lines.push(`- transition: all в ${f.css.transition_all} правилах — перечисляй свойства явно`);
			if (f.css.will_change.length) lines.push(`- will-change: ${[...new Set(f.css.will_change)].join(", ")} — только на слоях, которые реально дёргаются`);
			if (!f.css.reduced_motion) lines.push("- нет prefers-reduced-motion (анимации не отключаются)");
			if (!f.css.contrast_media) lines.push("- нет prefers-contrast / prefers-reduced-transparency");
			if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(f.viewport)) lines.push(`- viewport блокирует зум: ${f.viewport}`);
			else lines.push(`- viewport: ${f.viewport}`);
		}
		lines.push(`- скриншот: ${p.screenshot}`);
		const b = p.baseline;
		if (b?.same) lines.push(`  baseline ${b.baseline}: кадр не изменился`);
		else if (b?.sizeDiff) lines.push(`  baseline ${b.baseline}: размеры разные (${b.sizeDiff}) — побитовое сравнение невозможно`);
		else if (b?.changed >= 0) lines.push(`  baseline ${b.baseline}: изменилось ${b.percent.toFixed(2)}% пикселей (${b.changed}) при пороге ${opts.threshold}, diff: ${b.diffFile}`);
		else if (b?.changed < 0) lines.push(`  baseline ${b.baseline}: отличается, diff недоступен (${b.note})`);
		else if (b?.baseline) lines.push(`  baseline: ${b.baseline}`);
	}

	if (opts.baseline) lines.push("\nКрасным в *-diff.png залиты изменившиеся пиксели: прочитай diff-кадр и скажи, что изменилось по делу.");
	if (!worst.length) lines.push("\nНарушений axe moderate+ нет. Глазами всё равно смотри: иерархию, плотность, состояния данных.");
	console.log(lines.join("\n"));
	return worst.length;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	mkdirSync(opts.out, { recursive: true });
	const pw = await loadPlaywright();
	let browser;
	try {
		browser = await pw.chromium.launch();
	} catch (e) {
		console.error(`chromium не запущен (${String(e?.message ?? e).split("\n")[0]}). npx playwright install chromium`);
		process.exit(4);
	}
	const context = await browser.newContext();
	const page = await context.newPage();

	const axePath = opts.axe ?? findAxe();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const pages = [];

	for (const width of opts.widths) {
		const rec = { width };
		try {
			await page.setViewportSize({ width, height: Math.round(width * 1.6) });
			await page.goto(opts.url, { waitUntil: "load", timeout: 30000 });
			for (const selector of opts.clicks) {
				await page.click(selector, { timeout: 5000 }).catch(() => {});
			}
			if (opts.wait) await page.waitForTimeout(opts.wait);
			rec.violations = await runAxe(page, axePath);
			rec.findings = await page.evaluate(probe);
			rec.screenshot = join(opts.out, `${width}.png`);
			await page.screenshot({ path: rec.screenshot, fullPage: true });
			if (opts.baseline) {
				const baselineFile = join(opts.baseline, `${width}.png`);
				rec.baseline = existsSync(baselineFile)
					? compareWithBaseline(baselineFile, rec.screenshot, join(opts.out, `${width}-diff.png`), opts.threshold)
					: { baseline: `${baselineFile} (нет файла)` };
			}
		} catch (e) {
			rec.error = `${e?.message ?? e}`;
			rec.violations = [];
			writeFileSync(join(opts.out, `${width}-error.txt`), `${opts.url} ${stamp}\n${rec.error}\n`);
		}
		pages.push(rec);
	}

	await browser.close();

	const moderatePlus = worstViolations(pages).length;
	if (opts.json) console.log(JSON.stringify({ url: opts.url, out: opts.out, moderatePlus, pages }, null, 1));
	else report(opts, pages);
	process.exit(opts.strict && moderatePlus > 0 ? 1 : 0);
}

export { parseArgs, probe, report, runAxe, worstViolations };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
