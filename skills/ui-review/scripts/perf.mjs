#!/usr/bin/env node
/**
 * node perf.mjs <url> [flags] — замеры производительности в реальном chromium.
 *
 * Смысл один: правки производительности без замера до и после — гадание. Скрипт
 * даёт Core Web Vitals в лабораторных условиях, разбивку по ресурсам и вердикт по
 * бюджету. Это лабораторные числа: они не равны RUM с реальных устройств.
 *
 * Выход: 0 — бюджет выдержан, 1 — бюджет превышен или страница не замерилась,
 * 2 — неверные аргументы, 3 — playwright не найден, 4 — chromium не запустился.
 *
 * Флаги:
 *   --budget lcp=2500,cls=0.1,inp=200   бюджет, по которому решается вердикт
 *   --click "css,css"                   действия после загрузки (для INP)
 *   --slow                              сеть как в 4G (CDP Network.emulateNetworkConditions)
 *   --wait MS                           пауза после загрузки и действий, копить метрики
 *   --width W                           ширина вьюпорта (по умолчанию 1280)
 *   --out DIR                           куда положить perf.md / perf.json
 *   --json                              машиночитаемый вывод
 *   --strict                            превышение бюджета = exit 1 (иначе только вердикт в тексте)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChromium, loadPlaywright } from "./browser.mjs";

// Пороги «хорошо» из Core Web Vitals.
const DEFAULT_BUDGET = { lcp: 2500, cls: 0.1, inp: 200, ttfb: 800 };
const METRICS = Object.keys(DEFAULT_BUDGET);

function usage(msg) {
	if (msg) console.error(`perf.mjs: ${msg}`);
	console.error(
		'usage: node perf.mjs <url> [--budget lcp=2500,cls=0.1,inp=200] [--click "css,css"] [--slow] [--wait MS] [--width W] [--out DIR] [--json] [--strict]'
	);
	process.exit(2);
}

const SWITCH_FLAGS = new Set(["--json", "--strict", "--slow"]);
const VALUE_FLAGS = new Set(["--budget", "--click", "--wait", "--width", "--out"]);

export function parseArgs(argv) {
	const opts = { budget: { ...DEFAULT_BUDGET }, clicks: [], wait: 1500, width: 1280 };
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
			case "--budget":
				for (const part of value.split(",")) {
					const [k, vRaw] = part.split("=");
					const v = Number.parseFloat(vRaw);
					if (!METRICS.includes(k?.trim()) || !Number.isFinite(v)) usage(`--budget: ждал ${METRICS.join(", ")} в виде k=v, получил «${part}»`);
					opts.budget[k.trim()] = v;
				}
				break;
			case "--click": opts.clicks = value.split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--wait": opts.wait = Number.parseInt(value, 10); break;
			case "--width": opts.width = Number.parseInt(value, 10); break;
			case "--out": opts.out = value; break;
		}
	}
	if (opts.url?.startsWith("--")) usage(`первым аргументом нужен url, получен флаг ${opts.url}`);
	if (!opts.url || !/^(https?|file):\/\//.test(opts.url)) usage("нужен http(s):// или file:// url");
	return opts;
}

/**
 * Ставится до загрузки документа: наблюдатели должны увидеть события с самого
 * начала, иначе LCP и CLS приходят пустыми.
 */
const COLLECT = `(() => {
	window.__perf = { lcp: 0, cls: 0, inp: 0, longtasks: [], shifts: [] };
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
	}).observe({ type: "largest-contentful-paint", buffered: true });
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) {
			if (e.hadRecentInput) continue;
			window.__perf.cls += e.value;
			if (e.value > 0.005) window.__perf.shifts.push({ value: +e.value.toFixed(4), sources: (e.sources || []).map((s) => s.node && s.node.tagName ? s.node.tagName.toLowerCase() : "?").slice(0, 3) });
		}
	}).observe({ type: "layout-shift", buffered: true });
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) window.__perf.inp = Math.max(window.__perf.inp, e.duration);
	}).observe({ type: "event", durationThreshold: 40, buffered: true });
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) if (e.duration > 50) window.__perf.longtasks.push(Math.round(e.duration));
	}).observe({ type: "longtask", buffered: true });
})()`;

