/**
 * Флаг «в контекст попало недоверенное содержимое» (injection-guard).
 *
 * Модуль-синглтон по образцу yolo-mode.ts: состояние живёт в модуле, а не в
 * factory расширения, поэтому его могут читать и другие guard'ы, не импортируя
 * injection-guard целиком.
 *
 * Смысл флага: с момента, когда в контекст легли внешние данные (веб-страница,
 * вывод curl, файл из недоверенного репо, ответ MCP-инструмента), и до новой
 * живой реплики пользователя модель находится под чужим влиянием — в этом окне
 * опасные действия требуют подтверждения или блокируются.
 *
 * Ограничение (осознанное): живая реплика пользователя снимает флаг, хотя
 * загруженная страница остаётся в истории. Иначе надзор не выключался бы вообще
 * и его глушили в первой же сессии.
 */

let source: string | undefined;
let count = 0;

const listeners = new Set<(source: string) => void>();

/** Запомнить, что в контекст легли внешние данные (source — инструмент/источник). */
export function markUntrusted(src: string): void {
	count++;
	source = src;
	for (const fn of listeners) fn(src);
}

/** Последний источник недоверенного контента в текущем окне; undefined — окна нет. */
export function untrustedSource(): string | undefined {
	return source;
}

/** Сколько недоверенных результатов было в текущем окне. */
export function untrustedCount(): number {
	return count;
}

/** Снять флаг (новая реплика пользователя, /injection-guard). */
export function clearUntrusted(): void {
	source = undefined;
	count = 0;
}

/** Подписка на появление недоверенного контента (обновление бейджа). */
export function onUntrusted(fn: (src: string) => void): void {
	listeners.add(fn);
}
