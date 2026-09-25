/** Извлечение узлов (символы) и рёбер (импорты/вызовы) из parse-деревьев. */
import { createHash } from "node:crypto";
import type { Tree, Node as TsNode } from "web-tree-sitter";
import { parseSource } from "./parse.js";
import { extractOther } from "./extractOther.js";
import type { GraphEdge, GraphNode, RepoFile } from "./types.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

function signatureOf(node: TsNode, max = 160): string {
	// До первого `{` или `;`/конца — «лицо» декларации.
	let text = node.text;
	const block = text.indexOf("{");
	const semi = text.indexOf(";");
	if (block >= 0 && (semi < 0 || block < semi)) text = text.slice(0, block);
	else if (semi >= 0) text = text.slice(0, semi);
	text = text.replace(/\s+/g, " ").trim();
	return text.length > max ? text.slice(0, max) + "…" : text;
}

export interface FileImport {
	/** Спецификатор дословно. */
	specifier: string;
	/** Локальные имена (named/default/namespace). */
	names: string[];
}

export type PendingVia = { kind: "new" | "call" | "ident"; name: string };
export interface PendingMemberCall {
	caller: GraphNode | null;
	method: string;
	via: PendingVia;
}

export interface ExtractedFile {
	file: RepoFile;
	nodes: GraphNode[];
	/** Рёбра в пределах файла (same-file calls, this/методы). */
	edges: GraphEdge[];
	imports: FileImport[];
	/** Экспортируемые имена файла (имя → узел) — для разрешения импортов. */
	exports: Map<string, GraphNode>;
	/** Локальные переменные → предполагаемый тип (new X / X() / ident-цепь). */
	vars: Map<string, PendingVia>;
	/** Локальные функции/стрелки → явный тип возвращаемого значения (для f().m()). */
	fnReturns: Map<string, string>;
	/** Нерезолвленные member-вызовы (obj.m()) — резолвятся в build.ts по глобальным индексам. */
	pending: PendingMemberCall[];
}

/** Возвратное выражение: первое «return new X» в теле → X (нет аннотации типа). */
function inferredReturn(node: TsNode): string | null {
	const firstNewCtor = (n: TsNode, depth: number): string | null => {
		if (depth > 6) return null;
		if (n.type === "return_statement") {
			const arg = n.namedChildren[0];
			if (arg?.type === "new_expression") {
				const ctor = arg.childForFieldName?.("constructor");
				if (ctor?.type === "identifier") return ctor.text;
			}
			return null;
		}
		for (const c of n.namedChildren) {
			const r = firstNewCtor(c, depth + 1);
			if (r) return r;
		}
		return null;
	};
	const body = node.type === "variable_declarator"
		? node.childForFieldName?.("value")
		: (node.childForFieldName?.("body") ?? node);
	if (!body) return null;
	// arrow/function_expression: тело может быть выражением (=> new Foo())
	if (body.type === "arrow_function" || body.type === "function_expression") {
		const inner = body.childForFieldName?.("body");
		if (inner) {
			if (inner.type === "new_expression") {
				const ctor = inner.childForFieldName?.("constructor");
				if (ctor?.type === "identifier") return ctor.text;
			}
			else return firstNewCtor(inner, 0);
		}
		return null;
	}
	if (body.type === "new_expression") {
		const ctor = body.childForFieldName?.("constructor");
		if (ctor?.type === "identifier") return ctor.text;
		return null;
	}
	return firstNewCtor(body, 0);
}

/** Явный возвратный тип: первый type_identifier/identifier (Foo, Foo<T> → Foo). */
function returnTypeOf(rt: TsNode, depth = 0): string | null {
	if (depth > 3) return null;
	for (const c of rt.namedChildren) {
		if (c.type === "type_identifier" || c.type === "identifier") return c.text;
		const r = returnTypeOf(c, depth + 1);
		if (r) return r;
	}
	return null;
}

function nameChild(node: TsNode, types: string[]): string | null {
	for (const c of node.namedChildren) if (types.includes(c.type)) return c.text;
	return null;
}

function isExportedAncestor(node: TsNode): boolean {
	for (let p = node.parent; p; p = p.parent) if (p.type === "export_statement") return true;
	return false;
}



