/**
 * Unit tests for the subagents extension.
 * Run: node test/subagents.test.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(fileURLToPath(import.meta.url));
const { DEFAULT_CONFIG, loadConfig, persistHandoffPreference } = jiti("../extensions/subagents/config.ts");
const agents = jiti("../extensions/subagents/agents.ts");
const session = jiti("../extensions/subagents/session.ts");
const { createTmuxBackend } = jiti("../extensions/subagents/tmux-backend.ts");
const ext = jiti("../extensions/subagents/index.ts");
const { buildLaunchScript, classifyPhase, waitForShellReady, renderDoctorReport } = ext;

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
	if (!cond) throw new Error(msg);
}

const tmp = mkdtempSync(join(tmpdir(), "subagents-test-"));
const emptyEnv = {};

// ── config ──

await check("config: defaults", () => {
	assert(DEFAULT_CONFIG.tmux.handoff === "ask", "handoff default");
	assert(DEFAULT_CONFIG.limits.maxConcurrent === 6, "maxConcurrent");
	assert(DEFAULT_CONFIG.child.extensions === "none", "child.extensions default");
});

await check("config: global < project < env, untrusted project игнорируется", () => {
	const globalFile = join(tmp, "global.json");
	const projectFile = join(tmp, "project.json");
	writeFileSync(globalFile, JSON.stringify({ tmux: { handoff: "auto" }, limits: { maxConcurrent: 2 } }));
	writeFileSync(projectFile, JSON.stringify({ tmux: { handoff: "never" } }));

	let c = loadConfig({ cwd: tmp, projectTrusted: false, env: emptyEnv, globalFile, projectFile });
	assert(c.tmux.handoff === "auto", "project (untrusted) не должен переопределять global: " + c.tmux.handoff);

	c = loadConfig({ cwd: tmp, projectTrusted: true, env: emptyEnv, globalFile, projectFile });
	assert(c.tmux.handoff === "never", "project должен переопределить global: " + c.tmux.handoff);
	assert(c.limits.maxConcurrent === 2, "merge секций (global maxConcurrent)");

	c = loadConfig({ cwd: tmp, projectTrusted: true, env: { ...emptyEnv, PI_SUBAGENTS_HANDOFF: "never" }, globalFile, projectFile });
	assert(c.tmux.handoff === "never", "env переопределяет файлы");

	c = loadConfig({ cwd: tmp, env: { ...emptyEnv, PI_SUBAGENTS_MAX_CONCURRENT: "9" }, globalFile, projectFile });
	assert(c.limits.maxConcurrent === 9, "env maxConcurrent");
});

await check("config: битый JSON не роняет", () => {
	const bad = join(tmp, "bad.json");
	writeFileSync(bad, "{oops");
	const c = loadConfig({ cwd: tmp, env: emptyEnv, globalFile: bad });
	assert(c.tmux.handoff === "ask", "fallback на defaults");
});

await check("config: persistHandoffPreference пишет tmux.handoff и сохраняет остальные ключи", () => {
	const file = join(tmp, "persist.json");
	writeFileSync(file, JSON.stringify({ tmux: { sessionName: "pi" }, widget: { enabled: false } }));
	assert(persistHandoffPreference("never", file), "write ok");
	const data = JSON.parse(readFileSync(file, "utf8"));
	assert(data.tmux.handoff === "never", "handoff записан");
	assert(data.tmux.sessionName === "pi", "остальные ключи сохранены");
	assert(data.widget.enabled === false, "другие секции сохранены");
});

// ── agents ──

const AGENT_MD = `---
name: scout
description: Fast codebase recon
model: anthropic/claude-haiku
thinking: minimal
tools: read, bash
session-mode: lineage-only
auto-exit: true
---

You are a scout. Map things quickly.
`;

await check("agents: parseFrontmatter + parseAgentDefinition", () => {
	const def = agents.parseAgentDefinition(AGENT_MD, "fallback", "project", "/x/scout.md");
	assert(def.name === "scout", "name");
	assert(def.model === "anthropic/claude-haiku", "model");
	assert(def.sessionMode === "lineage", "session-mode lineage-only -> lineage");
	assert(def.autoExit === true, "auto-exit");
	assert(def.interactive === false, "interactive = !autoExit по умолчанию");
	assert(def.body.includes("You are a scout"), "body сохранён");
});

await check("agents: interactive переопределяется явно", () => {
	const def = agents.parseAgentDefinition(
		"---\nname: planner\nauto-exit: false\ninteractive: false\n---\nbody\n",
		"p",
		"project",
		"/x",
	);
	assert(def.interactive === false, "явное interactive: false");
});

await check("agents: discovery project > global", () => {
	const projectDir = join(tmp, "agents-project");
	const globalDir = join(tmp, "agents-global");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(globalDir, { recursive: true });
	writeFileSync(join(globalDir, "scout.md"), "---\nname: scout\ndescription: global\n---\nglobal body\n");
	writeFileSync(join(projectDir, "scout.md"), AGENT_MD);
	writeFileSync(join(projectDir, "worker.md"), "---\nname: worker\n---\nworker body\n");
	const defs = agents.discoverAgents(tmp, { projectDir, globalDir });
	const scout = defs.find((d) => d.name === "scout");
	assert(scout.source === "project", "project теньюет global: " + scout.source);
	assert(defs.find((d) => d.name === "worker"), "worker есть");
	assert(agents.resolveAgent(tmp, "scout", { projectDir, globalDir })?.body.includes("scout"), "resolveAgent");
	assert(agents.resolveAgent(tmp, "nope", { projectDir, globalDir }) === undefined, "unknown -> undefined");
});

await check("agents: buildChildToolAllowlist добавляет child-инструменты", () => {
	const def = agents.parseAgentDefinition(AGENT_MD, "s", "project", "/x");
	const list = agents.buildChildToolAllowlist(def);
	assert(list.includes("read") && list.includes("bash"), "allowlist из frontmatter");
	assert(list.includes("agent_done") && list.includes("agent_ping"), "child-инструменты добавлены");
	assert(agents.buildChildToolAllowlist(undefined, "edit") === "edit,agent_done,agent_ping", "override");
	assert(agents.buildChildToolAllowlist(undefined, undefined) === undefined, "без списка -> undefined");
});

await check("agents: resolveSessionMode / resolveChildCwd", () => {
	const def = agents.parseAgentDefinition(AGENT_MD, "s", "project", "/x");
	assert(agents.resolveSessionMode(def) === "lineage", "default mode");
	assert(agents.resolveSessionMode(def, true) === "fork", "fork override");
	assert(agents.resolveSessionMode(undefined) === "standalone", "no def");
	const cwdDef = agents.parseAgentDefinition("---\nname: x\ncwd: subdir\n---\nb\n", "x", "project", "/x");
	assert(agents.resolveChildCwd(cwdDef, undefined, "/base") === "/base/subdir", "relative cwd");
	assert(agents.resolveChildCwd(cwdDef, "/other", "/base") === "/other", "override cwd");
});

// ── session ──

await check("session: sessionDirNameFor", () => {
	assert(session.sessionDirNameFor("/home/user/Code") === "--home-user-Code--", "encode: " + session.sessionDirNameFor("/home/user/Code"));
});

await check("session: standalone — только header", () => {
	const files = new Map();
	const s = session.createChildSession({
		mode: "standalone",
		sessionsRoot: "/sessions",
		cwd: "/proj",
		sessionId: "abc-123",
		now: new Date("2026-01-01T00:00:00.123Z"),
		writeFile: (f, d) => files.set(f, d),
	});
	assert(s.file.includes("--proj--"), "каталог cwd: " + s.file);
	assert(s.file.endsWith("_abc-123.jsonl"), "имя файла: " + s.file);
	const lines = files.get(s.file).trim().split("\n");
	assert(lines.length === 1, "одна строка");
	const header = JSON.parse(lines[0]);
	assert(header.type === "session" && header.version === 3 && header.id === "abc-123", "header");
	assert(!header.parentSession, "нет parentSession");
});

await check("session: lineage — parentSession в header", () => {
	const files = new Map();
	const s = session.createChildSession({
		mode: "lineage",
		sessionsRoot: "/sessions",
		cwd: "/proj",
		parentSessionFile: "/sessions/parent.jsonl",
		sessionId: "lin-1",
		now: new Date("2026-01-01T00:00:00.123Z"),
		writeFile: (f, d) => files.set(f, d),
	});
	const header = JSON.parse(files.get(s.file).trim().split("\n")[0]);
	assert(header.parentSession === "/sessions/parent.jsonl", "parentSession");
});

await check("session: fork — копирование ветви без старого header", () => {
	// Вызывающий (spawnAgentInternal) уже отфильтровал старый header.
	const branch = [
		{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } },
		{ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [] } },
	];	const files = new Map();
	const s = session.createChildSession({
		mode: "fork",
		sessionsRoot: "/sessions",
		cwd: "/child",
		parentSessionFile: "/sessions/parent.jsonl",
		parentBranchEntries: branch,
		sessionId: "fork-1",
		now: new Date("2026-01-01T00:00:00.123Z"),
		writeFile: (f, d) => files.set(f, d),
	});
	const lines = files.get(s.file).trim().split("\n").map((l) => JSON.parse(l));
	assert(lines[0].type === "session" && lines[0].id === "fork-1", "новый header");
	assert(lines.length === 3, "header + 2 записи: " + lines.length);
	assert(lines[1].id === "m1" && lines[2].id === "m2", "записи скопированы с id");
	assert(lines.length === 3 && !lines.some((l) => l.id === "old"), "только новый header + ветвь");
});

await check("session: sessionsRootFor — getSessionDir() это per-cwd подкаталог, а не корень", () => {
	assert(session.sessionsRootFor("/h/.pi/agent/sessions/--tmp-x--") === "/h/.pi/agent/sessions", "корень");
});

await check("session: lastAssistantText", () => {
	const lines = [
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
		JSON.stringify({ type: "message", message: { role: "user", content: "q" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "final answer" }] } }),
		"not-json",
	];
	assert(session.lastAssistantText(lines) === "final answer", "последний текст");
});

// ── tmux backend ──

function fakeRunner(handlers) {
	const calls = [];
	const runner = (args) => {
		calls.push(args);
		for (const [prefix, reply] of Object.entries(handlers)) {
			if (args.join(" ").startsWith(prefix)) {
				if (reply instanceof Error) throw reply;
				return reply;
			}
		}
		return "";
	};
	return { runner, calls };
}

await check("tmux: createSurface — split-window из $TMUX_PANE + rename", async () => {
	const { runner, calls } = fakeRunner({
		"split-window": "@7 %42",
	});
	const be = createTmuxBackend({ runner, env: { TMUX: "/tmp/tmux-1/default", TMUX_PANE: "%1" } });
	const surface = await be.createSurface({ name: "scout" });
	assert(surface.kind === "pane" && surface.target === "%42", "surface: " + JSON.stringify(surface));
	assert(calls[0][0] === "split-window" && calls[0].includes("-d") && calls[0].includes("-h"), "split -d -h");
	assert(calls[0][calls[0].indexOf("-t") + 1] === "%1", "target = панель родителя");
	assert(calls[1][0] === "rename-window" && calls[1].includes("scout"), "rename");
});

await check("tmux: createSurface вне tmux -> ошибка", async () => {
	const { runner } = fakeRunner({});
	const be = createTmuxBackend({ runner, env: {} });
	let threw = false;
	try {
		await be.createSurface({ name: "x" });
	} catch (e) {
		threw = true;
		assert(String(e.message).includes("tmux"), "текст ошибки: " + e.message);
	}
	assert(threw, "ожидалось исключение");
});

await check("tmux: probe — нет TMUX / сервер упал", async () => {
	const be1 = createTmuxBackend({ runner: fakeRunner({}).runner, env: {} });
	assert((await be1.probe()).ok === false, "нет TMUX");
	const be2 = createTmuxBackend({ runner: fakeRunner({ "list-sessions": new Error("no server") }).runner, env: { TMUX: "x" } });
	assert((await be2.probe()).ok === false, "нет сервера");
	const be3 = createTmuxBackend({ runner: fakeRunner({ "list-sessions": "" }).runner, env: { TMUX: "x" } });
	assert((await be3.probe()).ok === true, "ок");
});

await check("tmux: sendCommand / sendEscape / close / captureTail", async () => {
	const { runner, calls } = fakeRunner({
		"list-panes": "%42",
		"capture-pane": "line1\n__SUBAGENT_EXIT_1__",
	});
	const be = createTmuxBackend({ runner, env: { TMUX: "x", TMUX_PANE: "%1" } });
	const s = { kind: "pane", target: "%42" };
	await be.sendCommand(s, "/tmp/a b.sh");
	assert(calls[calls.length - 2].join(" ") === 'send-keys -t %42 -l bash /tmp/a b.sh', "send-keys -l: " + calls[calls.length - 2].join(" "));
	assert(calls[calls.length - 1].join(" ") === "send-keys -t %42 Enter", "Enter");
	await be.sendEscape(s);
	assert(calls[calls.length - 1].join(" ") === "send-keys -t %42 Escape", "Escape");
	assert(await be.isAlive(s) === true, "alive");
	const tail = await be.captureTail(s, 5);
	assert(tail.includes("__SUBAGENT_EXIT_1__"), "capture");
	await be.close(s);
	assert(calls[calls.length - 1].join(" ") === "kill-pane -t %42", "close pane");
});

await check("tmux: isAlive=false при мёртвой панели, close мёртвой не роняет", async () => {
	const { runner } = fakeRunner({ "list-panes": new Error("can't find pane") });
	const be = createTmuxBackend({ runner, env: { TMUX: "x" } });
	const s = { kind: "pane", target: "%99" };
	assert(await be.isAlive(s) === false, "dead");
	await be.close(s); // не должно бросить
});

await check("tmux: batchStatus — один list-panes на всех", async () => {
	const { runner, calls } = fakeRunner({ "list-panes": "%42\n%43\n" });
	const be = createTmuxBackend({ runner, env: { TMUX: "x" } });
	const map = await be.batchStatus([
		{ kind: "pane", target: "%42" },
		{ kind: "pane", target: "%99" },
	]);
	assert(map.get("%42") === true && map.get("%99") === false, "map: " + [...map]);
	assert(calls.length === 1 && calls[0][0] === "list-panes" && calls[0].includes("-s"), "один вызов list-panes -s");
});

// ── launch script ──

function makeRunning(overrides = {}) {
	return {
		id: "id123456",
		name: "Scout: Auth",
		agent: "scout",
		task: "Map the auth module",
		surface: { kind: "pane", target: "%42" },
		sessionFile: "/sessions/--proj--/f.jsonl",
		activityFile: "/art/scout-activity.json",
		launchScript: "/art/scout.launch.sh",
		startTime: 0,
		autoExit: true,
		interactive: false,
		phase: "starting",
		stallPingSent: false,
		finished: false,
		...overrides,
	};
}

await check("launch script: базовая структура и цитирование", () => {
	const script = buildLaunchScript({
		r: makeRunning(),
		def: undefined,
		params: { task: "Map the 'auth' module", skills: "scout, style" },
		childCwd: "/home/me/proj",
		model: "anthropic/claude-haiku:minimal",
		systemPromptFile: "/art/sys.md",
		childSessionFile: "/sessions/--proj--/f.jsonl",
		autoExit: true,
	});
	const lines = script.split("\n");
	assert(lines[0] === "#!/bin/bash", "shebang");
	assert(lines[2].startsWith("cd '"), "cd с кавычками: " + lines[2]);
	const envLine = lines[3];
	assert(envLine.includes("PI_SUBAGENTS_CHILD_ID=id123456"), "child id env");
	assert(envLine.includes("PI_SUBAGENTS_AUTO_EXIT=1"), "auto-exit env");
	const piLine = envLine.slice(envLine.indexOf("pi "));
	assert(piLine.includes(`--session /sessions/--proj--/f.jsonl`), "--session");
	assert(piLine.includes("-e "), "-e child");
	assert(piLine.includes("--model anthropic/claude-haiku:minimal"), "model:thinking");
	assert(piLine.includes("--append-system-prompt /art/sys.md"), "system prompt file");
	assert(piLine.includes("--exclude-tools spawn_agent,agents_list,interrupt_agent,resume_agent"), "exclude parent tools");
	assert(piLine.includes("--no-extensions"), "детерминированное окружение ребёнка по умолчанию");
	const allEnv = buildLaunchScript({ r: makeRunning(), def: undefined, params: { task: "x" }, childCwd: "/p", model: undefined, childSessionFile: "/s.jsonl", autoExit: true, childExtensions: "all" });
	assert(!allEnv.includes("--no-extensions"), "child.extensions=all отключает --no-extensions");
	assert(piLine.includes(`'Map the '\\''auth'\\'' module'`), "task в single-quotes с экранированием: " + piLine);
	assert(piLine.includes("/skill:scout") && piLine.includes("/skill:style"), "skills");
	assert(lines[lines.length - 1] === 'echo "__SUBAGENT_EXIT_$?"', "sentinel");
});

await check("launch script: resume — без task, с resumeMessage и allowlist", () => {
	const def = agents.parseAgentDefinition(AGENT_MD, "s", "project", "/x");
	const script = buildLaunchScript({
		r: makeRunning({ name: "Resume x" }),
		def,
		params: { task: "please continue with v2" },
		childCwd: "/proj",
		model: undefined,
		childSessionFile: "/old/session.jsonl",
		resumeMessage: "please continue with v2",
		autoExit: false,
	});
	assert(script.includes("--tools 'read,bash,agent_done,agent_ping'") || script.includes("--tools read,bash,agent_done,agent_ping"), "allowlist: " + script);
	assert(script.includes("PI_SUBAGENTS_AUTO_EXIT=0"), "auto-exit off");
	assert(script.includes("--session /old/session.jsonl"), "resume --session");
});

// ── watchdog classification ──

function snap(overrides = {}) {
	return { v: 1, childId: "x", seq: 1, ts: Date.now(), agentActive: false, turnActive: false, providerActive: false, toolActive: false, ...overrides };
}

await check("watchdog: starting/active/waiting/stalled", () => {
	const now = Date.now();
	let r = makeRunning();
	assert(classifyPhase(r, now, 30_000) === "starting", "нет снапшота -> starting");
	r.lastSnapshot = snap({ ts: now - 1000, toolActive: true, toolName: "bash" });
	assert(classifyPhase(r, now, 30_000) === "active", "свежий busy -> active");
	r.lastSnapshot = snap({ ts: now - 1000 });
	assert(classifyPhase(r, now, 30_000) === "waiting", "свежий idle -> waiting");
	r.lastSnapshot = snap({ ts: now - 60_000, agentActive: true });
	assert(classifyPhase(r, now, 30_000) === "stalled", "устаревший busy -> stalled");
	r.lastSnapshot = snap({ ts: now - 60_000 });
	assert(classifyPhase(r, now, 30_000) === "waiting", "устаревший idle -> waiting (не ложный stall)");
});

// ── v2: agents — spawning / deny-tools / bundled ──

await check("agents: spawning и deny-tools из frontmatter", () => {
	const def = agents.parseAgentDefinition(
		"---\nname: boss\nspawning: true\ndeny-tools: edit, write\n---\nbody\n",
		"boss",
		"project",
		"/x",
	);
	assert(def.spawning === true, "spawning: true");
	assert(def.denyTools === "edit, write", "deny-tools: " + def.denyTools);
	const off = agents.parseAgentDefinition("---\nname: plain\n---\nb\n", "plain", "project", "/x");
	assert(off.spawning === false && off.denyTools === undefined, "по умолчанию выключено");
});

await check("agents: bundled-агенты (реальный каталог) и приоритет project > bundled", () => {
	const defs = agents.discoverAgents(tmp, { projectDir: join(tmp, "nope1"), globalDir: join(tmp, "nope2"), bundledDir: agents.bundledAgentsDir() });
	for (const n of ["planner", "scout", "worker", "reviewer"]) {
		const d = defs.find((x) => x.name === n);
		assert(d, `bundled ${n} есть`);
		assert(d.source === "bundled", `source: ${d?.source}`);
	}
	const projectDir = join(tmp, "agents-bundled-project");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "worker.md"), "---\nname: worker\n---\nproject worker\n");
	const defs2 = agents.discoverAgents(tmp, { projectDir, globalDir: join(tmp, "nope2"), bundledDir: agents.bundledAgentsDir() });
	const worker = defs2.find((x) => x.name === "worker");
	assert(worker.source === "project" && worker.body.includes("project worker"), "project теньюет bundled");
});

await check("agents: buildChildToolAllowlist со spawning добавляет parent-тулзы", () => {
	const def = agents.parseAgentDefinition("---\nname: s2\ntools: read, bash\n---\nb\n", "s2", "project", "/x");
	const withSpawn = agents.buildChildToolAllowlist(def, undefined, { spawning: true });
	assert(withSpawn.includes("spawn_agent") && withSpawn.includes("resume_agent"), "parent-тулзы: " + withSpawn);
	assert(withSpawn.includes("agent_done"), "child-тулзы");
	assert(!agents.PARENT_TOOLS.includes("agent_done"), "PARENT_TOOLS не содержит child-тулзы");
});

// ── v2: launch script — spawning / deny-tools ──

await check("launch script: spawning=true — parent-ext у child, без exclude spawn-тулз, guard env", () => {
	const def = agents.parseAgentDefinition(
		"---\nname: boss\nspawning: true\ndeny-tools: edit\n---\nbody\n",
		"boss",
		"project",
		"/x",
	);
	const script = buildLaunchScript({
		r: makeRunning(),
		def,
		params: { task: "x" },
		childCwd: "/p",
		model: undefined,
		childSessionFile: "/s.jsonl",
		autoExit: true,
	});
	assert((script.match(/-e /g) || []).length === 2, "-e child + -e parent: " + (script.match(/-e /g) || []).length);
	assert(script.includes("PI_SUBAGENTS_SPAWNING=1"), "guard env");
	assert(script.includes("--exclude-tools edit"), "deny-tools в exclude: " + script);
	assert(!script.includes("spawn_agent,agents_list"), "parent-тулзы НЕ исключены");
});

await check("launch script: spawning + allowlist включает spawn-тулзы; deny-tools без spawning суммируется", () => {
	const def = agents.parseAgentDefinition(
		"---\nname: boss2\nspawning: true\ntools: read, bash\n---\nb\n",
		"boss2",
		"project",
		"/x",
	);
	const script = buildLaunchScript({ r: makeRunning(), def, params: { task: "x" }, childCwd: "/p", model: undefined, childSessionFile: "/s.jsonl", autoExit: true });
	assert(script.includes("--tools read,bash,spawn_agent,agents_list,interrupt_agent,resume_agent,agent_done,agent_ping"), "allowlist: " + script);

	const denyOnly = agents.parseAgentDefinition("---\nname: d\ndeny-tools: edit\n---\nb\n", "d", "project", "/x");
	const s2 = buildLaunchScript({ r: makeRunning(), def: denyOnly, params: { task: "x" }, childCwd: "/p", model: undefined, childSessionFile: "/s.jsonl", autoExit: true });
	assert(s2.includes("--exclude-tools spawn_agent,agents_list,interrupt_agent,resume_agent,edit"), "parent+deny: " + s2);
	assert((s2.match(/-e /g) || []).length === 1, "без spawning — только -e child: " + (s2.match(/-e /g) || []).length);
});

// ── v2: readChildUsage (инкрементальный сбор токенов/стоимости) ──

await check("session: readChildUsage — суммирование usage и инкрементальный offset", () => {
	const f = join(tmp, "usage.jsonl");
	writeFileSync(
		f,
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 5, totalTokens: 125, cost: { total: 0.01 } } } }) + "\n",
	);
	const r1 = session.readChildUsage(f, 0);
	assert(r1.usage.total === 125 && r1.usage.input === 100 && Math.abs(r1.usage.cost - 0.01) < 1e-9, "первый read");
	assert(r1.offset > 0, "offset сместился");
	const r2 = session.readChildUsage(f, r1.offset);
	assert(r2.usage.total === 0, "повтор без изменений — пусто");
	appendFileSync(
		f,
		JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 30, output: 7, totalTokens: 37, cost: { total: 0.002 } } } }) + "\n",
	);
	const r3 = session.readChildUsage(f, r2.offset);
	assert(r3.usage.total === 37 && Math.abs(r3.usage.cost - 0.002) < 1e-9, "дельта: " + JSON.stringify(r3.usage));
	// Частичная строка не читается до конца записи.
	appendFileSync(f, '{"type":"message","message":{"role":"assistant","usage":{"input":1');
	const r4 = session.readChildUsage(f, r3.offset);
	assert(r4.usage.total === 0, "partial line не учитывается");
	appendFileSync(f, ',"totalTokens":1}}}\n');
	const r5 = session.readChildUsage(f, r4.offset);
	assert(r5.usage.total === 1, "partial line дочитан");
});

// ── v2: smart shell-ready ──

await check("waitForShellReady: маркер промпта / таймаут / 0=skip", async () => {
	const seq = ["boot banner", "arkalaust@AORUS:~$"];
	let i = 0;
	const be = { captureTail: async () => seq[Math.min(i++, seq.length - 1)] + "\n" };
	const t0 = Date.now();
	const ok = await waitForShellReady(be, { kind: "pane", target: "%1" }, 5000, 20);
	assert(ok === true, "промпт найден");
	assert(Date.now() - t0 < 4000, "не дожидался полного таймаута");
	const busy = { captureTail: async () => "still working...\n" };
	assert((await waitForShellReady(busy, { kind: "pane", target: "%1" }, 200, 20)) === false, "таймаут -> false");
	assert((await waitForShellReady(be, { kind: "pane", target: "%1" }, 0, 20)) === false, "0 -> skip");
});

// ── v2: doctor report ──

await check("doctor: renderDoctorReport — маркировки и детали", () => {
	const rep = renderDoctorReport([
		{ name: "tmux binary", ok: true, detail: "tmux 3.6" },
		{ name: "pi inside tmux", ok: false, warn: true, detail: "not in tmux" },
		{ name: "broken" },
	]);
	assert(rep.includes("✓ tmux binary — tmux 3.6"), rep);
	assert(rep.includes("! pi inside tmux — not in tmux"), rep);
	assert(rep.includes("✗ broken"), rep);
});

// ── cleanup ──

rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
