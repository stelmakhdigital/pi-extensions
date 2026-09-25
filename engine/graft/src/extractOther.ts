/** Извлечение для Go / Rust / C / C++ / Shell: символы + именованные вызовы. */
import { createHash } from "node:crypto";
import type { Tree, Node as TsNode } from "web-tree-sitter";
import type { GraphEdge, GraphNode, RepoFile } from "./types.js";
import type { ExtractedFile, PendingMemberCall, PendingVia } from "./extract.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const firstIdent = (n: TsNode): string | null => {
	for (const c of n.namedChildren) if (c.type === "identifier") return c.text;
	return null;
};
const lastIdent = (n: TsNode): string | null => {
	let out: string | null = null;
	for (const c of n.namedChildren) if (c.type === "identifier") out = c.text;
	return out;
};

const nameChild = (n: TsNode, types: string[]): string | null => {
	for (const c of n.namedChildren) if (types.includes(c.type)) return c.text;
	return null;
};

/** Квалифицированное имя метода: enclosing class (java/csharp/kotlin). */
const enclosingClassName = (n: TsNode): string | null => {
	for (let p = n.parent; p; p = p.parent) {
		if (p.type === "class_declaration") return nameChild(p, ["identifier", "type_identifier", "simple_identifier"]);
		if (p.type === "object_declaration") return nameChild(p, ["identifier", "type_identifier"]);
	}
	return null;
};

interface SymbolRule {
	node: string;
	kind: GraphNode["kind"];
	/** Как получить имя. */
	name: (n: TsNode) => string | null;
	/** Как получить квалифицированное имя (класс.метод) — null → просто имя. */
	qualified?: (n: TsNode) => string | null;
}

interface LangRules {
	symbols: SymbolRule[];
	/** Как из call-ноды получить имя callee (null — не вызов для нас). */
	callee: (fn: TsNode) => string | null;
	/** Тип call-ноды (вместо call_expression). */
	callNode?: string;
}

const RULES: Record<string, LangRules> = {
	go: {
		symbols: [
			{ node: "function_declaration", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => n.childForFieldName?.("name")?.text ?? null,
				qualified: (n) => {
					const name = n.childForFieldName?.("name")?.text;
					const recv = n.childForFieldName?.("receiver");
					if (!name || !recv) return null;
					let t: string | null = null;
					const findType = (n: TsNode, depth: number): string | null => {
						if (depth > 3) return null;
						if (n.type === "type_identifier") return n.text; // только тип: identifier — это имя переменной-рецивера
						for (const c of n.namedChildren) {
							const r = findType(c, depth + 1);
							if (r) return r;
						}
						return null;
					};
					t = findType(recv, 0); // в т.ч. ptr receiver *T (pointer_type → type_identifier)
					return t ? `${t}.${name}` : null;
				},
			},
			{ node: "type_declaration", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : fn.type === "selector_expression" ? fn.childForFieldName?.("property")?.text ?? null : null),
	},
	rust: {
		symbols: [
			{ node: "function_item", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{
				node: "method_item",
				kind: "method",
				name: (n) => n.childForFieldName?.("name")?.text ?? null,
				qualified: (n) => {
					const name = n.childForFieldName?.("name")?.text;
					// impl_item: impl Type for ... — ищем type_path внутри родителя
					const impl = n.parent?.type === "impl_item" ? n.parent : null;
					let t: string | null = null;
					if (impl) {
						for (const c of impl.namedChildren) {
							if (c.type === "type_identifier") {
								t = c.text;
								break;
							}
						}
					}
					return t && name ? `${t}.${name}` : null;
				},
			},
			{ node: "struct_item", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "enum_item", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => {
			if (fn.type === "identifier") return fn.text;
			if (fn.type === "scoped_identifier" || fn.type === "qualified_path") return lastIdent(fn);
			return null;
		},
	},
	c: {
		symbols: [
			{
				node: "function_definition",
				kind: "function",
				name: (n) => {
					const decl = n.childForFieldName?.("declarator");
					if (!decl) return null;
					return decl.type === "identifier" ? decl.text : firstIdent(decl);
				},
			},
			{ node: "struct_specifier", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "enum_specifier", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
	},
	cpp: {
		symbols: [
			{
				node: "function_definition",
				kind: "function",
				name: (n) => {
					const decl = n.childForFieldName?.("declarator");
					if (!decl) return null;
					return decl.type === "identifier" ? decl.text : decl.type === "field_identifier" ? decl.text : firstIdent(decl);
				},
			},
			{ node: "class_specifier", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "struct_specifier", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) =>
			fn.type === "identifier" ? fn.text : fn.type === "field_expression" ? fn.childForFieldName?.("property")?.text ?? null : null,
	},
	sh: {
		symbols: [{ node: "function_definition", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? firstIdent(n) }],
		callee: (fn) => (fn.type === "identifier" || fn.type === "word" || fn.type === "command_name" ? fn.text : null),
		callNode: "command",
	},
	java: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["identifier", "type_identifier"]) },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNode: "method_invocation",
	},
	csharp: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["identifier", "type_identifier"]) },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNode: "invocation_expression",
	},
	kotlin: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["type_identifier", "identifier", "simple_identifier"]) },
			{
				node: "function_declaration",
				kind: "function",
				name: (n) => nameChild(n, ["simple_identifier", "identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["simple_identifier", "identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "simple_identifier" || fn.type === "identifier" ? fn.text : null),
		callNode: "call_expression",
	},
};