// ---------- TS/JS ----------

interface CallSite {
	fn: TsNode;
	caller: GraphNode | null;
	className: string | null;
	line: number;
}

function extractJsTs(file: RepoFile, tree: Tree): ExtractedFile {
	const nodes: GraphNode[] = [];
	const imports: FileImport[] = [];
	const callSites: CallSite[] = [];
	const vars = new Map<string, PendingVia>();
	const fnReturns = new Map<string, string>();
	const pending: PendingMemberCall[] = [];
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

	const usedNames = new Set<string>();
	const addSymbol = (
		node: TsNode,
		name: string,
		kind: GraphNode["kind"],
		exported: boolean,
		qualifiedName?: string,
	): GraphNode => {
		let nm = qualifiedName ?? name;
		let id = `${file.path}#${nm}`;
		let existing = nodes.find((n) => n.id === id);
		if (!existing && !qualifiedName) {
			// Коллизия имён (метод и топ-функция с одним именем): квалифицируем.
			if (usedNames.has(nm)) {
				nm = nm; // имя остаётся, но id различим уже не будет — пропускаем дубликат
			}
		}
		if (existing) return existing;
		usedNames.add(nm);
		const gn: GraphNode = {
			id,
			name: nm,
			kind,
			path: file.path,
			span: { start: node.startPosition.row + 1, end: node.endPosition.row + 1 },
			signature: signatureOf(node),
			exported,
			bodyHash: sha1(node.text),
		};
		nodes.push(gn);
		return gn;
	};

	const recordImport = (node: TsNode) => {
		const src = node.children.find((c) => c.type === "string");
		if (!src) return;
		const spec = src.text.slice(1, -1);
		const names: string[] = [];
		const clause = node.children.find((c) => c.type === "import_clause");
		if (clause) {
			for (const c of clause.namedChildren) {
				if (c.type === "identifier") names.push(c.text); // default
				else if (c.type === "namespace_import") names.push("*");
				else if (c.type === "named_imports")
					for (const sp of c.namedChildren) {
						if (sp.type === "import_specifier") {
							const idents = sp.namedChildren.filter((x) => x.type === "identifier" || x.type === "string");
							if (idents.length) names.push(idents[idents.length - 1].text); // локальное (после as)
						}
					}
			}
		}
		imports.push({ specifier: spec, names });
	};

	// PASS 1: символы + сайты вызовов.
	const walk1 = (node: TsNode, caller: GraphNode | null, className: string | null): void => {
		let nextCaller = caller;
		let nextClass = className;
		switch (node.type) {
			case "class_declaration":
			case "abstract_class_declaration": {
				const name = nameChild(node, ["type_identifier", "identifier"]);
				if (name) {
					addSymbol(node, name, "class", isExportedAncestor(node));
					nextClass = name;
				}
				break;
			}
			case "function_declaration": {
				const name = nameChild(node, ["identifier"]);
				if (name) {
					nextCaller = addSymbol(node, name, "function", isExportedAncestor(node));
					const rt = node.childForFieldName?.("return_type");
					if (rt) {
						const t = returnTypeOf(rt);
						if (t) fnReturns.set(name, t);
					}
					if (!fnReturns.has(name)) {
						const inf = inferredReturn(node);
						if (inf) fnReturns.set(name, inf);
					}
				}
				break;
			}
			case "method_definition": {
				const name = nameChild(node, ["property_identifier", "private_property_identifier", "string"]);
				if (name && className) {
					nextCaller = addSymbol(node, name, "method", isExportedAncestor(node), `${className}.${name}`);
				}
				break;
			}
			case "type_alias_declaration":
			case "interface_declaration":
			case "enum_declaration": {
				const name = nameChild(node, ["type_identifier", "identifier"]);
				if (name) addSymbol(node, name, "type", isExportedAncestor(node));
				break;
			}
			case "variable_declarator": {
				const name = nameChild(node, ["identifier", "object_pattern"]);
				const value = node.childForFieldName?.("value");
				if (name && value && (value.type === "arrow_function" || value.type === "function_expression")) {
					nextCaller = addSymbol(node, name, "function", isExportedAncestor(node));
					const rt = value.childForFieldName?.("return_type");
					if (rt) {
						const t = returnTypeOf(rt);
						if (t) fnReturns.set(name, t);
					}
					if (!fnReturns.has(name)) {
						const inf = inferredReturn(node);
						if (inf) fnReturns.set(name, inf);
					}
				}
				// Тип-подсказка для member-вызовов: const x = new Foo(...) / Foo(...) / y
				if (name && typeof name === "string" && value) {
					if (value.type === "new_expression") {
						const ctor = value.childForFieldName?.("constructor");
						if (ctor) {
							vars.set(name, { kind: "new", name: ctor.type === "identifier" ? ctor.text : leftmostIdent(ctor) ?? ctor.text });
						}
					} else if (value.type === "call_expression") {
						const f = value.childForFieldName?.("function");
						if (f?.type === "identifier") vars.set(name, { kind: "call", name: f.text });
					} else if (value.type === "identifier") {
						vars.set(name, { kind: "ident", name: value.text });
					}
				}
				break;
			}
			case "pair": {
				// Объектное свойство-функция: { execute: async (...) => {...} }
				const key = node.childForFieldName?.("key");
				const val = node.childForFieldName?.("value");
				if (key?.type === "property_identifier" && val && (val.type === "arrow_function" || val.type === "function_expression")) {
					nextCaller = addSymbol(node, key.text, "function", false);
				}
				break;
			}
			case "import_statement":
				recordImport(node);
				break;
			case "call_expression": {
				const fn = node.childForFieldName?.("function");
				if (fn) callSites.push({ fn, caller, className, line: node.startPosition.row + 1 });
				break;
			}
		}
		for (const c of node.namedChildren) walk1(c, nextCaller, nextClass);
	};
	walk1(tree.rootNode, null, null);

	// Индексы.
	const byName = new Map<string, GraphNode>();
	for (const n of nodes) {
		if (n.kind === "file") continue;
		if (!byName.has(n.name)) byName.set(n.name, n);
	}
	const methodByClass = new Map<string, Map<string, GraphNode>>();
	for (const n of nodes) {
		if (n.kind !== "method") continue;
		const [cls, method] = n.name.split(".");
		const m = methodByClass.get(cls) ?? new Map();
		m.set(method, n);
		methodByClass.set(cls, m);
	}

	// PASS 2: разрешение сайтов вызовов.
	const edges: GraphEdge[] = [];
	const addCallEdge = (callerNode: GraphNode | null, targetId: string) => {
		const source = callerNode ? callerNode.id : file.path;
		if (source === targetId) return;
		const dup = edges.some((e) => e.source === source && e.target === targetId && e.relation === "calls");
		if (dup) return;
		edges.push({ source, target: targetId, relation: "calls", confidence: "extracted" });
	};
	for (const site of callSites) {
		const fn = site.fn;
		if (fn.type === "identifier") {
			const t = byName.get(fn.text);
			if (t) addCallEdge(site.caller, t.id);
			continue;
		}
		if (fn.type === "member_expression") {
			const prop = fn.childForFieldName?.("property");
			const obj = fn.childForFieldName?.("object");
			if (!prop || !obj) continue;
			if (obj.type === "this" && site.className) {
				const m = methodByClass.get(site.className)?.get(prop.text);
				if (m) addCallEdge(site.caller, m.id);
			} else if (obj.type === "identifier") {
				const m = methodByClass.get(obj.text)?.get(prop.text);
				if (m) addCallEdge(site.caller, m.id);
				else {
					const v = vars.get(obj.text);
					if (v) pending.push({ caller: site.caller, method: prop.text, via: v });
				}
			} else if (obj.type === "new_expression") {
				// new X().m(...)
				const ctor = obj.childForFieldName?.("constructor");
				if (ctor?.type === "identifier") {
					const m = methodByClass.get(ctor.text)?.get(prop.text);
					if (m) addCallEdge(site.caller, m.id);
				}
			} else if (obj.type === "member_expression") {
				// Цепь a.b.m(...) — тип по левому сегменту.
				const head = leftmostIdent(obj);
				if (head) {
					const v = vars.get(head);
					if (v) pending.push({ caller: site.caller, method: prop.text, via: v });
				}
			}
		}
	}

	return { file, nodes, edges, imports, exports: collectExports(nodes), vars, fnReturns, pending };
}

