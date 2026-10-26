import { maskKnownSecrets, maskSecrets } from '../security/redact.js';

/**
 * A health report is written by the project's own error handlers, which is exactly where a
 * connection string or an echoed header ends up. Every string that leaves a probe goes through
 * this before it is stored, shown or put into a prompt.
 *
 * In order: literal secrets the caller knows (the key it just sent), Authorization header values,
 * passwords inside URLs, values under secret-looking names (`KEY=value`, `key: value`,
 * `"key": "value"`, and the `Password=...;` pairs of a connection string), Runova health keys,
 * and the token shapes `maskSecrets` knows. Plain error prose is left as it is.
 */

const REDACTED = '[redacted]';

/** `Authorization: Bearer xxx` and `Basic xxx`. */
const AUTH_HEADER = /\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g;
/** scheme://user:password@ */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi;
/** A name, then `=` or `:`, then the value. Whether the name is a secret's is decided per word. */
const ASSIGNMENT = /(["']?\b([A-Za-z][A-Za-z0-9_.-]*)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/g;
const SECRET_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'apikey',
  'credential',
  'credentials',
]);
const SECRET_PAIRS = new Set([
  'api key',
  'private key',
  'access key',
  'secret key',
  'client secret',
]);

/**
 * Splits a name into words (`DB_PASSWORD`, `clientSecret`, `api-key`) and asks whether any of
 * them names a secret. Whole words only, so "Passing" or "tokenizer" is not a secret's name.
 */
function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  return words.some(
    (word, index) =>
      SECRET_WORDS.has(word) || (index > 0 && SECRET_PAIRS.has(`${words[index - 1]} ${word}`)),
  );
}

/** The keys Runova generates: rnh_ now, amh_ for keys made before the app was renamed. */
const HEALTH_KEY = /\b(?:rnh|amh)_[A-Za-z0-9_-]{16,}/g;

export function redactHealthText(text: string, knownSecrets: readonly string[] = []): string {
  let output = maskKnownSecrets(text, [...knownSecrets]);
  output = output.replace(AUTH_HEADER, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  output = output.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  output = redactAssignments(output);
  output = output.replace(HEALTH_KEY, REDACTED);
  return maskSecrets(output).text;
}

function redactAssignments(text: string): string {
  return text.replace(ASSIGNMENT, (match, prefix: string, name: string, value: string) => {
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    if (isSecretName(name)) {
      return value === REDACTED ? match : `${prefix}${quote}${REDACTED}${quote}`;
    }
    // A value can hold assignments of its own, as in `"detail": "password=..."` or
    // `error: DB_PASSWORD=...`, where the label's match would otherwise swallow the secret.
    if (quote) return `${prefix}${quote}${redactAssignments(value.slice(1, -1))}${quote}`;
    return /[:=]/.test(value) ? `${prefix}${redactAssignments(value)}` : match;
  });
}
