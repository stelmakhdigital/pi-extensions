/**
 * Пути и токены, в которых лежат учётные данные (injection-guard + dir-guard).
 *
 * Два разных вопроса — две функции:
 * - isSecretPath(canonicalPath) — можно ли вообще трогать этот путь (dir-guard:
 *   блок read/write/edit/bash, применимо только к путям ВНЕ рабочей директории;
 *   `.env` и тестовые ключи внутри проекта — обычные рабочие файлы).
 * - findSecretMentions(text) — грубая подстрока по строке bash-команды, для
 *   корреляции «читаем секрет + уходим в сеть» в injection-guard. Здесь нет
 *   канонизации, поэтому срабатывание используется только как полупризнак.
 */

/** Канонические пути секретов (проверяются по canonical-пути). */
const SECRET_RES: RegExp[] = [
	/(^|\/)\.ssh(\/|$)/, // ключи, known_hosts, конфиг
	/(^|\/)\.aws(\/|$)/, // credentials, sso
	/(^|\/)\.gnupg(\/|$)/,
	/(^|\/)\.kube(\/|$)/,
	/(^|\/)\.docker\/config\.json$/,
	/(^|\/)\.git-credentials$/,
	/(^|\/)_?netrc$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.pypirc$/,
	/(^|\/)auth\.json$/, // pi: токены провайдеров
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
	/\.(pem|p12|pfx|key|keystore|jks)$/,
	/(^|\/)\.config\/(gh|gcloud|cloudsdk|gcloud-sdk)(\/|$)/,
	/(^|\/)\.pi\/agent\/(settings|trust|mcp)\.json$/, // настройки pi: инъекция их переписывает
	/(^|\/)\.env(\.[A-Za-z0-9-]+)?$/,
];

export function isSecretPath(canonicalPath: string): boolean {
	return SECRET_RES.some((re) => re.test(canonicalPath));
}

/**
 * Те же секреты в виде подстрок для разбора строки команды.
 * `.env` здесь сознательно нет: он слишком часто встречается в обычных
 * командах (`cat .env.example`, `cp .env.template`), и в корреляции «секрет +
 * сеть» давал бы ложные блокировки; доступ к `.env` вне CWD закрывает dir-guard
 * по каноническому пути (SECRET_RES выше).
 */
const SECRET_TOKENS = [
	"~/.ssh", "/.ssh/", "~/.aws", "/.aws/", "~/.gnupg", "/.gnupg/", "~/.kube", "/.kube/",
	".docker/config.json", ".git-credentials", ".netrc", "_netrc", ".npmrc", ".pypirc",
	"auth.json", "id_rsa", "id_ed25519", ".pem", ".p12", ".pfx", "credentials.json",
	".config/gh", ".config/gcloud", ".pi/agent",
];

export function findSecretMentions(text: string): string[] {
	const found = new Set<string>();
	for (const t of SECRET_TOKENS) if (text.includes(t)) found.add(t);
	return [...found];
}
