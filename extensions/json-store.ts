/**
 * Чтение/запись JSON-файлов состояния расширений (guard-state, sandbox-trust,
 * subagents-конфиг). Один файл могут писать два процесса pi одновременно.
 *
 * readJson: undefined при отсутствии файла и при битом JSON — всё состояние
 * в расширениях best-effort, отсутствующий файл = дефолт.
 * writeJson: tmp + rename — читатель никогда не увидит полурезанный JSON
 * (полустёртый файл терял состояние guard'ов между сессиями).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T = unknown>(file: string): T | undefined {
	try {
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Атомарная запись с отступом в 2 пробела. mode — права итогового файла (0o600 для секретов). */
export function writeJson(file: string, value: unknown, mode?: number): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
	renameSync(tmp, file);
}
