/** Концепт-ноды: LLM-кластеризация файлов по темам (кэш в deep.concepts). */
import { createHash } from "node:crypto";
import type { DeepConcept, DeepConfig, DeepStore, Graph } from "./types.js";
import { readDeep, writeDeep } from "./store.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

async function llmChat(cfg: DeepConfig, system: string, user: string): Promise<string> {
	const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
	const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const text = j.choices?.[0]?.message?.content;
	if (!text) throw new Error("LLM: пустой ответ");
	return text;
}

interface LlmTopics {
	topics?: Array<{ name?: string; summary?: string; files?: string[] }>;
}

/**
 * Кластеризация файлов на 3–8 тем.
 * - Есть deep-summaries файлов → один LLM-вызов, ответ строго JSON.
 * - Без summaries → детерминированный fallback: темы по каталогам (LLM не нужен).
 * Результат кешируется в deep.json по hash(список файлов + summaries).
 */
export async function conceptsBuild(root: string, g: Graph, cfg: DeepConfig, onProgress?: (m: string) => void): Promise<DeepConcept[]> {
	const deep: DeepStore = readDeep(root);
	const paths = g.meta.files.map((f) => f.path);
	const summaries: Record<string, string> = {};
	for (const p of paths) summaries[p] = deep.files[p]?.summary ?? "";
	const hash = sha1(paths.join("\n") + "::" + Object.values(summaries).join("\n"));
	if (deep.concepts?.hash === hash) return deep.concepts.topics;

	let topics: DeepConcept[] | null = null;
	const hasSummaries = Object.values(summaries).some(Boolean);

	if (hasSummaries && cfg.baseUrl && cfg.model) {
		const input = paths.map((p) => `- ${p}: ${summaries[p] || "(нет summary)"}`).join("\n").slice(0, 24_000);
		const raw = await llmChat(
			cfg,
			"Ты — организатор документации. Ответ — строго JSON без маркдаун.",
			`Разбей список файлов кодовой базы на 3–8 тем (топиков) по функциональности. Каждый файл — ровно в одном топике.
Ответ: {"topics": [{"name": "короткое имя темы", "summary": "одним предложением ≤25 слов о теме", "files": ["пути"]}]}.
Файлы:
${input}`,
		);
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		const parsed = JSON.parse(raw.slice(start, end + 1)) as LlmTopics;
		if (!Array.isArray(parsed.topics) || !parsed.topics.length) throw new Error("concepts: LLM вернул пустые темы");
		const mapped = parsed.topics
			.map((t) => ({
				name: String(t.name ?? "без имени").slice(0, 80),
				summary: String(t.summary ?? "").slice(0, 300),
				files: (t.files ?? []).map(String).filter((f) => paths.includes(f)),
			}))
			.filter((t) => t.files.length > 0);
		if (!mapped.length) throw new Error("concepts: LLM не вернул ни одной темы с файлами");
		topics = mapped;
	}

	// Пост-процесс: все файлы обязаны быть в каком-то топике.
	if (topics) {
		const covered = new Set(topics.flatMap((t) => t.files));
		const missing = paths.filter((p) => !covered.has(p));
		if (missing.length) {
			// Пропавшие → в топик с совпадающим префиксом каталога, иначе "Прочее".
			for (const p of missing) {
				const dir = p.split("/").slice(0, -1).join("/");
				const host = topics.find((t) => t.files.some((f) => f.startsWith(dir + "/")));
				if (host) host.files.push(p);
				else topics[topics.length - 1]?.files.push(p);
			}
		}
		onProgress?.(`темы (LLM): ${topics.map((t) => t.name).join(", ")}`);
	}

	if (!topics) {
		// Fallback без LLM: темы по верхним каталогам.
		const byDir = new Map<string, string[]>();
		for (const p of paths) {
			const dir = p.includes("/") ? p.split("/")[0] : "(root)";
			byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
		}
		topics = [...byDir.entries()]
			.sort((a, b) => b[1].length - a[1].length)
			.map(([dir, fs]) => ({ name: dir, summary: `Каталог «${dir}»: ${fs.length} файлов.`, files: fs }));
		onProgress?.(`темы (fallback по каталогам): ${topics.length}`);
	}

	deep.concepts = { hash, topics };
	writeDeep(root, deep);
	return topics;
}
