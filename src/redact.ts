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
  result = result.replace(/(Bearer\s+)[A-Za-z0-9._~+/=\-]{8,}/gi, "$1[REDACTED]");
  // Credentials embedded in URLs (scheme://user:pass@host).
  result = result.replace(/(\/\/)[^/:@\s]+:[^@/\s]+@/g, "$1[REDACTED]:[REDACTED]@");
  return result;
}
