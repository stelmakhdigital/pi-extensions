import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Путь через symlink'ы: `realpath` существующей части, недостающие компоненты
 * дописываются как есть (новый файл ещё не создан, realpathSyn бросит ENOENT).
 * Нужен там, где путь — ключ или граница: `read(a.txt)` и `edit(link.txt)`
 * указывают на один файл, а их строковые пути различаются.
 */
export function canonical(p: string): string {
	let cur = p;
	const tail: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.join(p, ...tail); // канонизировать нечего
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
}

/** Абсолютный + канонический путь относительно рабочей директории. */
export function resolvePath(cwd: string | undefined, p: string): string {
	return canonical(path.resolve(cwd || process.cwd(), p));
}
