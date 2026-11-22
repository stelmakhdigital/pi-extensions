/**
 * yolo-режим: автономный запуск pi без стартовых вопросов и без блокировок
 * guard'ов (Orca-автоматизации, CI, конвейеры, где никто не ответит в TUI).
 *
 * Включается флагом `--yolo` (регистрирует его extensions/yolo) или переменной
 * окружения PI_YOLO=1.
 *
 * Проверяется напрямую по env/argv, а не через pi.getFlag("yolo"): флаг
 * зарегистрирован только в расширении yolo, а guard'ы могут загрузиться раньше
 * него. Env наследуется дочерними процессами pi (субагенты, tmux-handoff),
 * поэтому туда флаг уже не нужен.
 */
const ON = new Set(["1", "true", "yes", "on"]);

export function isYolo(env: Record<string, string | undefined> = process.env, argv: string[] = process.argv): boolean {
	if (ON.has(String(env.PI_YOLO ?? "").toLowerCase())) return true;
	// После `--` идут сообщения: "--yolo" внутри текста промпта guard'ы не выключает.
	const sep = argv.indexOf("--");
	const opts = sep === -1 ? argv : argv.slice(0, sep);
	return opts.includes("--yolo");
}
