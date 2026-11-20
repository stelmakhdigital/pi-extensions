/**
 * Смоук-тесты для skill session-insights (python-скрипты на fixture-сессиях).
 * Run: node test/session-insights.test.mjs
 *
 * Python обязателен: без python3 файл печатает skip и выходит 0 (как в smoke.test.mjs
 * с bubblewrap), чтобы ci оставалась зелёной на раннерах без python3.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(here, "..", "skills", "session-insights", "scripts");

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
	if (!cond) throw new Error(msg || "assert failed");
}

const py = spawnSync("python3", ["-c", "import sys"], { encoding: "utf8" });
if (py.status !== 0) {
	console.log("SKIP session-insights: python3 не найден");
	process.exit(0);
}

// ── fixtures ──

const tmp = mkdtempSync(join(tmpdir(), "si-test-"));
const root = join(tmp, "sessions");
const dir = join(root, "--fixtures-proj--");
mkdirSync(dir, { recursive: true });

const SESSION_CWD = "/fixtures/proj";
const LOG_LINE = 'ERROR: connection to database server failed, too many connections for role whcups_openapi_owner (sqlstate 53300) at 2026-11-20T10:00:00Z host=pc-tq12.oha.mcs.mail.ru';
const RULE_LINE = 'не пиши откаты в git history, делай revert commit';
const FACT_LINE = 'деплой рпд идёт в под gitlab-runner-sima-01 в namespace ci-sima';

function sessionFile(name, opts = {}) {
	const id = opts.id ?? name;
	const ts = opts.ts ?? "2026-11-20T10:00:00.000Z";
	const ms = Date.parse(ts);
	const records = [{ type: "session", id, cwd: opts.cwd ?? SESSION_CWD, timestamp: ts }];
	let seq = 0;
	const user = (text, at) => records.push({
		type: "message",
		message: { role: "user", timestamp: ms + at, content: [{ type: "text", text }] },
	});
	const assistant = (at, usage) => records.push({
		type: "message",
		message: {
			role: "assistant", timestamp: ms + at, model: "test-model", provider: "test",
			usage: { input: usage.in, output: usage.out, totalTokens: usage.in + usage.out, cost: { total: usage.cost ?? 0 } },
			content: [{ type: "text", text: "done" }, ...(usage.call ? [{ type: "toolCall", id: `c${seq}`, name: usage.call.name, arguments: usage.call.args }] : [])],
		},
	});
	const toolResult = (at, name2, isError, text) => records.push({
		type: "message",
		message: {
			role: "toolResult", toolCallId: `c${seq}`, toolName: name2, isError,
			timestamp: ms + at, content: [{ type: "text", text }],
		},
	});

	// три подряд одинаковых ошибки edit с разными id — должны свернуться в одну сигнатуру
	if (opts.editErrors) {
		for (let i = 0; i < opts.editErrors; i++) {
			assistant(1000 + i * 4000, { in: 100, out: 20, call: { name: "edit", args: { path: "/a/b/c.py" } } });
			seq++;
			toolResult(1000 + i * 4000 + 500, "edit", true,
				`Could not find edits[${i}] in /fixtures/proj/a/b/c.py, hash 0f1a2b3c4d5e6f70 seq ${1000 + i}`);
		}
	}
	if (opts.bashErrors) {
		assistant(9000, { in: 100, out: 20, call: { name: "bash", args: { command: "kubectl logs pod" } } });
		seq++;
		toolResult(9500, "bash", true, "Error: pod gitlab-runner-sima-01 not found (attempt 1)");
	}
	if (opts.skill) user(`<skill name="demo" location="/s/SKILL.md">\n${opts.skill}\n</skill>\n\nсделай отчет по часам`, 600);
	if (opts.rule) for (let i = 0; i < opts.rule; i++) user(RULE_LINE + (i ? "" : ""), 100 + i * 10000);
	if (opts.fact) user(FACT_LINE, 200);
	if (opts.log) user(`вывод из пода:\n${LOG_LINE}`, 300);
	if (opts.corrections) {
		user("нет, ты делаешь не то — перечитай файл", 400);
		user("я же просил не трогать migrations", 500);
	}
	assistant(20000, { in: opts.tokens ?? 5000, out: 500 });
	writeFileSync(join(dir, `${name}_${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// 12 сессий: выборка достаточно большая для representative
for (let i = 0; i < 12; i++) {
	sessionFile(`s${String(i).padStart(2, "0")}`, {
		id: `0000000${i}-0000-0000-0000-00000000000${i}`,
		ts: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00.000Z`,
		tokens: 1000 * (i + 1),
		rule: i % 3 === 0 ? 2 : 1,
		log: i % 2 === 0,
		fact: i % 4 === 0,
		editErrors: i % 4 === 0 ? 3 : 0,
		bashErrors: i % 3 === 0,
		corrections: i % 5 === 0,
		skill: i % 6 === 0 ? "обязательные поля задачи: " + "x".repeat(300) : null,
	});
}

const env = { ...process.env, SESSION_INSIGHTS_ROOT: root, SESSION_INSIGHTS_LEDGER: join(tmp, "ledger.md") };
function run(script, args) {
	return execFileSync("python3", [join(SCRIPTS, script), ...args], { encoding: "utf8", env, maxBuffer: 32e6 });
}

// ── sessions.py ──

await check("sessions: error_signature сворачивает id/seq/hex в одну сигнатуру", () => {
	const out = execFileSync("python3", ["-c", `
import sys; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import sessions as S
a = S.error_signature("Could not find edits[0] in /a/b/c.py, hash 0f1a2b3c4d5e6f70 seq 1000")
b = S.error_signature("Could not find edits[1] in /a/b/c.py, hash 9f8e7d6c5b4a3210 seq 1001")
print(a == b, len(a) <= 120)
`], { encoding: "utf8", env });
	assert(out.trim() === "True True", out.trim());
});

// ── insights.py ──

let digest;
await check("insights: json собирается и cost=0 => сортировка по токенам", () => {
	digest = JSON.parse(run("insights.py", ["--since", "60d", "--json"]));
	assert(digest.totals.sessions === 12, `sessions=${digest.totals.sessions}`);
	assert(digest.totals.cost_is_proxy === true, "cost_is_proxy должен быть true при cost=0");
	assert(digest.sort === "tokens", `sort=${digest.sort}`);
	assert(digest.totals.representative === true, "12 сессий = representative");
	const toks = digest.sessions_top.map((r) => r.tokens);
	assert(toks.every((v, i) => i === 0 || toks[i - 1] >= v), "sessions_top не по убыванию токенов");
});

await check("insights: императивная строка попадает в rule, лог — в noise", () => {
	const rule = digest.signals.rule.map((r) => r.line).join("\n");
	const noise = digest.signals.noise.map((r) => r.line).join("\n");
	assert(rule.includes("git history"), `rule: ${rule}`);
	assert(noise.includes("too many connections"), `noise: ${noise}`);
	assert(!noise.includes("git history"), "правило не должно попадать в noise");
});

await check("insights: токен проекта поднят в project_tokens", () => {
	const toks = digest.project_tokens.map((r) => r.token);
	assert(toks.includes("whcups_openapi_owner"), `project_tokens: ${toks.join(",")}`);
});

await check("insights: три ошибки edit свёрнуты в одну сигнатуру", () => {
	const sigs = digest.tool_errors.signatures.edit ?? [];
	assert(sigs.length === 1, `ожидал 1 сигнатуру edit, вижу ${sigs.length}: ${JSON.stringify(sigs)}`);
	assert(sigs[0].count === 9, `count=${sigs[0].count}`);
});

await check("insights: поправки пользователя посчитаны", () => {
	assert(digest.totals.corrections >= 6, `corrections=${digest.totals.corrections}`);
	assert(digest.corrections.some((c) => c.line.includes("migrations")), JSON.stringify(digest.corrections));
});

await check("insights: тело скилла из /slash не считается фактом и считается отдельно", () => {
	assert(digest.totals.skill_injections === 2, `injections=${digest.totals.skill_injections}`);
	const inj = digest.skill_injections.find((r) => r.skill === "demo");
	assert(inj && inj.chars >= 300, JSON.stringify(digest.skill_injections));
	const facts = digest.signals.fact.map((r) => r.line).join("\n");
	assert(!facts.includes("обязательные поля задачи"), "тело скилла попало в факты проекта");
	// остаток сообщения после </skill> — настоящий текст пользователя, он учитывается
	const md = run("insights.py", ["--since", "60d"]);
	assert(md.includes("Инжекты тел скиллов"), "нет секции инжектов");
});

await check("insights: markdown рендерится без падений", () => {
	const md = run("insights.py", ["--since", "60d"]);
	assert(md.includes("## Ошибки инструментов"), "нет секции ошибок");
	assert(md.includes("## Шум"), "нет секции шума");
	assert(md.includes("сортировка: tokens"), "нет пометки о сортировке");
});

await check("insights: --cwd фильтрует, пустая выборка => exit 1", () => {
	const filtered = JSON.parse(run("insights.py", ["--since", "60d", "--cwd", "fixtures", "--json"]));
	assert(filtered.totals.sessions === 12, `sessions=${filtered.totals.sessions}`);
	const r = spawnSync("python3", [join(SCRIPTS, "insights.py"), "--since", "60d", "--cwd", "нет-такого"],
		{ encoding: "utf8", env });
	assert(r.status === 1, `exit=${r.status}`);
});

// ── surface.py ──

// Фикстура agent-директории: surface не должен зависеть от реально
// установленных скиллов (на CI-раннере ~/.pi/agent пуст).
const agentDir = join(tmp, "agent");
mkdirSync(join(agentDir, "skills", "demo-skill"), { recursive: true });
writeFileSync(join(agentDir, "AGENTS.md"), "# Правила\n\n- перечитывай файл перед edit\n");
writeFileSync(join(agentDir, "skills", "demo-skill", "SKILL.md"),
	"---\nname: demo-skill\ndescription: >-\n  Короткое описание в первую строку не влезает,\n  поэтому оно написано блоком с переносами.\n---\n\n# Тело скилла\n\naaa\n");
// без description pi скилл не грузит; disable-model-invocation — не в промпт;
// второе вхождение того же имени — коллизия (pi оставляет первое)
mkdirSync(join(agentDir, "skills", "no-desc"), { recursive: true });
writeFileSync(join(agentDir, "skills", "no-desc", "SKILL.md"), "---\nname: no-desc\n---\n\nbody\n");
mkdirSync(join(agentDir, "skills", "explicit-only"), { recursive: true });
writeFileSync(join(agentDir, "skills", "explicit-only", "SKILL.md"),
	"---\nname: explicit-only\ndescription: только по /вызову\ndisable-model-invocation: true\n---\n\nbody\n");
mkdirSync(join(agentDir, "skills", "demo-skill-copy"), { recursive: true });
writeFileSync(join(agentDir, "skills", "demo-skill-copy", "SKILL.md"),
	"---\nname: demo-skill\ndescription: дубль имени\n---\n\nbody\n");

await check("surface: правила загрузки скиллов pi (описание, флаги, коллизии, разметка)", () => {
	const envFix = { ...env, PI_CODING_AGENT_DIR: agentDir,
		// ~/.agents на хосте содержит свои скиллы — тест не должен их видеть
		SESSION_INSIGHTS_SKILL_ROOTS: "" };
	const s = JSON.parse(execFileSync("python3", [join(SCRIPTS, "surface.py"), "--json"], { encoding: "utf8", env: envFix }));
	assert(s.totals.skills_count === 1, `skills=${s.totals.skills_count} (no-desc/disable/коллизия не должны считается)`);
	const one = s.skills[0];
	assert(one.name === "demo-skill", one.name);
	// блочный скаляр целиком, а не первая строка
	assert(one.description_chars > 60, `description_chars=${one.description_chars}`);
	// 97 символов xml-разметки на скилл + name + description + путь
	assert(one.always_on_chars === 97 + one.name.length + one.description_chars + one.path.length,
		`always_on_chars=${one.always_on_chars}`);
	assert(s.totals.skills_always_on_chars >= 281 + one.always_on_chars, "шапка блока не учтена");
	assert(one.body_chars < one.description_chars * 100, "тело не должно входить в always-on");
	assert(s.agents_md.length === 1 && s.totals.agents_md_chars > 0, JSON.stringify(s.agents_md));
});

await check("surface: пустой агент-каталог не роняет и даёт нули", () => {
	const envEmpty = { ...env, PI_CODING_AGENT_DIR: join(tmp, "agent-empty"),
		SESSION_INSIGHTS_SKILL_ROOTS: "" };
	const s = JSON.parse(execFileSync("python3", [join(SCRIPTS, "surface.py"), "--json"], { encoding: "utf8", env: envEmpty }));
	assert(s.totals.always_on_chars === 0 && s.totals.skills_count === 0, JSON.stringify(s.totals));
});

// ── ledger.py ──

const ledgerPath = env.SESSION_INSIGHTS_LEDGER;
await check("ledger: add без проверяемого pattern отклонён", () => {
	const r = spawnSync("python3", [join(SCRIPTS, "ledger.py"), "add",
		"--id", "nope", "--cue", "c", "--component", "skill", "--lesson", "l",
		"--evidence", "9 сессий — 74 ошибки edit"], { encoding: "utf8", env });
	assert(r.status === 2, `exit=${r.status}`);
	assert((r.stderr + r.stdout).toLowerCase().includes("check"), r.stderr + r.stdout);
});

await check("ledger: add/adopt/check/writeback работают на fixtures", () => {
	run("ledger.py", ["add", "--id", "edit-fresh", "--cue", "edit падает file changed",
		"--component", "guard", "--lesson", "требовать перечитать файл перед edit",
		"--evidence", "4 сессии fixtures — 9 одинаковых ошибок edit",
		"--confidence", "medium", "--check", "Could not find edits",
		"--scope", "fixtures", "--window", "20"]);
	assert(existsSync(ledgerPath), "ledger.md не создан");
	const listed = JSON.parse(run("ledger.py", ["list", "--json"]));
	assert(listed.length === 1 && listed[0].id === "edit-fresh", JSON.stringify(listed));
	assert(listed[0].verdict === "proposed", listed[0].verdict);

	run("ledger.py", ["adopt", "--id", "edit-fresh"]);
	const after = JSON.parse(run("ledger.py", ["list", "--json"]))[0];
	assert(after.verdict.startsWith("adopted"), after.verdict);

	// fixtures все «до» даты принятия (сегодня) => после нет наблюдений => confounded
	const chk = JSON.parse(run("ledger.py", ["check", "--id", "edit-fresh", "--since", "120d", "--json"]))[0];
	assert(chk.verdict_suggested === "confounded", JSON.stringify(chk));
	run("ledger.py", ["check", "--id", "edit-fresh", "--apply"]);
	const final = JSON.parse(run("ledger.py", ["list", "--json"]))[0];
	assert(final.verdict === "confounded", final.verdict);
});

await check("ledger: ноль с обеих сторон => confounded, а не 'no observed effect'", () => {
	const emptyLedger = join(tmp, "ledger-empty.md");
	const out = execFileSync("python3", ["-c", `
import sys, os, pathlib
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import ledger as L
day = datetime.now(timezone.utc)
d = pathlib.Path(os.environ["SI_TMP"]); d.mkdir(exist_ok=True)
def mk(off):
    p = d / f"s{off}.jsonl"; p.write_text("ничего релевантного")
    return SimpleNamespace(path=p, cwd="/proj/x", started_at=day + timedelta(days=off))
ss = [mk(-i) for i in range(1, 7)] + [mk(i) for i in range(1, 7)]
e = {"id": "x", "check": 'pattern="no-such-pattern" window=20d',
     "verdict": "adopted " + day.strftime("%Y-%m-%d")}
r = L.measure_change(e, ss)
print(r["verdict_suggested"], r["before_sessions"], r["after_sessions"], "ни до ни после" in r.get("why", ""))
`], { encoding: "utf8", env: { ...env, SESSION_INSIGHTS_LEDGER: emptyLedger, SI_TMP: join(tmp, "zero") } });
	assert(out.trim() === "confounded 6 6 True", out.trim());
});

rmSync(tmp, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
