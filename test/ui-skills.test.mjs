/**
 * Смоук-тесты для скиллов ui-review и ui-design.
 * Run: node test/ui-skills.test.mjs
 *
 * Оффлайн-часть (проверка сборки: файлы, frontmatter, манифест, сниппеты, CLI-контракт)
 * выполняется всегда. Прогон в браузере требует playwright и chromium в проверяемом
 * каталоге: без них печатается skip, и прогон остаётся зелёным (как sandbox без bwrap).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const SCRIPT = join(repo, "skills", "ui-review", "scripts", "a11y.mjs");
const LINT = join(repo, "skills", "ui-review", "scripts", "lint-ui.mjs");
const PERF = join(repo, "skills", "ui-review", "scripts", "perf.mjs");
const UI_SKILLS = ["ui-review", "ui-design"];

const results = [];
function check(name, fn) {
	try {
		const skip = fn();
		results.push(skip === true ? `skip ${name}` : `ok   ${name}`);
		return skip !== true;
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
		return false;
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg || "assert failed");
}
function read(...parts) {
	return readFileSync(join(repo, ...parts), "utf8");
}
function frontmatter(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	assert(m, "нет frontmatter");
	const meta = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return meta;
}
function runScript(args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

// ── сборка: файлы, манифест, frontmatter ──

check("скиллы зарегистрированы в манифесте", () => {
	const skills = JSON.parse(read("package.json")).pi.skills;
	for (const name of UI_SKILLS) assert(skills.includes(`skills/${name}`), `${name} нет в pi.skills`);
});

for (const name of UI_SKILLS) {
	check(`скилл ${name}: frontmatter`, () => {
		const meta = frontmatter(read("skills", name, "SKILL.md"));
		assert(meta.name === name, `name=${meta.name}, ждали ${name}`);
		assert((meta.description || "").length > 60, "description слишком короткий для роутинга");
	});
}

/** Весь текст скилла: SKILL.md плюс всё из references/ (прогрессивная загрузка — проверки идут по всему корпусу). */
function skillText(name) {
	const root = join(repo, "skills", name);
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? walk(path) : [readFileSync(path, "utf8")];
		});
	return walk(root).join("\n");
}

