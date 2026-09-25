/** Типы движка graft-engine. */

export type Lang = "ts" | "tsx" | "js" | "py" | "go" | "rust" | "c" | "cpp" | "sh" | "java" | "csharp" | "kotlin";

export interface RepoFile {
	/** Путь относительно корня репо (posix). */
	path: string;
	lang: Lang;
	content: string;
	/** sha1(content). */
	hash: string;
}

export type NodeKind = "file" | "function" | "class" | "method" | "type";

export interface GraphNode {
	/** "path" (file) или "path#symbol". */
	id: string;
	name: string;
	kind: NodeKind;
	path: string;
	/** 1-based, инклюзивные строки. */
	span: { start: number; end: number };
	signature?: string | null;
	exported: boolean;
	/** sha1(text тела/декларации). */
	bodyHash: string;
}

export type EdgeRelation = "calls" | "imports" | "references";

export interface GraphEdge {
	source: string;
	target: string;
	relation: EdgeRelation;
	confidence: "extracted";
}

export interface GraphFileMeta {
	path: string;
	hash: string;
}

export interface Graph {
	version: 1;
	meta: {
		builtAt: string;
		root: string;
		files: GraphFileMeta[];
	};
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface DeepSymbolEntry {
	hash: string;
	summary: string;
	crux?: string[];
}

export interface DeepConcept {
	name: string;
	summary: string;
	files: string[];
}

export interface DeepStore {
	files: Record<string, { hash: string; summary: string }>;
	symbols: Record<string, DeepSymbolEntry>;
	concepts?: { hash: string; topics: DeepConcept[] };
}

/** Конфиг LLM для deep-прохода (openai-chat-формат). */
export interface DeepConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
}
