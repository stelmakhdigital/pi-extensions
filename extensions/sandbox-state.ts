/**
 * Мост sandbox -> guard'ов: «будет ли эта команда изолирована».
 *
 * Нужен потому, что порядок загрузки фиксирован: bash-guard оценивает команду
 * ДО sandbox (иначе dir-guard/bash-guard разбирали бы обёртку bwrap вместо
 * команды). Значит bash-guard не может увидеть результат обёртки и спрашивает
 * подтверждение на команду, которую песочница всё равно ограничит.
 *
 * sandbox регистрирует здесь предикат (ленивый: уровень/бэкенд спрашиваются в
 * момент вызова, а не кэшируются на смену уровня), guard'ы его читают.
 * Предикат не показывает промптов и не пишет ничего.
 *
 * Нет предиката (sandbox не загружен) или он бросил — false: guard спрашивает.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Probe = (ctx: ExtensionContext) => boolean;

let probe: Probe | undefined;

export function registerSandboxProbe(fn: Probe): void {
	probe = fn;
}

/** true, если sandbox возьмёт команду в изоляцию (уровень dev/untrusted, бэкенд жив). */
export function sandboxIsolates(ctx: ExtensionContext): boolean {
	try {
		return probe?.(ctx) ?? false;
	} catch {
		return false;
	}
}
