/**
 * yolo-режим: автономный запуск pi без стартовых вопросов и без блокировок
 * guard'ов (Orca-автоматизации, CI, конвейеры, где никто не ответит в TUI).
 *
 * Включается флагом `--yolo` (регистрирует его extensions/yolo), переменной
 * окружения PI_YOLO=1 или командой /yolo в уже идущей сессии.
 *
 * Проверяется напрямую по env/argv, а не через pi.getFlag("yolo"): флаг
 * зарегистрирован только в расширении yolo, а guard'ы могут загрузиться раньше
 * него. Guard'ы спрашивают isYolo() в момент блокировки (а не в factory), поэтому
 * /yolo работает в обе стороны.
 *
 * Env наследуется дочерними процессами pi (rpc-агенты, exec), а argv родителя
 * детям не достаётся — поэтому setYolo() держит PI_YOLO в синхроне.
 */
const ON = new Set(["1", "true", "yes", "on"]);

// Переключатель команды /yolo. Перекрывает env и argv: иначе `--yolo` в argv
// возвращал бы режим сразу после «выключить».
let runtime: boolean | undefined;

// Подписчики смены режима (guard'ы обновляют бейджи).
const listeners = new Set<(on: boolean) => void>();

export function isYolo(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): boolean {
	if (runtime !== undefined) return runtime;
	if (ON.has(String(env.PI_YOLO ?? "").toLowerCase())) return true;
	// После `--` идут сообщения: "--yolo" внутри текста промпта guard'ы не выключает.
	const sep = argv.indexOf("--");
	const opts = sep === -1 ? argv : argv.slice(0, sep);
	return opts.includes("--yolo");
}

/** Сменить режим (команда /yolo). Возвращает новое состояние. */
export function setYolo(on: boolean): boolean {
	runtime = on;
	// "0" не входит в ON: дети наследуют выключенный режим, даже унаследовав env.
	process.env.PI_YOLO = on ? "1" : "0";
	for (const fn of listeners) fn(on);
	return on;
}

/** Подписка на смену режима — нужна, чтобы бейджи guard'ов не врали после /yolo. */
export function onYoloChange(fn: (on: boolean) => void): void {
	listeners.add(fn);
}

/** Забыть переключатель /yolo (тесты; /reload восстанавливает состояние из env/argv). */
export function resetYolo(): void {
	runtime = undefined;
}
