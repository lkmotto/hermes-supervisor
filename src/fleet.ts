import { redactSecrets } from "./redact.js";

interface FleetClientConfig {
  baseUrl: string;
  authToken: string;
  requestTimeoutMs?: number;
}

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: RpcErrorShape;
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  if (withoutTrailingSlash.endsWith("/mcp")) return `${withoutTrailingSlash}/`;
  return `${withoutTrailingSlash}/mcp/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseRpcEnvelope(raw: string): RpcEnvelope {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty response from fleet control plane.");

  try {
    return JSON.parse(trimmed) as RpcEnvelope;
  } catch {
    // Streamable-http/SSE format: parse JSON payload from data lines.
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);

  for (const dataLine of dataLines) {
    try {
      return JSON.parse(dataLine) as RpcEnvelope;
    } catch {
      // continue
    }
  }

  throw new Error("Unable to parse fleet control plane response.");
}

function parseTextPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapToolResult(result: unknown): unknown {
  const obj = asRecord(result);

  if (Object.prototype.hasOwnProperty.call(obj, "structuredContent")) {
    return obj.structuredContent;
  }

  const content = obj.content;
  if (Array.isArray(content)) {
    const textChunks = content
      .map((entry) => asRecord(entry))
      .filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => String(entry.text).trim())
      .filter((entry) => entry.length > 0);

    if (textChunks.length === 1) return parseTextPayload(textChunks[0]);
    if (textChunks.length > 1) return parseTextPayload(textChunks.join("\n"));
  }

  return result;
}

export class FleetClient {
  private readonly endpoint: string | null;
  private readonly authToken: string;
  private readonly requestTimeoutMs: number;
  private requestId = 0;

  constructor(config: FleetClientConfig) {
    this.endpoint = normalizeBaseUrl(config.baseUrl);
    this.authToken = config.authToken ?? "";
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15000;
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.authToken.trim().length > 0);
  }

  private async rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.endpoint) throw new Error("Fleet MCP endpoint is not configured.");
    if (!this.authToken.trim()) throw new Error("Fleet MCP auth token is not configured.");

    this.requestId += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.requestId,
          method,
          params,
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`Fleet MCP HTTP ${response.status}: ${redactSecrets(raw.slice(0, 500))}`);
      }

      const envelope = parseRpcEnvelope(raw);
      if (envelope.error) {
        const err = envelope.error;
        const message = redactSecrets(String(err.message ?? "unknown fleet error"));
        throw new Error(`Fleet MCP RPC error (${err.code ?? "unknown"}): ${message}`);
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Fleet MCP request timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.rpcCall("tools/call", { name, arguments: args });
    return unwrapToolResult(result) as T;
  }

  async registerAgent(args: { name: string; kind: "variable" | "deterministic"; deploy_target?: string; version?: string }) {
    return this.callTool<Record<string, unknown>>("register_agent", args as unknown as Record<string, unknown>);
  }

  async heartbeat(agentName: string, status: unknown) {
    return this.callTool<Record<string, unknown>>("heartbeat", { agent_name: agentName, status: asRecord(status) });
  }

  async recordRunStart(args: { agent_name: string; kind: string; intent?: string; parent_run_id?: string }) {
    return this.callTool<Record<string, unknown>>("record_run_start", args as unknown as Record<string, unknown>);
  }

  async recordRunEnd(args: { run_id: string; status: "success" | "error" | "cancelled"; summary?: Record<string, unknown> }) {
    return this.callTool<Record<string, unknown>>("record_run_end", args as unknown as Record<string, unknown>);
  }

  async recordEvent(args: {
    agent_name: string;
    kind: string;
    payload?: Record<string, unknown>;
    run_id?: string;
    level?: string;
  }) {
    return this.callTool<Record<string, unknown>>("record_event", args as unknown as Record<string, unknown>);
  }

  async recordArtifactContent(args: {
    agent_name: string;
    kind: string;
    body: string;
    name?: string;
    run_id?: string;
    intent?: string;
    repo?: string;
    meta?: Record<string, unknown>;
    send_blocking?: boolean;
  }) {
    return this.callTool<Record<string, unknown>>("record_artifact_content", args as unknown as Record<string, unknown>);
  }

  async getRun(runId: string) {
    return this.callTool<Record<string, unknown>>("get_run", { run_id: runId });
  }
}
