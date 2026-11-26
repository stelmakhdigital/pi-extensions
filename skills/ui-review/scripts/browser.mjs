/**
 * Общее для браузерных скриптов: где взять playwright и где лежит axe-core.
 *
 * playwright ищется от каталога, из которого запустили скрипт (обычно корень
 * проверяемого проекта), а не от каталога скилла: скилл живёт в пакете
 * pi-extensions, а зависимость — в проекте.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Нет пакета — выход с кодом 3: «среды нет», это не «проверок не прошло». */
export async function loadPlaywright() {
	const hints = [];
	try {
		return createRequire(join(process.cwd(), "index.js"))("playwright");
	} catch (e) {
		hints.push(`из ${process.cwd()}: ${e?.code ?? e?.message}`);
	}
	try {
		return await import("playwright");
	} catch (e) {
		hints.push(`от скрипта: ${e?.code ?? e?.message}`);
	}
	console.error(
		`playwright не найден (${hints.join("; ")}).\n` +
			"Один раз в проверяемом проекте: npm i -D playwright && npx playwright install chromium,"
	);
	process.exit(3);
}

/** Нет браузера — тот же смысл, что и выше, но отдельный код 4. */
export async function launchChromium(pw) {
	try {
		return await pw.chromium.launch();
	} catch (e) {
		console.error(`chromium не запущен (${String(e?.message ?? e).split("\n")[0]}). npx playwright install chromium`);
		process.exit(4);
	}
}

/** axe ищется в проверяемом проекте, а при запуске из репо скиллов — рядом со скриптом. */
export function findAxe(explicit) {
	if (explicit !== undefined) return existsSync(explicit) ? explicit : null;
	const candidates = [
		join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
		join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "node_modules", "axe-core", "axe.min.js"),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
