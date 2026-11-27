/**
 * Окружение, от которого зависят guard'ы. PI_YOLO и PI_SUBAGENT_DEPTH читаются
 * в момент блокировки, так что тест, запущенный из оболочки с `pi --yolo`
 * (дети наследуют PI_YOLO=1), молча проверял бы «всё разрешено» и оставался
 * зелёным. Каждый guard-тест обязан вызвать это до загрузки расширений.
 */
export function isolateGuardEnv() {
	delete process.env.PI_YOLO;
	delete process.env.PI_SUBAGENT_DEPTH;
}