export async function extractOther(file: RepoFile, tree: Tree, lang: string): Promise<ExtractedFile> {
	const rules = RULES[lang];
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const callSites: Array<{ callee: string; caller: GraphNode | null }> = [];
	const lineCount = file.content.split("\n").length;

	nodes.push({
		id: file.path,
		name: file.path.split("/").pop() ?? file.path,
		kind: "file",
		path: file.path,
		span: { start: 1, end: lineCount },
		signature: null,
		exported: true,
		bodyHash: file.hash,
	});

	const used = new Set<string>();
	const addSymbol = (node: TsNode, name: string, kind: GraphNode["kind"], qualified?: string | null): GraphNode => {
		const nm = qualified ?? name;
		const id = `${file.path}#${nm}`;
		const existing = nodes.find((n) => n.id === id);
		if (existing) return existing;
		used.add(nm);
		const gn: GraphNode = {
			id,
			name: nm,
			kind,
			path: file.path,
			span: { start: node.startPosition.row + 1, end: node.endPosition.row + 1 },
			signature: node.text.split("\n")[0].replace(/\s+/g, " ").slice(0, 160),
			exported: true, // v1: без анализа видимости
			bodyHash: sha1(node.text),
		};
		nodes.push(gn);
		return gn;
	};

	const walk = (node: TsNode, caller: GraphNode | null): void => {
		let nextCaller = caller;
		for (const rule of rules.symbols) {
			if (node.type !== rule.node) continue;
			const name = rule.name(node);
			if (!name) break;
			nextCaller = addSymbol(node, name, rule.kind, rule.qualified?.(node) ?? null);
			break;
		}
		const callType = rules.callNode ?? "call_expression";
		if (node.type === callType) {
			// callee — первая "именованная" нода (this/obj могут идти первыми: this.m(), o.m())
			const CALLEE_TYPES = ["identifier", "simple_identifier", "command_name", "word", "type_identifier"];
			const fn = rules.callNode
				? (node.namedChildren.find((c) => CALLEE_TYPES.includes(c.type)) ?? node.namedChildren[0])
				: (node.childForFieldName?.("function") as TsNode | undefined);
			if (fn) {
				const callee = rules.callee(fn);
				if (callee) callSites.push({ callee, caller });
			}
		}
		for (const c of node.namedChildren) walk(c, nextCaller);
	};
	walk(tree.rootNode, null);

	const byName = new Map<string, GraphNode>();
	for (const n of nodes) if (n.kind !== "file" && !byName.has(n.name)) byName.set(n.name, n);
	// Квалификация: "T.m" → по методу m (для Go selector-вызовов).
	// Базовое имя (helper) → qualified-метод того же файла (T.helper), если plain-имени нет.
	const qualifiedByShort = new Map<string, GraphNode>();
	for (const n of nodes) {
		if (n.kind === "file" || !n.name.includes(".")) continue;
		const short = n.name.slice(n.name.lastIndexOf(".") + 1);
		if (!qualifiedByShort.has(short)) qualifiedByShort.set(short, n);
	}
	for (const cs of callSites) {
		const t = byName.get(cs.callee) ?? qualifiedByShort.get(cs.callee);
		if (!t) continue;
		const source = cs.caller ? cs.caller.id : file.path;
		if (source === t.id) continue;
		if (edges.some((e) => e.source === source && e.target === t.id && e.relation === "calls")) continue;
		edges.push({ source, target: t.id, relation: "calls", confidence: "extracted" });
	}

	return {
		file,
		nodes,
		edges,
		imports: [],
		exports: new Map([...byName.entries()].filter(([, n]) => n.kind !== "file")),
		vars: new Map<string, PendingVia>(),
		fnReturns: new Map<string, string>(), // у rule-языков явных return-типов нет
		pending: [] as PendingMemberCall[],
	};
}
