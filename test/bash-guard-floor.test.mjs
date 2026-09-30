/**
 * Смоук-тест «пола» bash-guard: паттерны HEADLESS_BLOCKED.
 * Запуск: node test/bash-guard-floor.test.mjs
 */
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(fileURLToPath(import.meta.url));
const { HEADLESS_BLOCKED } = jiti("../extensions/bash-guard/index.ts");

const results = [];
function check(name, ok) {
	results.push((ok ? "ok   " : "FAIL ") + name);
}

const power = (cmd) =>
	HEADLESS_BLOCKED.some((r) => r.reason.includes("электропитани") && r.pattern.test(cmd));

// Точечные идентификаторы — не команда электропитания (регрессия ложного
// срабатывания на grep 'telemetry.shutdown', 30.09)
check("telemetry.shutdown — не блокируется", !power("grep -rn 'telemetry.shutdown' src/"));
check("app.halt — не блокируется", !power("grep -rn 'app.halt' --include='*.py' ."));
// Настоящие команды блокируются
check("shutdown now — блокируется", power("shutdown now"));
check("sudo reboot — блокируется", power("sudo reboot"));
check("echo done; poweroff — блокируется", power("echo done; poweroff"));
check("halt — блокируется", power("halt"));

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