/** Левый идентификатор цепочки member_expression (a.b.c → a). */
function leftmostIdent(node: TsNode): string | null {
	let n: TsNode = node;
	while (n.type === "member_expression") {
		const o = n.childForFieldName?.("object");
		if (!o) return null;
		if (o.type === "identifier") return o.text;
		n = o;
	}
	return null;
}

function collectExports(nodes: GraphNode[]): Map<string, GraphNode> {
	const m = new Map<string, GraphNode>();
	for (const n of nodes) if (n.exported && n.kind !== "file") m.set(n.name, n);
	return m;
}

// ---------- Python ----------

interface PyCallSite {
	fn: TsNode;
	caller: GraphNode | null;
	className: string | null;
}

function extractPy(file: RepoFile, tree: Tree): ExtractedFile {
	const nodes: GraphNode[] = [];
	const imports: FileImport[] = [];
	const callSites: PyCallSite[] = [];
	const vars = new Map<string, PendingVia>();
	const pending: PendingMemberCall[] = [];
	const lineCount = file.content.split("\n").length;
	const fnReturns = new Map<string, string>(); // Python: явных return-типов нет

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
	const addSymbol = (node: TsNode, name: string, kind: GraphNode["kind"], exported: boolean, qualified?: string): GraphNode => {
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
			signature: node.text.split("\n")[0].slice(0, 160),
			exported,
			bodyHash: sha1(node.text),
		};
		nodes.push(gn);
		return gn;
	};

	// PASS 1: символы + сайты вызовов (с текущим caller/классом).
	const walk1 = (node: TsNode, caller: GraphNode | null, className: string | null): void => {
		let nextCaller = caller;
		let nextClass = className;
		switch (node.type) {
			case "class_definition": {
				const name = nameChild(node, ["identifier"]);
				if (name) {
					addSymbol(node, name, "class", !name.startsWith("_"));
					nextClass = name;
				}
				break;
			}
			case "function_definition": {
				const name = nameChild(node, ["identifier"]);
				if (name) {
					const isMethod = !!className;
					const gn = addSymbol(node, name, isMethod ? "method" : "function", !isMethod && !name.startsWith("_"), isMethod ? `${className}.${name}` : undefined);
					nextCaller = gn;
				}
				break;
			}
			case "import_statement": {
				const names: string[] = [];
				for (const c of node.namedChildren) {
					if (c.type === "dotted_name") {
						const last = c.namedChildren[c.namedChildren.length - 1]?.text;
						if (last) names.push(last); // import a.b → локальное b
					} else if (c.type === "aliased_import") {
						// import a.b as x → x
						const alias = c.childForFieldName?.("alias");
						if (alias) names.push(alias.text);
					}
				}
				if (names.length) imports.push({ specifier: names.join(","), names });
				break;
			}
			case "from_import_statement": {
				// from [.]mod import a, b
				const modText = node.namedChildren.filter((c) => c.type === "dotted_name" || c.type === "relative_import").map((c) => c.text).join("").trim();
				const names: string[] = [];
				const list = node.namedChildren.find((c) => c.type === "import_list");
				if (list) {
					for (const it of list.namedChildren) {
						if (it.type === "dotted_name") names.push(it.text.split(".")[0]);
						else if (it.type === "aliased_import") {
							const alias = it.childForFieldName?.("alias");
							if (alias) names.push(alias.text);
						}
					}
				}
				imports.push({ specifier: modText, names });
				break;
			}
			case "assignment": {
				// x = Foo(...) / x = y — тип-подсказка для x.m(...)
				const left = node.childForFieldName?.("left");
				const right = node.childForFieldName?.("right");
				if (left?.type === "identifier" && right) {
					const rf = right.type === "call" ? right.childForFieldName?.("function") : null;
					if (rf?.type === "identifier") vars.set(left.text, { kind: "call", name: rf.text });
					else if (right.type === "identifier") vars.set(left.text, { kind: "ident", name: right.text });
				}
				break;
			}
			case "call": {
				const fn = node.childForFieldName?.("function");
				if (fn) callSites.push({ fn, caller, className });
				break;
			}
		}
		for (const c of node.namedChildren) walk1(c, nextCaller, nextClass);
	};
	walk1(tree.rootNode, null, null);

	// Индексы и разрешение.
	const byName = new Map<string, GraphNode>();
	for (const n of nodes) if (n.kind !== "file" && !byName.has(n.name)) byName.set(n.name, n);

	const edges: GraphEdge[] = [];
	const addCallEdge = (callerNode: GraphNode | null, targetId: string) => {
		const source = callerNode ? callerNode.id : file.path;
		if (source === targetId) return;
		if (edges.some((e) => e.source === source && e.target === targetId && e.relation === "calls")) return;
		edges.push({ source, target: targetId, relation: "calls", confidence: "extracted" });
	};
	for (const site of callSites) {
		const fn = site.fn;
		if (fn.type === "identifier") {
			const t = byName.get(fn.text);
			if (t) addCallEdge(site.caller, t.id);
		} else if (fn.type === "attribute") {
			const attr = fn.childForFieldName?.("attribute");
			const obj = fn.childForFieldName?.("object");
			if (attr && obj?.type === "identifier" && (obj.text === "self" || obj.text === "cls") && site.className) {
				const t = byName.get(`${site.className}.${attr.text}`);
				if (t) addCallEdge(site.caller, t.id);
			} else if (attr && obj?.type === "identifier" && obj.text !== "self" && obj.text !== "cls") {
				const t = byName.get(`${obj.text}.${attr.text}`);
				if (t) addCallEdge(site.caller, t.id);
				else {
					const v = vars.get(obj.text);
					if (v) pending.push({ caller: site.caller, method: attr.text, via: v });
				}
			}
		}
	}

	return { file, nodes, edges, imports, exports: collectExports(nodes), vars, fnReturns, pending };
}

