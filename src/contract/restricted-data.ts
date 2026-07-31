// High-precision screen for the data classes a memory app must not store: access
// credentials/secrets, one-time codes, government identifiers, and payment-card numbers.
// Deliberately NARROW - known key shapes, a labeled assignment with a non-placeholder
// value, and Luhn-valid card numbers - so ordinary notes that merely mention "password"
// pass, while an actual `sk-...`, `password: hunter2`, SSN, or card number is refused
// before it is ever persisted. A screen for obvious secrets, not a DLP system; the
// write/edit paths refuse (never silently redact) on a hit.

// Known provider key/token prefixes. The leading lookbehind keeps hyphenated prose
// ("task-force-management-system") from tripping the bare `sk-` arm.
const KEY_RE =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[opsur]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,})/;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const OTP_RE =
  /\b(?:otp|one[ -]time (?:pass)?code|2fa code|mfa code|verification code|auth code)\b[^\n]{0,15}\b\d{4,8}\b/i;

// A credential keyword immediately assigned a value. The placeholder allowlist stops
// docs/examples ("password: required", masked "password: ****") from tripping it.
const ASSIGN_RE =
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"]?([^\s'"]{6,})/i;
const PLACEHOLDER_RE =
  /^(?:[*x.•]+|required|optional|none|null|empty|true|false|tbd|todo|redacted|hidden|changeme|password|your[_-]?password|example|placeholder|<.*>|\$\{.*\}|\[.*\])$/i;

const hasSecretAssignment = (text: string): boolean => {
  const m = ASSIGN_RE.exec(text);
  return m != null && m[1] != null && !PLACEHOLDER_RE.test(m[1]);
};

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

// A 13-19 digit run (optionally grouped by spaces/hyphens) that is Luhn-valid and starts
// with a real card IIN (3-6). Luhn + IIN + length keeps long IDs/timestamps from tripping.
const hasPaymentCard = (text: string): boolean => {
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && /^[3-6]/.test(digits) && luhnValid(digits)) {
      return true;
    }
  }
  return false;
};

// The short human label for the FIRST restricted class found, or null when clean. Used in
// the refusal message; the specific matched value is never echoed back.
export const findRestricted = (text: string): string | null => {
  if (KEY_RE.test(text)) return 'an API key or access token';
  if (JWT_RE.test(text)) return 'a JSON Web Token';
  if (PEM_RE.test(text)) return 'a private key';
  if (hasSecretAssignment(text)) return 'a password or secret value';
  if (OTP_RE.test(text)) return 'a one-time or MFA code';
  if (SSN_RE.test(text)) return 'a government identifier';
  if (hasPaymentCard(text)) return 'a payment card number';
  return null;
};

// Render frontmatter as `key: value` lines so the screen also catches a secret hidden in
// metadata (e.g. api_key: sk-...), not only the body.
export const frontmatterText = (fm?: Record<string, unknown>): string =>
  fm
    ? Object.entries(fm)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : '';

// The stable, greppable refusal message. Same wording on every surface.
export const restrictedMessage = (kind: string): string =>
  `Refused: this appears to contain ${kind}. Memory stores durable notes and knowledge, not secrets, credentials, one-time codes, or payment/government identifiers - remove it and try again.`;

// Thrown by the write/edit paths when input carries a restricted data class.
export class RestrictedContentError extends Error {
  constructor(public readonly kind: string) {
    super(restrictedMessage(kind));
    this.name = 'RestrictedContentError';
  }
}

// Throw RestrictedContentError when `text` carries a restricted data class; no-op when clean.
export const assertNoRestricted = (text: string): void => {
  const kind = findRestricted(text);
  if (kind) throw new RestrictedContentError(kind);
};
