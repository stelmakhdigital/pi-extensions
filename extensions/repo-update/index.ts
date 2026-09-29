/**
 * Repo Update — команда /update: подтягивает актуальный HEAD в git-клон
 * пакета и уведомляет о результате в TUI.
 *
 * Корень репо — та копия, из которой pi реально загружает расширения:
 * берётся из пути самого файла (dirname(import.meta.url) на два уровня вверх),
 * а не из CWD — иначе тянулась бы dev-копия, а не запущенная.
 * Оверрайд для тестов/экзотики: PI_REPO_UPDATE_ROOT.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function getRepoRoot(): string {
	return process.env.PI_REPO_UPDATE_ROOT
		? resolve(process.env.PI_REPO_UPDATE_ROOT)
		: resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** git -C <root> <args> → { ok, out } (out = stdout+stderr; ok = exit 0). */
function git(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
	return new Promise((res) => {
		execFile("git", ["-C", getRepoRoot(), ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
			const out = `${stdout}\n${stderr}`.trim();
			res(err ? { ok: false, out: out || (err as Error).message } : { ok: true, out });
		});
	});
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim()) ?? s;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("update", {
		description:
			"Обновить пакет до актуального HEAD (git pull --ff-only в клоне, откуда pi грузит расширения) и доложить результат",
		handler: async (_args, ctx) => {
			const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
			if (!branch.ok) {
				ctx.ui.notify(`/update: не нашёл git-репозиторий в ${getRepoRoot()}: ${firstLine(branch.out)}`, "error");
				return;
			}
			if (branch.out === "HEAD") {
				ctx.ui.notify(`/update: HEAD в оторванном состоянии (detached) в ${getRepoRoot()} — обнови вручную.`, "error");
				return;
			}

			const before = (await git(["rev-parse", "--short", "HEAD"])).out;
			const pull = await git(["pull", "--ff-only", "origin", branch.out]);
			if (!pull.ok) {
				ctx.ui.notify(`/update: обновление не удалось: ${firstLine(pull.out)}`, "error");
				return;
			}

			const after = (await git(["rev-parse", "--short", "HEAD"])).out;
			if (before === after) {
				ctx.ui.notify(`pi-extensions: уже актуальная версия (${after}).`, "info");
			} else {
				ctx.ui.notify(
					`pi-extensions: обновлено ${before} → ${after}. Перезагрузи (/reload) или перезапусти pi, чтобы подхватить изменения.`,
					"info",
				);
			}
		},
	});
}
