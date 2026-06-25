function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const rec = asRecord(part);
        return asOptionalString(rec.text) ?? asOptionalString(rec.content) ?? "";
      })
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
  }
  const rec = asRecord(content);
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.content === "string") return rec.content;
  return "";
}

function asTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 1e12 ? value : value * 1000;
    return normalized > 0 ? Math.trunc(normalized) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const normalized = numeric > 1e12 ? numeric : numeric * 1000;
      return normalized > 0 ? Math.trunc(normalized) : null;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function messageTimestampMs(message: Record<string, unknown>): number | null {
  const timestampFields = [
    message.updatedAt,
    message.updated_at,
    message.createdAt,
    message.created_at,
    message.timestamp,
    message.ts,
  ];
  for (const field of timestampFields) {
    const parsed = asTimestampMs(field);
    if (parsed !== null) return parsed;
  }
  return null;
}

export interface AssistantMessageSnapshot {
  summary: string | null;
  full_text: string | null;
  message_id: string | null;
  created_at: string | null;
  created_at_ms: number | null;
}

export function latestAssistantMessageSnapshot(messages: unknown[]): AssistantMessageSnapshot {
  const candidates: Array<{
    index: number;
    fullText: string;
    messageId: string | null;
    createdAtMs: number | null;
  }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const msg = asRecord(messages[i]);
    const role = (asOptionalString(msg.role) ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const text = messageText(msg.content ?? msg.text ?? msg.message).trim();
    if (text.length === 0) continue;
    candidates.push({
      index: i,
      fullText: text,
      messageId: asOptionalString(msg.id) ?? asOptionalString(msg.messageId) ?? asOptionalString(msg.message_id),
      createdAtMs: messageTimestampMs(msg),
    });
  }

  if (candidates.length === 0) {
    return {
      summary: null,
      full_text: null,
      message_id: null,
      created_at: null,
      created_at_ms: null,
    };
  }

  const selected = [...candidates].sort((a, b) => {
    if (a.createdAtMs !== null || b.createdAtMs !== null) {
      if (a.createdAtMs === null) return 1;
      if (b.createdAtMs === null) return -1;
      const delta = b.createdAtMs - a.createdAtMs;
      if (delta !== 0) return delta;
    }
    return b.index - a.index;
  })[0];

  return {
    summary: selected.fullText.slice(0, 600),
    full_text: selected.fullText,
    message_id: selected.messageId,
    created_at: selected.createdAtMs !== null ? new Date(selected.createdAtMs).toISOString() : null,
    created_at_ms: selected.createdAtMs,
  };
}

export function normalizeConfidenceThreshold(value: unknown): number | null {
  const parsed = asOptionalNumber(value);
  if (parsed === null) return null;
  if (parsed < 0) return 0;
  if (parsed <= 1) return parsed;
  if (parsed <= 100) return parsed / 100;
  return 1;
}

export function extractConfidenceScore(text: string | null): number | null {
  if (!text) return null;

  const patterns = [
    /confidence(?:\s*(?:score|level))?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*(%|percent)?/i,
    /([0-9]+(?:\.[0-9]+)?)\s*(%|percent)\s*confidence/i,
    /confidence\s+([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const rawValue = Number(match[1]);
    if (!Number.isFinite(rawValue)) continue;
    const hasPercent = (match[2] ?? "").toLowerCase().includes("percent");
    const normalized = hasPercent || rawValue > 1
      ? rawValue / 100
      : rawValue;
    if (normalized >= 0 && normalized <= 1) return normalized;
  }
  return null;
}

export function extractCitationUrls(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/\bhttps?:\/\/[^\s<>\])]+/gi) ?? [];
  const cleaned = matches
    .map((url) => url.replace(/[),.;]+$/g, ""))
    .filter((url) => url.length > 0);
  return dedupeStrings(cleaned);
}
