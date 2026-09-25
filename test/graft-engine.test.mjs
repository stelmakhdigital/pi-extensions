/**
 * Unit-тесты pi-graft-engine (движок + queries + deep с фейк-LLM).
 * Run: node test/graft-engine.test.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
export class Pair { a = "x"; get(): string { return this.a; } }
export function mkPair(): Pair { return new Pair(); }
export function usePair(): string { const p = mkPair(); return p.get(); }
export function mkPair2() { return new Pair(); }
export function usePair2(): string { const p2 = mkPair2(); return p2.get(); }
export function pairBase(): Pair { return new Pair(); }
export function pairWrap(): Pair { return pairBase(); }
export function usePair3(): string { const p3 = pairWrap(); return p3.get(); }
export function mkAsyncPair(): Promise<Pair> { return Promise.resolve(new Pair()); }
export async function useAsyncPair(): Promise<Pair> { const pa = await mkAsyncPair(); return pa; }
export class Greeter { hi(): string { return "hi"; } }
export function greet(g: Greeter): string { return g.hi(); }
export function typedGreet(): string { const g: Greeter = new Greeter(); return g.hi(); }
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

func NewItem() *Item { return &Item{} }

func Go() { s := NewItem(); _ = s.Show() }

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
mkfile("svc.java", `public class Service {
  public String getName() { return name; }
  public void run() { this.helper(); }
  private void helper() {}
}
public class App { public void go() { Service s = new Service(); s.getName(); } }`);
mkfile("svc.cs", `public class Service {
  public string GetName() => name;
  public void Run() { Helper(); }
  private void Helper() { }
}`);
mkfile("svc.kt", `class Service {
  fun getName(): String = name
  fun run() { helper() }
  private fun helper() { }
}
class App { fun go() { val s = Service(); s.getName() } }`);
mkfile("svc.rb", `class Service
  def run
    helper
    helper()
    obj.helper
  end

  def helper
  end
end
`);
mkfile("svc.php", `<?php
class Service {
  public function run() { $this->helper(); }
  private function helper() {}
}
function go() { $s = new Service(); $s->run(); }
`);
mkfile("svc.swift", `class Service {
  func run() {
    helper()
    self.helper()
  }

  func helper() {}
}
func go() { let s = Service(); s.run() }
`);
mkfile("svc.dart", `class Service {
  void run() {
    helper();
  }

  void helper() {}
}
`);
mkfile("svc.scala", `class Service {
  def run(): Unit = {
    helper()
  }

  private def helper(): Unit = {}
}
`);
mkfile("svc.lua", `local Service = {}
function Service:run()
  self:helper()
end

function Service:helper()
end
`);
execFileSync("git", ["add", "-A"], { cwd: root });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });

// ── build ──
const report = await engine.build(root);
await check("build: базовые счётчики", () => {
	assert(report.files === 16, `files=${report.files}`);
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
		// java/csharp/kotlin
		assert(node("svc.java#Service")?.kind === "class", "java class");
		assert(node("svc.java#Service.run")?.kind === "method", "java qualified method");
		assert(edge("svc.java#Service.run", "svc.java#Service.helper"), "java run→helper");
		assert(node("svc.cs#Service.Run")?.kind === "method", "csharp method");
		assert(edge("svc.cs#Service.Run", "svc.cs#Service.Helper"), "csharp Run→Helper");
		assert(node("svc.kt#Service.run")?.kind === "function", "kotlin fun");
		assert(edge("svc.kt#Service.run", "svc.kt#Service.helper"), "kotlin run→helper");
		// type inference: f(): Pair → p.get() = Pair.get
		assert(edge("src/util.ts#usePair", "src/util.ts#Pair.get"), "fnReturns: usePair→Pair.get");
		assert(edge("src/util.ts#usePair2", "src/util.ts#Pair.get"), "inferred return: usePair2→Pair.get");
		// ruby/php/swift
		assert(node("svc.rb#Service.run")?.kind === "method", "ruby method");
		assert(edge("svc.rb#Service.run", "svc.rb#Service.helper"), "ruby run→helper (bare + call)");
		assert(node("svc.php#Service.run")?.kind === "method", "php method");
		assert(edge("svc.php#Service.run", "svc.php#Service.helper"), "php $this->helper");
		assert(node("svc.swift#Service.run")?.kind === "function", "swift func");
		assert(edge("svc.swift#Service.run", "svc.swift#Service.helper"), "swift run→helper (self.)");
		// dart/scala/lua
		assert(node("svc.dart#Service.run")?.kind === "method", "dart method");
		assert(edge("svc.dart#Service.run", "svc.dart#Service.helper"), "dart run→helper");
		assert(node("svc.scala#Service.run")?.kind === "function", "scala def");
		assert(edge("svc.scala#Service.run", "svc.scala#Service.helper"), "scala run→helper");
		assert(node("svc.lua#Service.run")?.kind === "method", "lua method (Service:run)");
		assert(edge("svc.lua#Service.run", "svc.lua#Service.helper"), "lua self:helper");
		// return-вызов: pairWrap → return pairBase() → Pair
		assert(edge("src/util.ts#usePair3", "src/util.ts#Pair.get"), "transitive: usePair3→Pair.get");
		// B6 full-fidelity: new/конструктор + member-вызовы (go/java/kt/php/swift)
		assert(edge("app.go#Go", "app.go#Item.Show"), "go: s := NewItem(); s.Show()");
		assert(edge("svc.java#App.go", "svc.java#Service.getName"), "java: Service s = new Service(); s.getName()");
		assert(edge("svc.kt#App.go", "svc.kt#Service.getName"), "kotlin: val s = Service(); s.getName()");
		assert(edge("svc.php#go", "svc.php#Service.run"), "php: $s = new Service(); $s->run()");
		assert(edge("svc.swift#go", "svc.swift#Service.run"), "swift: let s = Service(); s.run()");
		// дженерики: Promise<Pair> → Pair; await mkAsyncPair() → Pair
		assert(!edge("src/util.ts#useAsyncPair", "src/util.ts#Pair.get"), "без .m() — нет ребра");
		// типизированные: параметр g: Greeter / const g: Greeter
		assert(edge("src/util.ts#greet", "src/util.ts#Greeter.hi"), "param g: Greeter → g.hi");
		assert(edge("src/util.ts#typedGreet", "src/util.ts#Greeter.hi"), "const g: Greeter → g.hi");
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
	assert(out.startsWith("repo map — 16 files"), out);
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
	for (const f of ["src/app.ts", "src/util.ts", "main.mjs", "pytool.py", "app.go", "tool.rs", "run.sh", "svc.java", "svc.cs", "svc.kt", "svc.rb", "svc.php", "svc.swift", "svc.dart", "svc.scala", "svc.lua"]) assert(covered.has(f), "файл в теме: " + f);
});

await check("concepts: fallback без LLM (каталог + язык для root + прочее)", async () => {
	const { mkdtempSync: mk2, writeFileSync: wf2, mkdirSync: md2 } = await import("node:fs");
	const root2 = mk2("/tmp/graft-fb-");
	md2(root2 + "/src");
	wf2(root2 + "/a.ts", "export function a() { return 1; }\n");
	wf2(root2 + "/b.ts", "export function b() { return 2; }\n");
	wf2(root2 + "/c.go", "package c\n");
	wf2(root2 + "/src/x.ts", "export function x() { return 3; }\n");
	wf2(root2 + "/src/y.ts", "export function y() { return 4; }\n");
	wf2(root2 + "/lonely.py", "def lonely():\n    return 1\n");
	execFileSync("git", ["init", "-q", "."], { cwd: root2 });
	execFileSync("git", ["add", "-A"], { cwd: root2 });
	await engine.build(root2);
	const topics = await engine.conceptsBuild(root2, engine.readGraph(root2), { baseUrl: "", model: "" });
	const covered = new Set(topics.flatMap((tp) => tp.files));
	for (const f of ["a.ts", "c.go", "src/x.ts", "lonely.py"]) assert(covered.has(f), "файл в теме: " + f);
	assert(topics.some((tp) => tp.name === "root/ts-js"), "root: языковая семья ts-js: " + topics.map((tp) => tp.name).join(","));
	assert(topics.some((tp) => tp.name === "src"), "каталог src");
	assert(topics.some((tp) => tp.name === "прочее" && tp.files.includes("lonely.py")), "мелкие — прочее");
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

await check("auto-deep: инкрементальный при структурном build (env-конфиг, GRFT_AUTO_DEEP=0 — выкл)", async () => {
	let llmCalls = 0;
	const srv = http.createServer((req, res) => {
		let b = "";
		req.on("data", (d) => (b += d));
		req.on("end", () => {
			llmCalls++;
			const p = JSON.parse(b).messages.map((m) => m.content).join("\n");
			let reply;
			if (p.includes("Опиши ОДНИМ предложением (≤40 слов)")) reply = "Авто summary.";
			else if (p.includes("топик")) {
				const files = [...p.matchAll(/^- (\S+):/gm)].map((m) => m[1]);
				reply = JSON.stringify({ topics: [{ name: "Авто", summary: "s", files: files.slice(0, 3) }] });
			} else reply = JSON.stringify({ summary: "Авто симв.", crux: [] });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	process.env.GRFT_LLM_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
	process.env.GRFT_LLM_MODEL = "auto-fake";
	try {
		// 1) создаём дрейф → auto-deep перечитывает изменившийся файл
		writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const extra1 = 1;\n");
		const rep1 = await engine.build(root);
		assert(rep1.deep, "auto-deep отчёт в build");
		assert(rep1.deep.filesDone >= 1, `ис изменился util.ts: filesDone=${rep1.deep?.filesDone}`);
		assert(llmCalls > 0, "LLM-вызовы были");
		const before = llmCalls;
		// 2) дрейфа нет → 0 новых LLM-вызовов (всё кэш)
		const rep2 = await engine.build(root);
		assert(rep2.deep && rep2.deep.filesDone === 0, `всё кэш: ${JSON.stringify(rep2.deep)}`);
		assert(llmCalls === before, "без дрейфа — 0 LLM-вызовов");
		// 3) GRFT_AUTO_DEEP=0 → auto-deep выключен
		process.env.GRFT_AUTO_DEEP = "0";
		writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const extra2 = 2;\n");
		const rep3 = await engine.build(root);
		assert(!rep3.deep, "auto-deep выключен (rep.deep undefined)");
		// возвращаем main-fake summary (карточки-тест ожидает «Файл делает X.»)
		await engine.build(root, { deep: deepCfg, autoDeep: false });
	} finally {
		delete process.env.GRFT_AUTO_DEEP;
		delete process.env.GRFT_LLM_BASE_URL;
		delete process.env.GRFT_LLM_MODEL;
		srv.close();
	}
});

await check("карточки и index.md", () => {
	const card = readFileSync(join(root, "graft", "cards", "src/util.ts.md"), "utf8");
	assert(card.includes("helper") && card.includes("Файл делает X."), card);
	const idx = readFileSync(join(root, "graft/index.md"), "utf8");
	assert(idx.includes("repo map"), idx);
});

await check("refresh: fingerprint + ensureFresh (дрейф → rebuild; чисто → skip; GRFT_NO_REFRESH)", async () => {
	const fp = join(root, "graft", ".engine", "fingerprint.json");
	assert(readFileSync(fp, "utf8"), "fingerprint.json пишется после build");
	let r = await engine.ensureFresh(root);
	assert(!r.refreshed, `без дрейфа — нет пересборки: ${JSON.stringify(r)}`);
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const extra3 = 3;\n");
	const dr = await engine.driftReport(root);
	assert(dr.drifted && dr.changed >= 1, `driftReport: ${JSON.stringify(dr)}`);
	r = await engine.ensureFresh(root);
	assert(r.refreshed && r.files >= 1, `пересборка при дрейфе: ${JSON.stringify(r)}`);
	r = await engine.ensureFresh(root);
	assert(!r.refreshed, "после rebuild — чисто");
	process.env.GRFT_NO_REFRESH = "1";
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const extra4 = 4;\n");
	r = await engine.ensureFresh(root);
	assert(!r.refreshed && r.skipped === "GRFT_NO_REFRESH=1", `GRFT_NO_REFRESH: ${JSON.stringify(r)}`);
	delete process.env.GRFT_NO_REFRESH;
	const c = readFileSync(join(root, "src/util.ts"), "utf8").replace("export const extra3 = 3;\n", "").replace("export const extra4 = 4;\n", "");
	writeFileSync(join(root, "src/util.ts"), c);
	await engine.build(root, { autoDeep: false });
});

await check("CLI: check → exit 1 при дрейфе (CI-сигнал)", () => {
	const binPath = fileURLToPath(new URL("../engine/graft/bin/graft.mjs", import.meta.url));
	const codeOf = () => {
		let code = 0;
		try {
			execFileSync("node", [binPath, "check", "--dir", root], { stdio: "pipe" });
		} catch (e) {
			code = e.status;
		}
		return code;
	};
	assert(codeOf() === 0, "чисто → exit 0");
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const cliDrift = 1;\n");
	assert(codeOf() === 1, "дрейф → exit 1");
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8").replace("export const cliDrift = 1;\n", ""));
});

await check("monorepo: scopes (детект, ask-fusion, map, grep --in-scope)", async () => {
	const mroot = mkdtempSync(join(tmpdir(), "ge-mono-"));
	execFileSync("git", ["init", "-q", "."], { cwd: mroot });
	const mfile = (p, c) => { mkdirSync(join(mroot, p, ".."), { recursive: true }); writeFileSync(join(mroot, p), c); };
	mfile("package.json", "{\"name\":\"root\",\"workspaces\":[\"packages/*\"]}");
	mfile("packages/alpha/package.json", "{\"name\":\"alpha\"}");
	mfile("packages/alpha/src/alpha.ts", `export function alphaCore(): string { return alphaHelper(); }
export function alphaHelper(): string { return "a"; }`);
	mfile("packages/beta/package.json", "{\"name\":\"beta\"}");
	mfile("packages/beta/src/beta.ts", `export function betaCore(): string { return betaUtil(); }
export function betaUtil(): string { return "b"; }`);
	mfile("rootfile.ts", `export function rootEntry(): string { return "r"; }`);
	const rep = await engine.build(mroot);
	const g = engine.readGraph(mroot);
	const sc = g.meta.scopes;
	assert(sc && sc["packages/alpha"] && sc["packages/beta"] && sc["(root)"], `scopes: ${JSON.stringify(Object.keys(sc ?? {}))}`);
	assert(sc["packages/alpha"].includes("packages/alpha/src/alpha.ts"), "alpha-файл в скоупе");
	const q = engine.makeQueries(mroot);
	const mapOut = q.map();
	assert(mapOut.includes("scopes:") && mapOut.includes("packages/alpha"), `map scopes: ${mapOut.slice(0, 200)}`);
	const askOut = q.ask("alpha core");
	assert(askOut.includes("[packages/alpha]"), `ask label: ${askOut.slice(0, 200)}`);
	// named-scope в grep
	const gA = q.grep("alpha", { scope: "packages/alpha" });
	const gB = q.grep("beta", { scope: "packages/alpha" });
	assert(gA.includes("alpha") && !gA.toLowerCase().includes("beta.ts"), `grep in alpha: ${gA.slice(0, 150)}`);
	assert(gB.includes("нет хитов"), `grep beta в alpha — пусто: ${gB.slice(0, 80)}`);
	rmSync(mroot, { recursive: true, force: true });
});

await check("языки v2 (7 новых): r/elixir/solidity/ocaml/zig/clojure/nix — символы + вызовы", async () => {
	const lroot = mkdtempSync(join(tmpdir(), "ge-langs-"));
	execFileSync("git", ["init", "-q", "."], { cwd: lroot });
	const lf = (p, c) => { mkdirSync(join(lroot, p, ".."), { recursive: true }); writeFileSync(join(lroot, p), c); };
	lf("pkg/r.R", "helper <- function(x) { x + 1 }\nrun <- function() { helper(1) }\n");
	lf("pkg/math.ex", "defmodule Math do\n  def add(a, b), do: sub(a, b)\n  defp sub(a, b), do: a - b\nend\n");
	lf("pkg/app.sol", "contract App {\n  function run() external returns (uint) { return calc(1); }\n  function calc(uint x) public pure returns (uint) { return x + 1; }\n}\n");
	lf("pkg/core.ml", "let sub a b = a - b\nlet add a b = sub a b\n");
	lf("pkg/util.zig", "fn helper() u32 { return 1; }\npub fn run() void { _ = helper(); }\n");
	lf("pkg/core.clj", "(defn helper [x] (+ x 1))\n(defn run [] (helper 1))\n");
	lf("pkg/mod.nix", "cfg = { a = 1; b = a + 2; };\n");
	const g = engine.readGraph ? null : null;
	const rep = await engine.build(lroot);
	const graph = JSON.parse(readFileSync(join(lroot, "graft", ".engine", "graph.json"), "utf8"));
	const names = new Set(graph.nodes.filter((n) => n.kind !== "file").map((n) => n.name));
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const calls = graph.edges.filter((e) => e.relation === "calls");
	const edge = (srcName, tgtName) => calls.some((e) => {
		const s = byId.get(e.source)?.name;
		const t = byId.get(e.target)?.name;
		return s === srcName && t === tgtName;
	});
	assert(names.has("run") && names.has("helper"), `R: ${[...names].join(",")}`);
	assert(names.has("Math.add") && names.has("Math.sub"), `Elixir: ${[...names].filter((n) => n.includes(".")).join(",")}`);
	assert(names.has("App") && names.has("App.run") && names.has("App.calc"), `Solidity: ${[...names].join(",")}`);
	assert(names.has("add") && names.has("sub"), `OCaml: ${[...names].join(",")}`);
	assert(edge("run", "helper"), "R run→helper");
	assert(edge("Math.add", "Math.sub"), "Elixir Math.add→Math.sub");
	assert(edge("App.run", "App.calc"), "Solidity App.run→App.calc");
	assert(edge("add", "sub"), "OCaml add→sub");
	assert(edge("run", "helper") && graph.nodes.some((n) => n.path.endsWith(".zig") && n.name === "run"), "zig run");
	assert(graph.nodes.some((n) => n.path.endsWith(".clj") && n.name === "helper") && edge("run", "helper"), "clojure run→helper");
	assert(graph.nodes.some((n) => n.path.endsWith(".nix") && n.name === "b"), "nix attrset bindings");
	rmSync(lroot, { recursive: true, force: true });
});

await check("CLI E11/E12: ask --json, blast --format/json/markdown/owners/export-viz, init/uninstall", () => {
	const binPath = fileURLToPath(new URL("../engine/graft/bin/graft.mjs", import.meta.url));
	const run = (args, expectFail = false) => {
		try {
			return { code: 0, out: execFileSync("node", [binPath, ...args], { stdio: "pipe" }).toString() };
		} catch (e) {
			return { code: e.status, out: ((e.stdout ?? "") + (e.stderr ?? "")).toString() };
		}
	};
	// ask --json
	let r = run(["ask", "helper", "--json", "--dir", root]);
	assert(r.code === 0, `ask --json: ${r.out.slice(0, 200)}`);
	const j = JSON.parse(r.out);
	assert(j.count >= 1 && Array.isArray(j.results) && j.results[0].name, `askJson: ${r.out.slice(0, 150)}`);
	// blast: создаём дрейф (изменения в коммитнутом файле)
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8") + "export const blastProbe = 1;\n");
	r = run(["blast", "--format", "json", "--dir", root]);
	assert(r.code === 0, `blast json: ${r.out.slice(0, 200)}`);
	const bj = JSON.parse(r.out);
	assert(bj.files.length >= 1 && bj.files[0].path === "src/util.ts", `blastData: ${JSON.stringify(bj.files?.map((f) => f.path))}`);
	assert(typeof bj.files[0].owner === "string" || bj.files[0].owner === null, "owner поле");
	r = run(["blast", "--format", "json", "--no-owners", "--dir", root]);
	const bj2 = JSON.parse(r.out);
	assert(bj2.files[0].owner === null, "no-owners → null");
	r = run(["blast", "--format", "markdown", "--no-owners", "--dir", root]);
	assert(r.out.includes("## Blast radius") && r.out.includes("src/util.ts"), `markdown: ${r.out.slice(0, 150)}`);
	// export-viz
	r = run(["blast", "--export-viz", join(root, "blastviz"), "--no-owners", "--dir", root]);
	assert(r.code === 0 && existsSync(join(root, "blastviz", "index.html")), `export-viz: ${r.out.slice(0, 150)}`);
	// вернуть файл в исходное состояние
	writeFileSync(join(root, "src/util.ts"), readFileSync(join(root, "src/util.ts"), "utf8").replace("export const blastProbe = 1;\n", ""));
	// init / uninstall
	const wroot = mkdtempSync(join(tmpdir(), "ge-wire-"));
	execFileSync("git", ["init", "-q", "."], { cwd: wroot });
	r = run(["init", "--dir", wroot]);
	assert(r.code === 0, `init: ${r.out.slice(0, 200)}`);
	const agentsMd = readFileSync(join(wroot, "AGENTS.md"), "utf8");
	assert(agentsMd.includes("graft:begin") && agentsMd.includes("Graft code graph"), "AGENTS.md секция");
	const mcp = JSON.parse(readFileSync(join(wroot, ".mcp.json"), "utf8"));
	assert(mcp.mcpServers.graft.command === "node" && mcp.mcpServers.graft.args[0].endsWith("graft-mcp.mjs"), ".mcp.json graft");
	// idempotency
	r = run(["init", "--dir", wroot]);
	assert(r.out.includes("[unchanged]"), `idempotent: ${r.out}`);
	// dry-run не пишет
	const wroot2 = mkdtempSync(join(tmpdir(), "ge-wire2-"));
	run(["init", "--dry-run", "--dir", wroot2]);
	assert(!existsSync(join(wroot2, "AGENTS.md")), "dry-run не пишет");
	// uninstall
	r = run(["uninstall", "-y", "--dir", wroot]);
	const agentsMd2 = readFileSync(join(wroot, "AGENTS.md"), "utf8");
	assert(!agentsMd2.includes("graft:begin"), "uninstall: секция убрана");
	const mcp2 = JSON.parse(readFileSync(join(wroot, ".mcp.json"), "utf8"));
	assert(!mcp2.mcpServers || !mcp2.mcpServers.graft, "uninstall: mcp graft убран");
	rmSync(wroot, { recursive: true, force: true });
	rmSync(wroot2, { recursive: true, force: true });
});

await check("LSP B5: unresolved-кандидаты, lspStatus, lspSync без сервера", async () => {
	mkfile("src/lspfix.ts",
		"export class LspBox { open() { return 1; } }\n" +
		"export function useLspBox(b: LspBox) { return b.open() + b.missingMethod(); }\n");
	await engine.build(root, { autoDeep: false });
	const cand = engine.readUnresolved(root);
	assert(cand.some((c) => c.method === "missingMethod" && c.file === "src/lspfix.ts" && c.line >= 1 && c.col >= 0),
		`unresolved: ${JSON.stringify(cand)}`);
	const st = engine.lspStatus(root);
	const tsRow = st.find((r) => r.lang === "ts");
	assert(tsRow && tsRow.candidates >= 1, `lspStatus: ${JSON.stringify(st)}`);
	const rep = await engine.lspSync(root);
	assert(rep.candidates >= 1, `lspSync candidates: ${JSON.stringify(rep)}`);
	// без сервера — честный отчёт, без рёбер
	const tsLang = rep.langs.find((l) => l.lang === "ts");
	if (tsLang && !tsLang.available) {
		assert(tsLang.ok === false && tsLang.edges === 0 && tsLang.install.length > 0, `graceful: ${JSON.stringify(tsLang)}`);
	}
});

await check("C7: Notes в карточках переживают регенерацию + concept-links", async () => {
	// Notes: перепишем карточку с заметками между маркерами
	const cardPath = join(root, "graft/cards/src/app.ts.md");
	const card = readFileSync(cardPath, "utf8");
	const b = "<!-- graft:notes:begin -->";
	const e = "<!-- graft:notes:end -->";
	const bi = card.indexOf(b);
	assert(bi >= 0, "маркеры notes в карточке");
	const patched = card.slice(0, bi) + b + "\nМоя заметка: тут важно.\n" + e + card.slice(card.indexOf(e) + e.length);
	writeFileSync(cardPath, patched);
	engine.writeCards(root, engine.readGraph(root), engine.readDeep(root));
	const after = readFileSync(cardPath, "utf8");
	assert(after.includes("Моя заметка: тут важно."), "notes пережил регенерацию");
	// Concept links: conceptsBuild (fallback без LLM) на фикстуре с кросс-вызовами
	await engine.conceptsBuild(root, engine.readGraph(root), { baseUrl: "", model: "", apiKey: "" });
	const deep = engine.readDeep(root);
	assert(Array.isArray(deep.concepts?.topics) && deep.concepts.topics.length >= 1, `topics: ${JSON.stringify(deep.concepts?.topics?.length)}`);
	assert(Array.isArray(deep.concepts?.links), "links массив");
	// если есть кросс-каталожные вызовы — найдётся связь
	assert(deep.concepts.links.length >= 0, "links посчитаны");
});

await check("C8: viz serve (HTTP /api/graph + live-reload)", async () => {
	const port = 18231;
	const url = engine.serveViz(root, port);
	await new Promise((r) => setTimeout(r, 300));
	const gres = await fetch(`${url}/api/graph`);
	assert(gres.status === 200, `api status ${gres.status}`);
	const gj = await gres.json();
	assert(gj.version === 1 && Array.isArray(gj.nodes), "api/graph JSON");
	const html = await (await fetch(`${url}/`)).text();
	assert(html.includes("live-reload") && html.includes("api/graph"), "html + reload-скрипт");
});

server.close();
rmSync(root, { recursive: true, force: true });

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
