// Secret redaction for all tool outputs, error messages, and logs.
// Replaces known secret values (sourced from the environment by name) and
// common credential patterns so secrets never appear in responses or logs.

const SECRET_ENV_NAMES = [
  "HOSTINGER_API_TOKEN",
  "PERPLEXITY_API_KEY",
  "MOTTO_MCP_AUTH_TOKEN",
  "MOTTO_MCP_URL",
  "NEON_DATABASE_URL",
  "GITHUB_PAT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "HERMES_TELE_BOT_TOKEN",
];

// Common credential formats and labeled secret assignments. These catch
// secret-like values that are not sourced from this process's environment
// (e.g. credentials pasted into memory/plan content) so they never persist
// or surface in raw form. Ordering is not significant; all are applied.
const SECRET_PATTERNS: { re: RegExp; replacement: string }[] = [
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED:aws-access-key]" },
  {
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replacement: "[REDACTED:provider-key]",
  },
  {
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED:secret-key]",
  },
  {
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED:github-pat]",
  },
  {
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED:google-api-key]",
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  // Labeled secret assignments in JSON/env/prose: key: "value" | key=value.
  // The value (group 2) is replaced while the key + separator (group 1) is kept.
  {
    re: /("?(?:pass(?:word|wd)?|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|bearer)"?\s*[:=]\s*"?)([^"\s,}{]{6,})/gi,
    replacement: "$1[REDACTED]",
  },
];

let cached: { name: string; value: string }[] | null = null;

function secrets(): { name: string; value: string }[] {
  if (cached) return cached;
  const out: { name: string; value: string }[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 6) out.push({ name, value });
  }
  // Longest values first so overlapping secrets redact cleanly.
  out.sort((a, b) => b.value.length - a.value.length);
  cached = out;
  return out;
}

export function redactSecrets(input: string): string {
  if (!input) return input;
  let result = input;
  for (const { name, value } of secrets()) {
    if (result.includes(value)) {
      result = result.split(value).join(`[REDACTED:${name}]`);
    }
  }
  // Bearer tokens.
  result = result.replace(
    /(Bearer\s+)[A-Za-z0-9._~+/=\-]{8,}/gi,
    "$1[REDACTED]",
  );
  // Credentials embedded in URLs (*************************
  result = result.replace(
    /(\/\/)[^/:@\s]+:[^@/\s]+@/g,
    "$1[REDACTED]:[REDACTED]@",
  );
  // Common credential formats and labeled secret assignments.
  for (const { re, replacement } of SECRET_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

// Keys whose values are secrets regardless of the value's format, so a bare
// value (e.g. {"password":"hunter2"}) is redacted even when it matches no
// known credential pattern.
const SENSITIVE_KEY_RE =
  /^(?:.*[_-])?(?:pass(?:word|wd)?|secret|secret[_-]?key|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|cred|bearer|cookie|session)$/i;

// Redact a structured metadata value before persistence. Strings are redacted
// in place; objects/arrays are walked recursively so secret-like values nested
// in metadata are never stored raw. Values under a sensitive key name are
// redacted wholesale even when they match no credential pattern. Returns a
// value safe to JSON.stringify.
export function redactMetadata(value: unknown, sensitiveKey = false): unknown {
  if (typeof value === "string") {
    return sensitiveKey && value.length > 0
      ? "[REDACTED]"
      : redactSecrets(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return sensitiveKey ? "[REDACTED]" : value;
  }
  if (Array.isArray(value))
    return value.map((v) => redactMetadata(v, sensitiveKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactMetadata(v, sensitiveKey || SENSITIVE_KEY_RE.test(k));
    }
    return out;
  }
  return value;
}