/** Разбивка ресурсов по типу + самые долгие и самые тяжёлые. */
function resources() {
	const rows = performance.getEntriesByType("resource").map((e) => ({
		name: e.name,
		type: /^(https?):/.test(e.name) ? (e.initiatorType || "other") : "local",
		ext: (e.name.split("?")[0].match(/\.[a-z0-9]+$/i) || ["?"])[0].toLowerCase(),
		ms: Math.round(e.duration),
		kb: Math.round((e.transferSize || e.encodedBodySize || 0) / 1024),
	}));
	const byKey = new Map();
	for (const r of rows) {
		const key = r.ext !== "." + "?" && r.ext !== "?" ? r.ext : r.type;
		const g = byKey.get(key) ?? { key, count: 0, kb: 0, ms: 0 };
		g.count += 1;
		g.kb += r.kb;
		g.ms = Math.max(g.ms, r.ms);
		byKey.set(key, g);
	}
	return {
		total: rows.length,
		kb: rows.reduce((s, r) => s + r.kb, 0),
		groups: [...byKey.values()].sort((a, b) => b.kb - a.kb),
		slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5),
		heaviest: [...rows].sort((a, b) => b.kb - a.kb).slice(0, 5),
	};
}

/** Картинки, отданные больше, чем показаны, — самый частый источник лишнего веса. */
function oversizedImages() {
	return [...document.images]
		.map((img) => {
			const r = img.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			const shown = Math.round(r.width * dpr);
			return { src: img.currentSrc || img.src, natural: img.naturalWidth, shown, ratio: shown > 0 ? +(img.naturalWidth / shown).toFixed(1) : 0 };
		})
		.filter((i) => i.ratio >= 2 && i.natural > 600)
		.sort((a, b) => b.ratio - a.ratio)
		.slice(0, 5);
}

