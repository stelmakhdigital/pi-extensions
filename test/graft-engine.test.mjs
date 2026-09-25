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
export interface Task { id: string; done: boolean; }
`);
mkfile("main.mjs", `import { start, Engine } from "./src/app.js";
export function go() { return start(); }
export function useEngine() { const e = new Engine("x"); return e.track("a"); }
`);
mkfile("pytool.py", `import sys
def run_task(name):
    return "task:" + name
class TaskRunner:
    def execute(self, name):
        return run_task(name)
`);
mkfile("app.go", `package app

type Item struct{ Name string }

func Helper() int { return 1 }

func (i *Item) Show() string { return i.Name }

func Run() int { return Helper() }
`);
mkfile("tool.rs", `pub struct Widget { v: i32 }
impl Widget {
    fn value(&self) -> i32 { self.v }
}
fn add(a: i32, b: i32) -> i32 { a + b }
fn make() -> i32 { add(1, 2) }
`);
mkfile("run.sh", `#!/usr/bin/env bash
greet() { echo hi; }
main() { greet; echo done; }
`);
execFileSync("git", ["add", "-A"], { cwd: root });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });

// ── build ──
const report = await engine.build(root);
await check("build: базовые счётчики", () => {
	assert(report.files === 7, `files=${report.files}`);
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
		// member-chain: new X().m() и cross-file const e = new Imported()
	assert(edge("src/app.ts#start", "src/app.ts#Engine.run"), "start→Engine.run (new().m)");
	assert(edge("main.mjs#useEngine", "src/app.ts#Engine.track"), "useEngine→Engine.track (cross-file)");
		// другие языки
	assert(node("app.go#Helper")?.kind === "function", "go func");
	assert(node("app.go#Item.Show")?.kind === "method", "go method");
	assert(edge("app.go#Item.Show", "app.go#Helper") || edge("app.go#Run", "app.go#Helper"), "go call Helper");
	assert(node("tool.rs#Widget")?.kind === "class", "rust struct");
	assert(node("tool.rs#add")?.kind === "function", "rust fn");
	assert(edge("tool.rs#make", "tool.rs#add"), "rust make→add");
	assert(node("run.sh#greet")?.kind === "function", "sh function");
	assert(edge("run.sh#main", "run.sh#greet"), "sh main→greet");
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
	assert(out.startsWith("repo map — 7 files"), out);
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
		let reply;
		if (prompt.includes("Опиши ОДНИМ предложением (≤40 слов)")) reply = "Файл делает X.";
		else if (prompt.includes("топик")) {
			const files = [...prompt.matchAll(/^- (\S+):/gm)].map((x) => x[1]);
			reply = JSON.stringify({ topics: [{ name: "Ядро", summary: "Одна тема для всего.", files: [files[0]] }] });
		} else reply = JSON.stringify({ summary: "Символ делает Y.", crux: ["return x + \"!\";", "nope_line"] });
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
	assert(deep.symbols["src/util.ts#Task"], "тип (interface) в deep");
});

await check("concepts: LLM-темы + полное покрытие файлов", () => {
	const deep = JSON.parse(readFileSync(join(root, "graft", ".engine", "deep.json"), "utf8"));
	assert(deep.concepts?.topics?.length, "темы есть");
	const covered = new Set(deep.concepts.topics.flatMap((tp) => tp.files));
	for (const f of ["src/app.ts", "src/util.ts", "main.mjs", "pytool.py", "app.go", "tool.rs", "run.sh"]) assert(covered.has(f), "файл в теме: " + f);
});

await check("ask/map: deep-вывод (summary, crux, темы, file-summaries)", () => {
	const q2 = engine.makeQueries(root);
	const askOut = q2.ask("track");
	assert(askOut.includes("↳ Символ делает Y."), "summary в ask: " + askOut.slice(0, 300));
	assert(askOut.includes('crux: return x + "!";'), "crux в ask");
	const mapOut = q2.map({ deep: true });
	assert(mapOut.includes("topics:"), "темы в map: " + mapOut.slice(0, 400));
	assert(mapOut.includes("file summaries (deep):"), "file summaries в map");
	const mapPlain = q2.map();
	assert(!mapPlain.includes("file summaries"), "обычный map без deep (токен-бюджет)");
});

await check("viz: graft/viz.html генерируется", () => {
	const out = engine.writeViz(root, engine.readGraph(root));
	const html = readFileSync(out, "utf8");
	assert(html.includes("<svg") && html.includes("graft viz"), "svg + заголовок");
	assert(html.includes("src/app.ts"), "файлы в данных");
});

await check("mcp: stdio JSON-RPC roundtrip", async () => {
	const { spawn } = await import("node:child_process");
	const bin = new URL("../engine/graft/bin/graft-mcp.mjs", import.meta.url).pathname;
	const p = spawn(process.execPath, [bin], { env: { ...process.env, GRFT_MCP_ROOT: root } });
	let buf = "";
	const lines = [];
	p.stdout.on("data", (d) => {
		buf += d.toString();
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			lines.push(buf.slice(0, i).trim());
			buf = buf.slice(i + 1);
		}
	});
	const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
	send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
	send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graft_map", arguments: {} } });
	await new Promise((r) => {
		const iv = setInterval(() => {
			if (lines.length >= 3) {
				clearInterval(iv);
				r();
			}
		}, 50);
		setTimeout(() => {
			clearInterval(iv);
			r();
		}, 5000);
	});
	const [init, list, call] = lines.map((l) => JSON.parse(l));
	assert(init.result.serverInfo?.name?.includes("graft"), "initialize");
	assert(list.result.tools.length === 7, "tools/list");
	assert(call.result.content[0].text.includes("repo map"), "tools/call map");
	p.kill();
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