// ---------- Обёртка ----------

const OTHER_LANGS = new Set(["go", "rust", "c", "cpp", "sh", "java", "csharp", "kotlin", "ruby", "php", "swift"]);

export async function extractFile(file: RepoFile): Promise<ExtractedFile> {
	const tree = await parseSource(file.lang, file.content);
	if (file.lang === "py") return extractPy(file, tree);
	if (OTHER_LANGS.has(file.lang)) return extractOther(file, tree, file.lang);
	return extractJsTs(file, tree);
}

/** Разрешение относительного импорта (TS/JS) к файлу. */
export function resolveImport(fromPath: string, specifier: string, knownPaths: Set<string>): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
	const raw = (base ? base + "/" : "") + specifier;
	// Нормализация: убрать "./" и "."-сегменты.
	const norm = raw.split("/").filter((seg) => seg && seg !== ".").join("/");
	const candidates: string[] = [norm];
	// ESM/TS-конвенция: "./x.js" в TS-исходнике может указывать на x.ts.
	if (norm.endsWith(".js")) candidates.push(norm.slice(0, -3) + ".ts", norm.slice(0, -3) + ".tsx");
	if (norm.endsWith(".mjs")) candidates.push(norm.slice(0, -4) + ".ts");
	candidates.push(norm + ".ts", norm + ".tsx", norm + ".js", norm + ".mjs", norm + ".cjs", norm + ".py", norm + "/index.ts", norm + "/index.js");
	for (const c of candidates) if (knownPaths.has(c)) return c;
	return null;
}

/** Разрешение relative Python-импорта (".x", "..x", "from .x import y"). */
export function resolvePyImport(fromPath: string, specifier: string, knownPaths: Set<string>): string | null {
	if (!specifier) return null;
	const depth = specifier.startsWith(".") ? specifier.match(/^\.+/)![0].length : 0;
	const module = specifier.replace(/^\.+/, "");
	const parts = (fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "").split("/");
	const up = depth - 1;
	if (up > 0) parts.splice(parts.length - up, up);
	const base = parts.join("/");
	const rel = module ? (base ? base + "/" : "") + module : base;
	const candidates = [rel + ".py", rel];
	for (const c of candidates) if (knownPaths.has(c)) return c;
	return null;
}
