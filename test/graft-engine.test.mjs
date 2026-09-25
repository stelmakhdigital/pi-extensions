/**
 * Unit-тесты pi-graft-engine (движок + queries + deep с фейк-LLM).
 * Run: node test/graft-engine.test.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(fileURLToPath(import.meta.url));
const engine = jiti("../engine/graft/src/index.ts");

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? "assert failed");
}

// ── Фикстура-репо ──
const root = mkdtempSync(join(tmpdir(), "ge-test-"));
execFileSync("git", ["init", "-q", "."], { cwd: root });
const mkfile = (p, content) => {
	mkdirSync(join(root, p, ".."), { recursive: true });
	writeFileSync(join(root, p), content);
};
mkfile("src/app.ts", `import { boost } from "./util.js";
export class Engine {
	readonly name: string;
	constructor(name: string) { this.name = name; }
	run(input: string): string { return this.track(boost(input)); }
	track(x: string): string {
		return x + "!";
	}
}
export function start(): string { return new Engine("ge").run("hi"); }
`);
mkfile("src/util.ts", `export function helper(s: string): string { return s.toUpperCase(); }
export const helper2 = (s: string) => s.trim();
export function boost(s: string): string { return helper(s) + "x"; }
`);
mkfile("main.mjs", `import { start } from "./src/app.js";
export function go() { return start(); }
`);
mkfile("pytool.py", `import sys
def run_task(name):
    return "task:" + name
class TaskRunner:
    def execute(self, name):
        return run_task(name)
`);
execFileSync("git", ["add", "-A"], { cwd: root });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });

// ── build ──
const report = await engine.build(root);
await check("build: базовые счётчики", () => {
	assert(report.files === 4, `files=${report.files}`);
	assert(report.nodes > 10, `nodes=${report.nodes}`);
	assert(report.edges >= 5, `edges=${report.edges}`);
});

const g = JSON.parse(readFileSync(join(root, "graft", ".engine", "graph.json"), "utf8"));
const node = (id) => g.nodes.find((n) => n.id === id);
const edge = (s, t, r = "calls") => g.edges.find((e) => e.source === s && e.target === t && e.relation === r);

await check("nodes: классы/методы/функции/типы", () => {
	assert(node("src/app.ts#Engine")?.kind === "class", "Engine class");
	assert(node("src/app.ts#Engine.run")?.kind === "method", "Engine.run method");
	assert(node("src/app.ts#start")?.kind === "function" && node("src/app.ts#start").exported, "start exported");
	assert(node("src/util.ts#helper2"), "arrow-as-const helper2");
	assert(node("pytool.py#TaskRunner.execute")?.kind === "method", "py method");
	assert(!g.nodes.find((n) => n.id === "pytool.py#execute"), "нет дубля execute top-level");
});

await check("edges: импорты + references + calls", () => {
	assert(edge("src/app.ts", "src/util.ts", "imports"), "app→util imports");
	assert(edge("src/app.ts", "src/util.ts#boost", "references"), "app→boost reference");
	assert(edge("main.mjs", "src/app.ts", "imports"), "main→app imports");
	assert(edge("main.mjs", "src/app.ts#start", "references"), "main→start reference");

	assert(edge("pytool.py#TaskRunner.execute", "pytool.py#run_task"), "py method→run_task");
});

const q = engine.makeQueries(root);

await check("skeleton", () => {
	const out = q.skeleton("src/app.ts");
	assert(out.includes("class Engine") && out.includes("function start"), out);
	assert(out.includes("method Engine.run"), out);
});

await check("callers in/out/depth", () => {
	const d1 = q.callers("helper");
	assert(d1.includes("boost"), "boost в in: " + d1);
	assert(!d1.includes("src/app.ts"), "app.ts не прямой зависимый helper: " + d1);
	const out = q.callers("Engine.run", { direction: "out" });
	assert(out.includes("Engine.track"), "track в out: " + out);
	const d2 = q.callers("helper", { depth: 2 });
	assert(d2.includes("src/app.ts"), "depth2 через boost→app.ts: " + d2);
	const missing = q.callers("no_such_symbol_xyz");
	assert(missing.includes("не найден"), missing);
});

await check("map", () => {
	const out = q.map();
	assert(out.startsWith("repo map — 4 files"), out);
	assert(out.includes("hubs (in-degree):"), out);
	assert(out.includes("run_task"), out);
});

await check("ask", () => {
	const out = q.ask("helper");
	assert(out.includes("src/util.ts"), out);
	const none = q.ask("zzz_nothing_zzz");
	assert(none.includes("нет совпадений"), none);
});

await check("grep: хиты + innermost-символ", () => {
	const out = q.grep("helper");
	assert(out.includes("src/util.ts"), out);
	assert(out.includes("[in helper]"), "символ helper: " + out.slice(0, 300));
	const scoped = q.grep("helper", { scope: "src/" });
	assert(scoped.includes("src/util.ts"), scoped);
	const noHits = q.grep("zzz_nothing_zzz");
	assert(noHits.includes("нет хитов"), noHits);
});

await check("check: ок → дрейф после правки", async () => {
	const ok = await q.check();
	assert(ok.json.ok === true, ok.text);
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "\nexport const extra = 1;\n");
	const drifted = await q.check();
	assert(drifted.json.ok === false, drifted.text);
	assert(drifted.json.changed.includes("src/util.ts"), JSON.stringify(drifted.json));
});

await check("blast: затронутые строки → зависимые", async () => {
	const out = await q.blast();
	assert(out.startsWith("graft blast:"), out);
	// src/util.ts изменён (unstaged) → helper → app.ts-зависимые
	assert(out.includes("helper") || out.includes("src/util.ts"), out);
});

await check("store: findGraphRoot из подкаталога", () => {
	mkdirSync(join(root, "a", "b"), { recursive: true });
	assert(engine.findGraphRoot(join(root, "a", "b")) === root, "root найден");
	assert(engine.findGraphRoot(tmpdir()) === null, "вне — null");
});

await check("deep: явный конфиг обязателен", async () => {
	let threw = false;
	try {
		await engine.build(root, { deep: {} });
	} catch (e) {
		threw = true;
	}
	assert(threw, "ожидалась ошибка без baseUrl/model");
});

// ── deep с фейк-LLM ──
const llmCalls = [];
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		const prompt = JSON.parse(body).messages.map((m) => m.content).join("\n");
		llmCalls.push(prompt);
		const reply = prompt.includes("Опиши ОДНИМ предложением (≤40 слов)")
			? "Файл делает X."
			: JSON.stringify({ summary: "Символ делает Y.", crux: ["return x + \"!\";", "nope_line"] });
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const deepCfg = { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake" };
await check("deep: LLM-проход + кэш crux", async () => {
	const rep = await engine.build(root, { deep: deepCfg });
	assert(rep.deep, "deep отчёт");
	assert(rep.deep.filesDone > 0, `filesDone=${rep.deep?.filesDone}`);
	assert(rep.deep.symbolsDone > 0, `symbolsDone=${rep.deep?.symbolsDone}`);
	const deep = JSON.parse(readFileSync(join(root, "graft", ".engine", "deep.json"), "utf8"));
	assert(deep.files["src/util.ts"]?.summary === "Файл делает X.", "file summary");
	const engTrack = deep.symbols["src/app.ts#Engine.track"];
	assert(engTrack?.summary === "Символ делает Y.", "symbol summary");
	assert(engTrack?.crux?.length === 1 && engTrack.crux[0] === 'return x + "!";', `crux отфильтрован до реальных строк: ${JSON.stringify(engTrack?.crux)}`);
});

await check("deep: инкрементальность (кэш по bodyHash)", async () => {
	const rep = await engine.build(root, { deep: deepCfg });
	assert(rep.deep.filesDone === 0 && rep.deep.filesCached > 0, JSON.stringify(rep.deep));
	assert(rep.deep.symbolsDone === 0 && rep.deep.symbolsCached > 0, JSON.stringify(rep.deep));
});

await check("карточки и index.md", () => {
	const card = readFileSync(join(root, "graft", "cards", "src/util.ts.md"), "utf8");
	assert(card.includes("helper") && card.includes("Файл делает X."), card);
	const idx = readFileSync(join(root, "graft/index.md"), "utf8");
	assert(idx.includes("repo map"), idx);
});

server.close();
rmSync(root, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