check("ui-review: чеклист покрывает разделы, которые не ловит скрипт", () => {
	const text = skillText("ui-review");
	for (const needle of [
		"aria-current",
		"aria-expanded",
		"overscroll-behavior: contain",
		"min-width: 0",
		"drag-and-drop",
		"prefers-contrast",
		"100dvh",
		"minmax(0, 1fr)",
		"aria-live",
		"--baseline",
		"lint-ui.mjs",
		"Skip это не pass",
	]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("ui-design: план, референсы, preflight и анти-шаблоны", () => {
	const text = skillText("ui-design");
	for (const needle of [
		"web_search",
		"DESIGN.md",
		"Отвергнуто",
		"background-clip: text",
		"border-left",
		"ceil(секций / 3)",
		"Настроение:",
		"Якорь:",
		"2.5",
	]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("ui-design/движение: носитель по задаче, reduced-motion без пропажи контента, проверка в движении", () => {
	const text = read("skills", "ui-design", "references", "motion.md");
	for (const needle of [
		"prefers-reduced-motion",
		"transform",
		"transition: all",
		"will-change",
		"View Transitions",
		"IntersectionObserver",
		"INP",
		"scroll reveal",
	]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("ui-design/данные: формы, вырожденные данные, форматтеры, состояния", () => {
	const text = read("skills", "ui-design", "references", "data.md");
	for (const needle of [
		"Intl.NumberFormat",
		"aria-sort",
		"спайк",
		"виртуализац",
		"role=\"img\"",
		"скелетон",
		"нет прав",
	]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("ui-design: инвентарь существующего проекта и активы", () => {
	const text = skillText("ui-design");
	for (const needle of ["storybook", "стилевая база", "self-host", "size-adjust", "sprite"]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("ui-review/скорость: measure-first, CWV-пороги, keep-or-revert, CI-гард", () => {
	const text = read("skills", "ui-review", "references", "perf.md");
	for (const needle of ["perf.mjs", "lcp=2500", "cls=0.1", "inp=200", "--strict", "--click", "откатываем", "RUM"]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
	// браузерные скрипты и порядок работы с ними — в одном скилле: SKILL.md обязан ссылаться на references/perf.md
	assert(read("skills", "ui-review", "SKILL.md").includes("references/perf.md"), "SKILL.md не ссылается на references/perf.md");
	assert(text.includes("каталог скилла ui-review"), "в perf.md не указан путь к каталогу скриптов");
	});

check("ui-review: поведение виджетов описано и не противоречит чеклисту", () => {
	const text = skillText("ui-review");
	for (const needle of ["aria-patterns.md", "aria-activedescendant", "showModal", "aria-live", "aria-sort", "skip-link"]) {
		assert(text.includes(needle), `в скилле нет про ${needle}`);
	}
});

check("скиллы: ссылки на references не битые", () => {
	for (const name of UI_SKILLS) {
		const text = read("skills", name, "SKILL.md");
		for (const ref of new Set(text.match(/(?:\.\.\/)?[\w.-]+\/[\w./-]*\.md/g) || [])) {
			if (ref.startsWith("http")) continue;
			assert(existsSync(join(repo, "skills", name, ref)), `${name}: нет файла ${ref}, на который ссылается SKILL.md`);
		}
	}
});

check("a11y.mjs синтаксически пригоден", () => {
	execFileSync(process.execPath, ["--check", SCRIPT], { encoding: "utf8" });
});

// ── CLI-контракт ──

check("без url — exit 2 и usage", () => {
	const r = runScript([]);
	assert(r.status === 2, `exit=${r.status}`);
	assert(/usage:/.test(r.stderr), "нет строки usage");
});

check("неизвестный флаг — exit 2", () => {
	const r = runScript(["http://x", "--nope"]);
	assert(r.status === 2, `exit=${r.status}`);
	assert(/неизвестный флаг/.test(r.stderr), r.stderr);
});

check("не-http url отклоняется", () => {
	const r = runScript(["localhost:3000"]);
	assert(r.status === 2, `exit=${r.status}`);
});

check("порог diff вне (0..1] отклоняется", () => {
	for (const bad of ["abc", "0", "-1", "1.5"]) {
		const r = runScript(["http://x", "--diff-threshold", bad]);
		assert(r.status === 2 && /--diff-threshold/.test(r.stderr), `${bad}: exit=${r.status}`);
	}
});


const runPerf = (args) => spawnSync(process.execPath, [PERF, ...args], { encoding: "utf8" });

check("perf.mjs: аргументы — usage и exit 2", () => {
	const cases = [
		[[], /usage/],
		[["--nope"], /первым аргументом нужен url/],
		[["https://x.test", "--nope"], /неизвестный флаг/],
		[["https://x.test", "--budget", "fps=60"], /--budget/],
		[["example.com"], /file:\/\//],
	];
	for (const [args, re] of cases) {
		const r = runPerf(args);
		assert(r.status === 2 && re.test(r.stderr), `${args.join(" ")}: exit=${r.status} ${r.stderr.slice(0, 120)}`);
	}
});

const perf = await import(PERF);

check("perf.mjs: report печатает метрики, условия и вердикт по бюджету", () => {
	const { parseArgs, report } = perf;
	const opts = parseArgs(["https://x.test", "--budget", "lcp=1000", "--slow"]);
	const m = { lcp: 1200, cls: 0.02, inp: null, ttfb: 300, dcl: 900, load: 1000, tbt: 40, longtasks: [90], shifts: [{ value: 0.02, sources: ["img"] }], res: { total: 12, kb: 2048, groups: [{ key: ".png", count: 4, kb: 1800, ms: 400 }], slowest: [], heaviest: [] }, oversized: [{ ratio: 3.2, natural: 1600, shown: 500, src: "http://x/a.png" }], error: null };
	const text = report(opts, m).join("\n");
	assert(/LCP: 1200 мс — ПРЕВЫШЕН БЮДЖЕТ 1000/.test(text), `нет вердикта по LCP: ${text}`);
	assert(/CLS: 0.02 — в бюджете/.test(text), "нет строки CLS");
	assert(/INP: не измерено/.test(text), "INP без действий обязан быть «не измерено»");
	assert(/сеть 4G/.test(text), "не указано условие замера");
	assert(/2.0 МБ|2048 КБ/.test(text) && /запросов: 12/.test(text), "нет разбивки по весу");
	assert(/3.2x/.test(text), "не показаны oversized-картинки");
});

check("perf.mjs: незамеренная страница — НЕ ЗАМЕРЕНО, а не пустой успех", () => {
	const { parseArgs, report } = perf;
	const text = report(parseArgs(["https://x.test"]), { error: "page.goto: timeout" }).join("\n");
	assert(/НЕ ЗАМЕРЕНО/.test(text) && /не считается прошедшим/.test(text), text);
});


const png = await import(`file://${join(repo, "skills", "ui-review", "scripts", "png-diff.mjs")}`);
const mod = await import(`file://${SCRIPT}`);

/** Строка PNG с указанным фильтром, чтобы разобрать все ветки unfilter, а только None. */
function pngWithFilter(rows, filter) {
	const width = rows[0].length / 3;
	const height = rows.length;
	const bpp = 3;
	const raw = Buffer.alloc(height * (1 + rows[0].length));
	const previous = Buffer.alloc(rows[0].length);
	for (let y = 0; y < height; y++) {
		const src = Buffer.from(rows[y]);
		const line = Buffer.alloc(rows[0].length);
		for (let i = 0; i < src.length; i++) {
			const left = i >= bpp ? src[i - bpp] : 0;
			const above = previous[i];
			const upLeft = i >= bpp ? previous[i - bpp] : 0;
			let pred = 0;
			if (filter === 1) pred = left;
			else if (filter === 2) pred = above;
			else if (filter === 3) pred = (left + above) >> 1;
			else if (filter === 4) {
				const p = left + above - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - above);
				const pc = Math.abs(p - upLeft);
				pred = pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft;
			}
			line[i] = (src[i] - pred) & 0xff;
		}
		raw[y * (1 + src.length)] = filter;
		line.copy(raw, y * (1 + src.length) + 1);
		src.copy(previous);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2; // RGB — как у скриншотов playwright
	return pngChunk(["IHDR", "IDAT", "IEND"], [ihdr, deflateSync(raw), Buffer.alloc(0)]);
}

function pngChunk(types, bodies) {
	const { crc32 } = png;
	const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
	for (let i = 0; i < types.length; i++) {
		const body = bodies[i];
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write(types[i], 4, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
		parts.push(head, body, crc);
	}
	return Buffer.concat(parts);
}

check("png-diff: roundtrip encode/decode", () => {
	const width = 5;
	const height = 3;
	const data = Buffer.alloc(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = i % 256;
		data[i + 1] = (i * 3) % 256;
		data[i + 2] = (i * 7) % 256;
		data[i + 3] = 255;
	}
	const back = png.decodePng(png.encodePng({ width, height, data }));
	assert(back.width === width && back.height === height, "размер потерялся");
	assert(back.data.equals(data), "пиксели не совпали после roundtrip");
});

check("png-diff: все пять фильтров строк разбираются", () => {
	const rows = [
		[10, 20, 30, 200, 190, 180, 5, 5, 5],
		[11, 21, 31, 201, 191, 181, 6, 6, 6],
		[250, 250, 250, 0, 1, 2, 128, 64, 32],
	];
	for (const filter of [0, 1, 2, 3, 4]) {
		const decoded = png.decodePng(pngWithFilter(rows, filter));
		assert(decoded.width === 3 && decoded.height === 3, `фильтр ${filter}: размер`);
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 3; x++) {
				const src = y * 9 + x * 3;
				const dst = (y * 3 + x) * 4;
				assert(
					decoded.data[dst] === rows[y][x * 3] && decoded.data[dst + 1] === rows[y][x * 3 + 1] && decoded.data[dst + 2] === rows[y][x * 3 + 2],
					`фильтр ${filter}: пиксель ${x},${y} = ${decoded.data[dst]},${decoded.data[dst + 1]},${decoded.data[dst + 2]}`
				);
			}
		}
	}
});

check("png-diff: считает изменённые пиксели и размечает кадр", () => {
	const mk = (changedPixels) => {
		const width = 4;
		const height = 2;
		const data = Buffer.alloc(width * height * 4, 200);
		for (let i = 0; i < data.length; i += 4) data[i] = 10; // фон уже «тёмный»: шум ниже порога не должен давать изменений
		for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
		for (let n = 0; n < changedPixels; n++) {
			data[n * 4] = 10;
			data[n * 4 + 1] = 200;
			data[n * 4 + 2] = 30;
		}
		return { width, height, data };
	};
	const same = png.diffImages(mk(0), mk(0));
	assert(same.changed === 0 && same.total === 8, `same: ${JSON.stringify(same.changed)}`);

	const result = png.diffImages(mk(0), mk(3));
	assert(result.changed === 3, `changed=${result.changed}`);
	assert(result.image.width === 4 && result.image.data.length === 8 * 4, "разметка не того размера");
	assert(result.image.data[0] === 255 && result.image.data[1] === 0, "изменённый пиксель не залит красным");

	const noise = png.diffImages(mk(0), { ...mk(0), data: mk(0).data.map((v, i) => (i % 4 === 3 ? 255 : v - 5)) });
	assert(noise.changed === 0, "мелкий шум не должен считаться изменением");
});

check("png-diff: порог влияет на число изменений", () => {
	// 40/255 = 0.157 (проходит порог 0.12, не проходит 0.2), 8/255 = 0.031 (не проходит оба)
	const before = png.decodePng(png.encodePng({ width: 2, height: 1, data: Buffer.from([100, 100, 100, 255, 100, 100, 100, 255]) }));
	const after = png.decodePng(png.encodePng({ width: 2, height: 1, data: Buffer.from([140, 100, 100, 255, 108, 100, 100, 255]) }));
	assert(png.diffImages(before, after, 0.12).changed === 1, "на пороге 0.12 ждали один изменённый пиксель");
	assert(png.diffImages(before, after, 0.2).changed === 0, "на пороге 0.2 изменений быть не должно");
});

check("png-diff: разные размеры и неподдержанный PNG — явная причина", () => {
	const a = { width: 2, height: 2, data: Buffer.alloc(16, 100) };
	const b = { width: 3, height: 2, data: Buffer.alloc(24, 100) };
	assert(png.diffImages(a, b).sizeDiff === "2x2 против 3x2", "sizeDiff не описан");
	const interlaced = pngChunk(["IHDR", "IDAT", "IEND"], [
		Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 1]),
		Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 0, 1]),
		Buffer.alloc(0),
	]);
	let threw = "";
	try {
		png.decodePng(interlaced);
	} catch (e) {
		threw = String(e.message);
	}
	assert(/interlace=1/.test(threw), `interlace не отклонён: ${threw}`);
});

check("parseArgs: ширины, клики, строгий режим", () => {
	const o = mod.parseArgs(["http://a", "--widths", "320,1440", "--click", "a.b, .c", "--strict", "--wait", "0"]);
	assert(o.url === "http://a" && o.strict === true, "url/strict");
	assert(o.widths.join() === "320,1440", `widths=${o.widths}`);
	assert(o.clicks.join() === "a.b,.c", `clicks=${o.clicks}`);
	assert(o.out.startsWith("ui-review"), `out=${o.out} — по умолчанию под каталогом проекта`);
	assert(o.threshold === 0.12, `порог по умолчанию=${o.threshold}`);
	assert(mod.parseArgs(["http://a", "--diff-threshold", "0.4"]).threshold === 0.4, "порог не применился");
	const cond = mod.parseArgs(["http://a", "--dark", "--reduced-motion", "--zoom", "2"]);
	assert(cond.dark === true && cond.reducedMotion === true && cond.zoom === 2, `dark/reduced-motion/zoom=${JSON.stringify(cond)}`);
});

check("--zoom вне (1..4] отклоняется", () => {
	for (const bad of ["abc", "1", "9"]) {
		const r = runScript(["http://x", "--zoom", bad]);
		assert(r.status === 2 && /--zoom/.test(r.stderr), `${bad}: exit=${r.status}`);
	}
});

check("report: нарушения, поломки вёрстки и --strict по moderate+", () => {
	const pages = [
		{
			width: 375,
			violations: [
				{ impact: "critical", id: "image-alt", help: "alt обязателен", nodes: [{ target: "img", summary: "no alt" }] },
				{ impact: "minor", id: "landmark", help: "landmark желателен", nodes: [] },
			],
			findings: {
				lang: "",
				hscroll: 512,
				overflow: ["div.card 412px при вьюпорте 375px"],
				tiny_font: [],
				small_target: ["a.icon 18x18px"],
				contrast: ['"Подпись" 3.10:1 при нужных 4.5:1 — span.hint'],
				contrast_checked: 40,
				contrast_skipped: { disabled: 3, фон: 5 },
				broken_img: [],
				dead_link: [],
				deep_z: [],
				non_swappable: [],
				fonts: { loaded: 2, failed: 0, families: ["Inter"], no_display_swap: 1 },
				css: { transition_all: 2, will_change: ["opacity"], reduced_motion: false, contrast_media: false },
				viewport: "width=device-width, user-scalable=no",
			},
			screenshot: "ui-review/run/375.png",
			baseline: {
				baseline: "ui-review/base/375.png",
				changed: 1598,
				percent: 0.35,
				diffFile: "ui-review/run/375-diff.png",
			},
		},
		{ width: 768, violations: [], screenshot: "ui-review/run/768.png", baseline: { same: true, baseline: "ui-review/base/768.png" } },
		{ width: 1440, violations: [], error: "net::ERR_CONNECTION_REFUSED", screenshot: "" },
	];
	assert(mod.worstViolations(pages).length === 1, "minor не должен попадать в moderate+");

	const reportOpts = { url: "http://a", baseline: "ui-review/base", threshold: 0.12 };
	const log = console.log;
	const out = [];
	console.log = (s) => out.push(String(s));
	try {
		mod.report(reportOpts, pages);
	} finally {
		console.log = log;
	}
	const text = out.join("\n");
	for (const needle of [
		"[critical] image-alt",
		"вылезает за вьюпорт",
		"transition: all в 2 правилах",
		"viewport блокирует зум",
		"изменилось 0.35% пикселей (1598) при пороге 0.12, diff: ui-review/run/375-diff.png",
		"768px",
		"кадр не изменился",
		"ERR_CONNECTION_REFUSED",
	]) {
		assert(text.includes(needle), `в отчёте нет про ${needle}`);
	}
	// minor печатается в отчёте, но в --strict не попадает — за это отвечает worstViolations
	assert(text.includes("[minor] landmark"), "minor должен оставаться в отчёте");
});

// ── lint-ui.mjs: статические правила по исходникам ──

check("lint-ui: находит заведомые поломки и слушается ui-lint-disable", () => {
	const dir = mkdtempSync(join(tmpdir(), "ui-lint-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "a.css"),
		[
			"html { overflow-x: hidden; }",
			".hero { transition: all .3s; width: 100vw !important; }",
			".card { border-left: 4px solid #7c3aed; }",
			"@keyframes fade { from { opacity: 0 } }",
		].join("\n")
	);
	writeFileSync(
		join(dir, "src", "b.html"),
		[
			"<main>",
			"<p>Learn more · Acme Corp · lorem ipsum</p>",
			"<button>🚀 Запуск</button>",
			"<link rel=stylesheet href=https://fonts.googleapis.com/css2?family=Inter>",
			"@font-face{font-family:X;src:url(https://cdn.example.com/x.woff2)}",
			"<!-- ui-lint-disable no-generic-cta -->",
			"<button>Подробнее</button>",
			"</main>",
		].join("\n")
	);
	const r = spawnSync(process.execPath, [LINT, join(dir, "src")], { encoding: "utf8" });
	assert(r.status === 0, `exit=${r.status}: ${r.stderr.slice(0, 200)}`);
	for (const id of [
		"no-transition-all",
		"no-100vw",
		"no-important-size",
		"no-overflow-x-hidden-root",
		"no-keyframes-without-reduced-motion",
		"no-placeholder-copy",
		"no-emoji-icon",
		"no-side-stripe",
		"no-purple-gradient",
		"no-remote-assets",
	]) {
		assert(r.stdout.includes(`[${id}]`), `нет правила ${id}`);
	}
	assert(!r.stdout.includes("[no-generic-cta]"), "ui-lint-disable не снял правило");

	const strict = spawnSync(process.execPath, [LINT, join(dir, "src"), "--strict"], { encoding: "utf8" });
	assert(strict.status === 1, `--strict exit=${strict.status}`);

	const allowed = spawnSync(
		process.execPath,
		[LINT, join(dir, "src"), "--rule-allow", "no-transition-all,no-100vw,no-important-size,no-overflow-x-hidden-root,no-keyframes-without-reduced-motion,no-placeholder-copy"],
		{ encoding: "utf8" }
	);
	for (const id of ["no-transition-all", "no-placeholder-copy"]) {
		assert(!allowed.stdout.includes(`[${id}]`), `--rule-allow не снял ${id}`);
	}

	const json = JSON.parse(spawnSync(process.execPath, [LINT, join(dir, "src"), "--json"], { encoding: "utf8" }).stdout);
	assert(json.files === 2 && json.findings.length > 0, `json: ${JSON.stringify(json).slice(0, 120)}`);
	assert(json.findings.every((f) => f.rule && f.file && f.line > 0), "в json не хватает полей");
});

check("lint-ui: ключевой каталог и пустой каталог — exit 2 с объяснением", () => {
	const home = spawnSync(process.execPath, [LINT, process.env.HOME], { encoding: "utf8" });
	assert(home.status === 2 && /ключевой каталог/.test(home.stderr), `HOME exit=${home.status}`);
	const empty = mkdtempSync(join(tmpdir(), "ui-lint-empty-"));
	const r = spawnSync(process.execPath, [LINT, empty], { encoding: "utf8" });
	assert(r.status === 2 && /нет файлов/.test(r.stderr), `пусто exit=${r.status}`);
});

// ── прогон в браузере (нужен playwright + chromium: оба ставит npm ci этого репозитория) ──

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>.a{transition: all .3s; font-size:10px}.row{display:flex}.row div{white-space:nowrap}
.dim{color:#9aa0a6;background:#fff}</style>
</head><body><main><h1>Экран</h1>
<div class="row"><div>очень длинная строка, которая не переносится и вылезает за границы вьюпорта на мобильной ширине</div></div>
<span class="a">мелкий текст</span><button></button><img src="x.png" width="24" height="24">
<p class="dim">Серый текст на белом: контраст ниже AA</p>
<a href="#">Подробнее</a><img src="net-takogo.png" alt="битая картинка">
</main></body></html>`;

const tmp = mkdtempSync(join(tmpdir(), "ui-a11y-"));
const pageFile = join(tmp, "bad.html");
writeFileSync(pageFile, FIXTURE);
writeFileSync(join(tmp, "big.html"), FIXTURE.replace("font-size:10px", "font-size:28px"));

/** Пропуск, когда в окружении нет playwright (exit 3) или не встал chromium (exit 4). */
function skipped(run) {
	return run.status === 3 || run.status === 4;
}

const first = runScript([`file://${pageFile}`, "--widths", "375", "--out", join(tmp, "run"), "--wait", "0"]);

check("e2e: axe и layout-пробы находят заведомые поломки", () => {
	if (skipped(first)) return true;
	assert(first.status === 0, `exit=${first.status}: ${first.stderr.slice(0, 300)}`);
	for (const needle of [
		"image-alt",
		"button-name",
		"meta-viewport",
		"html-has-lang",
		"вылезает за вьюпорт",
		"transition: all",
		"шрифт меньше 12px",
		"контраст ниже AA",
		"контраст: проверено",
		"ссылка без назначения",
		"не загрузилась картинка",
		"контраст: проверено",
	]) {
		assert(first.stdout.includes(needle), `нет ${needle}`);
	}
	assert(existsSync(join(tmp, "run", "375.png")), "скриншот не записан");
});

check("e2e: чистая страница не даёт ложных находок по контрасту и медиа", () => {
	writeFileSync(
		join(tmp, "clean.html"),
		[
			'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>чисто</title>',
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			"<style>body{margin:0;background:#fff;color:#111;font-size:16px}a{color:#0b57d0}</style></head>",
			'<body><main><h1>Экран</h1><p>Обычный текст с достаточным контрастом.</p>',
			'<a href="/x">Открыть отчёт</a></main></body></html>',
		].join("\n")
	);
	const r = runScript([`file://${join(tmp, "clean.html")}`, "--widths", "375", "--out", join(tmp, "clean"), "--wait", "0"]);
	if (skipped(r)) return true;
	assert(r.stdout.includes("контраст: проверено"), "расчёт контраста не отработал");
	assert(!r.stdout.includes("контраст ниже AA"), `ложный контраст:\n${r.stdout}`);
	assert(!r.stdout.includes("медиа без размеров") && !r.stdout.includes("ссылка без назначения"), `ложные находки:\n${r.stdout}`);
});

check("e2e: --dark и --reduced-motion проверяют состояния, а не только светлую тему", () => {
	writeFileSync(
		join(tmp, "reveal.html"),
		[
			'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>reveal</title>',
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			"<style>body{margin:0;background:#fff;color:#111;font-size:16px}.reveal{opacity:0;transform:translateY(10px)}</style></head>",
			'<body><main><h1 class="reveal">Заголовок из reveal</h1><p>Обычный текст.</p></main></body></html>',
		].join("\n")
	);
	const url = `file://${join(tmp, "reveal.html")}`;

	const rm = runScript([url, "--widths", "375", "--out", join(tmp, "rm"), "--wait", "0", "--reduced-motion"]);
	if (skipped(rm)) return true;
	assert(rm.stdout.includes("текст остался невидимым"), `нет находки про невидимый текст:\n${rm.stdout}`);
	assert(rm.stdout.includes("условия: prefers-reduced-motion: reduce"), "условия прогона не названы");
	assert(rm.status === 1, `невидимый текст обязан валить прогон, exit=${rm.status}`);

	const dark = runScript([url, "--widths", "375", "--out", join(tmp, "dark"), "--wait", "0", "--dark", "--zoom", "2"]);
	if (skipped(dark)) return true;
	assert(existsSync(join(tmp, "dark", "375-dark-x2.png")), "скриншот состояния должен писаться под своим именем, иначе тёмный кадр сравнится со светлым baseline");
});

check("e2e: --strict валит прогон на нарушениях moderate+", () => {
	const strict = runScript([`file://${pageFile}`, "--widths", "375", "--out", join(tmp, "strict"), "--wait", "0", "--strict"]);
	if (skipped(strict)) return true;
	assert(strict.status === 1, `exit=${strict.status}`);
});

check("e2e: тот же кадр против baseline — изменений нет", () => {
	const again = runScript([`file://${pageFile}`, "--widths", "375", "--out", join(tmp, "same"), "--baseline", join(tmp, "run"), "--wait", "0"]);
	if (skipped(again)) return true;
	assert(again.stdout.includes("кадр не изменился"), again.stdout.slice(-400));
});

check("e2e: изменённый кадр — побитовый diff и размеченный PNG", () => {
	const changed = runScript([`file://${join(tmp, "big.html")}`, "--widths", "375", "--out", join(tmp, "diff"), "--baseline", join(tmp, "run"), "--wait", "0"]);
	if (skipped(changed)) return true;
	const match = /изменилось (\d+\.\d+)% пикселей \((\d+)\)/.exec(changed.stdout);
	assert(match, `нет строки diff: ${changed.stdout.slice(-400)}`);
	assert(Number(match[2]) > 100, `подозрительно мало изменённых пикселей: ${match[2]}`);
	assert(existsSync(join(tmp, "diff", "375-diff.png")), "diff-кадр не записан");
});

check("e2e: --json отдаёт нарушения и diff в машиночитаемом виде", () => {
	const json = runScript([`file://${join(tmp, "big.html")}`, "--widths", "375", "--out", join(tmp, "json"), "--baseline", join(tmp, "run"), "--wait", "0", "--json"]);
	if (skipped(json)) return true;
	const data = JSON.parse(json.stdout);
	assert(data.moderatePlus > 0, "moderatePlus пустой");
	assert(data.pages[0].violations.some((v) => v.id === "image-alt"), "в json нет image-alt");
	assert(data.pages[0].baseline.changed > 0, "в json нет числа изменённых пикселей");
});

check("e2e: perf.mjs меряет LCP/CLS/TBT и валит --strict при превышении бюджета", () => {
	const page = join(tmp, "perf.html");
	writeFileSync(
		page,
		`<!doctype html><html lang=ru><head><meta charset=utf-8><title>perf</title></head><body><main><h1>Замер</h1>
<button id=b>Жми</button><script>
b.addEventListener('click', () => { const t = Date.now(); while (Date.now() - t < 120); });
</script></main></body></html>`
	);
	const run = runPerf([`file://${page}`, "--width", "375", "--click", "#b", "--wait", "400", "--out", join(tmp, "perf")]);
	if (skipped(run)) return true;
	assert(run.status === 0, `exit=${run.status}: ${run.stderr.slice(0, 200)}`);
	assert(/- LCP: \d+ мс/.test(run.stdout), "нет LCP");
	assert(/- CLS: [\d.]+/.test(run.stdout), "нет CLS");
	assert(/- INP: \d+ мс/.test(run.stdout), "после --click обязан появиться INP");
	assert(/TBT по длинным задачам: \d+ мс/.test(run.stdout), "нет TBT");
	assert(existsSync(join(tmp, "perf", "perf.md")), "perf.md не записан");

	const strict = runPerf([`file://${page}`, "--width", "375", "--budget", "lcp=1", "--wait", "100", "--out", join(tmp, "perf2"), "--strict"]);
	if (skipped(strict)) return true;
	assert(strict.status === 1, `при бюджете lcp=1 ожидаем exit 1, получили ${strict.status}`);
	assert(/ПРЕВЫШЕН БЮДЖЕТ/.test(strict.stdout), "в отчёте нет пометки о превышении");
});

check("e2e: a11y.mjs на незагружаемой странице — НЕ ПРОВЕРЕНО и exit 1", () => {
	const run = runScript([`file://${join(tmp, "net-takogo.html")}`, "--widths", "375", "--out", join(tmp, "dead"), "--wait", "0"]);
	if (skipped(run)) return true;
	assert(/НЕ ПРОВЕРЕНО/.test(run.stdout), "нет пометки о непроверенной ширине");
	assert(run.status === 1, `exit=${run.status}, ждали 1: непроверенный экран не считается чистым`);
});

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);

