const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:authentication|auth|verification|one[- ]time|otp|totp|2fa|mfa)(?:\s+(?:code|passcode))?\s*[:=#-]?\s*(?=[A-Za-z0-9-]{4,16}\b)(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,16}\b/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{12,}\b/,
  /(?:[A-Za-z0-9+/]{80,}={0,2})/,
  /\b[A-Za-z0-9_-]{80,}\b/,
] as const;

export function containsCredentialLikeText(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}