const fmtKb = (kb) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} МБ` : `${Math.round(kb)} КБ`);

export function report(opts, m) {
	const lines = [`# perf ${opts.url}`, `Условия: ${opts.slow ? "сеть 4G (эмуляция CDP)" : "без эмуляции сети"}, вьюпорт ${opts.width}px, лабораторные замеры, не RUM.`];
	if (opts.url.startsWith("file://")) lines.push("file://: ресурсная статистика и TTFB неполные — меряй против dev-сервера (npm run dev / preview).");
	if (m.error) {
		lines.push(`\nНЕ ЗАМЕРЕНО: ${m.error}`);
		lines.push("\nСтраница не отдала метрики — результат не считается прошедшим.");
		return lines;
	}
	const verdict = (key, value, unit) => {
		if (value === null) return `- ${key.toUpperCase()}: не измерено`;
		const limit = opts.budget[key];
		if (limit === undefined) return `- ${key.toUpperCase()}: ${value}${unit}`;
		return `- ${key.toUpperCase()}: ${value}${unit} — ${value <= limit ? "в бюджете" : `ПРЕВЫШЕН БЮДЖЕТ ${limit}${unit}`}`;
	};
	lines.push("");
	lines.push(verdict("lcp", m.lcp, " мс"));
	lines.push(verdict("cls", m.cls, ""));
	lines.push(m.inp === null ? "- INP: не измерено (не было действий после загрузки — передай --click)" : verdict("inp", m.inp, " мс"));
	lines.push(verdict("ttfb", m.ttfb, " мс"));
	lines.push(`- DOMContentLoaded: ${m.dcl} мс, загрузка: ${m.load} мс`);
	lines.push(`- TBT по длинным задачам: ${m.tbt} мс (${m.longtasks.length} задач дольше 50 мс)`);
	lines.push(`- запросов: ${m.res.total}, передано: ${fmtKb(m.res.kb)}`);

	if (m.shifts.length) {
		lines.push("\nСдвиги макета (кто двигал):");
		for (const s of m.shifts.slice(0, 5)) lines.push(`  ${s.value} — ${s.sources.join(", ")}`);
	}
	if (m.res.groups.length) {
		lines.push("\nВес по типам:");
		for (const g of m.res.groups.slice(0, 8)) lines.push(`  ${g.key}: ${g.count} шт., ${fmtKb(g.kb)}, самый долгий ${g.ms} мс`);
	}
	if (m.res.slowest.length) {
		lines.push("\nСамые долгие запросы:");
		for (const r of m.res.slowest) lines.push(`  ${r.ms} мс  ${fmtKb(r.kb)}  ${r.name.slice(0, 90)}`);
	}
	if (m.oversized.length) {
		lines.push("\nКартинки отданы крупнее, чем показаны (первое место, где лежит вес):");
		for (const i of m.oversized) lines.push(`  ${i.ratio}x: ${i.natural}px при показе ${i.shown}px — ${i.src.slice(0, 80)}`);
	}
	const over = METRICS.filter((k) => opts.budget[k] !== undefined && m[k] !== null && m[k] > opts.budget[k]);
	lines.push("");
	lines.push(over.length ? `Превышен бюджет: ${over.map((k) => k.toUpperCase()).join(", ")}.` : "Бюджет выдержан по всем измеренным метрикам.");
	lines.push("Чинить по одному: замер → правка → замер. Стало хуже — откатить, а не докручивать вторую правку поверх.");
	return lines;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const pw = await loadPlaywright();
	const browser = await launchChromium(pw);
	const context = await browser.newContext({ viewport: { width: opts.width, height: Math.round(opts.width * 0.8) } });
	const page = await context.newPage();
	await page.addInitScript(COLLECT);

	let m = { error: null };
	try {
		if (opts.slow) {
			const cdp = await context.newCDPSession(page);
			// ~4 Мбит/s и 150 мс RTT — типовой профиль 4G в DevTools.
			await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 });
		}
		await page.goto(opts.url, { waitUntil: "load", timeout: 45000 });
		for (const selector of opts.clicks) await page.click(selector, { timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(opts.wait);
		const nav = await page.evaluate(() => {
			const p = window.__perf ?? {};
			const n = performance.getEntriesByType("navigation")[0] ?? {};
			return {
				lcp: p.lcp ? Math.round(p.lcp) : null,
				cls: p.cls !== undefined ? +p.cls.toFixed(3) : null,
				inp: p.inp ? Math.round(p.inp) : null,
				shifts: p.shifts ?? [],
				longtasks: p.longtasks ?? [],
				tbt: (p.longtasks ?? []).reduce((sum, d) => sum + Math.max(0, d - 50), 0),
				ttfb: n.responseStart ? Math.round(n.responseStart) : null,
				dcl: n.domContentLoadedEventEnd ? Math.round(n.domContentLoadedEventEnd) : null,
				load: n.loadEventEnd ? Math.round(n.loadEventEnd) : null,
			};
		});
		{
			const res = await page.evaluate(resources);
			const oversized = await page.evaluate(oversizedImages);
			m = {
					...nav,
					res,
					oversized,
				};
		}
	} catch (e) {
		m = { error: `${e?.message ?? e}`.split("\n")[0] };
	}

	opts.out ??= join("ui-review", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
	mkdirSync(opts.out, { recursive: true });
	if (opts.json) {
		const data = { url: opts.url, budget: opts.budget, slow: !!opts.slow, width: opts.width, ...m };
		writeFileSync(join(opts.out, "perf.json"), `${JSON.stringify(data, null, 2)}\n`);
		console.log(JSON.stringify(data, null, 2));
	} else {
		const lines = report(opts, m);
		writeFileSync(join(opts.out, "perf.md"), `${lines.join("\n")}\n`);
		console.log(lines.join("\n"));
	}
	const over = !m.error && METRICS.some((k) => opts.budget[k] !== undefined && m[k] !== null && m[k] > opts.budget[k]);
	await browser.close();
	process.exit(m.error || (opts.strict && over) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
