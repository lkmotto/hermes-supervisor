import { redactSecrets } from "./redact.js";

interface FleetClientConfig {
  baseUrl: string;
  authToken: string;
  requestTimeoutMs?: number;
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
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

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "[::1]";
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const isLoopback = isLoopbackHost(url.hostname);
    if (!isLoopback && url.protocol === "http:") {
      url.protocol = "https:";
    }

    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.endsWith("/mcp")) {
      url.pathname = pathname;
    } else if (pathname.length === 0 || pathname === "/") {
      url.pathname = "/mcp";
    } else {
      url.pathname = `${pathname}/mcp`;
    }
    return url.toString();
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
    if (withoutTrailingSlash.endsWith("/mcp")) return withoutTrailingSlash;
    return `${withoutTrailingSlash}/mcp`;
  }
}

function resolveRedirectUrl(currentUrl: string, location: string): string {
  try {
    const nextUrl = new URL(location, currentUrl);
    if (!isLoopbackHost(nextUrl.hostname) && nextUrl.protocol === "http:") {
      nextUrl.protocol = "https:";
    }
    return nextUrl.toString();
  } catch {
    if (location.startsWith("http://") || location.startsWith("https://")) {
      return location;
    }
    return location.startsWith("/")
      ? `${currentUrl.replace(/\/+$/, "")}${location}`
      : `${currentUrl.replace(/\/+$/, "")}/${location}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseRpcEnvelope(raw: string): RpcEnvelope {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty response from fleet control plane.");

  const envelopes: RpcEnvelope[] = [];

  try {
    envelopes.push(JSON.parse(trimmed) as RpcEnvelope);
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
      envelopes.push(JSON.parse(dataLine) as RpcEnvelope);
    } catch {
      // continue
    }
  }

  for (const envelope of envelopes) {
    if (Object.prototype.hasOwnProperty.call(envelope, "result")
      || Object.prototype.hasOwnProperty.call(envelope, "error")) {
      return envelope;
    }
  }

  if (envelopes.length > 0) return envelopes[0];

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
  private readonly protocolVersion: string;
  private readonly clientInfo: { name: string; version: string };
  private requestId = 0;
  private sessionId: string | null = null;
  private sessionInitialized = false;
  private sessionPromise: Promise<void> | null = null;
  private availableTools: Set<string> | null = null;

  constructor(config: FleetClientConfig) {
    this.endpoint = normalizeBaseUrl(config.baseUrl);
    this.authToken = config.authToken ?? "";
    this.requestTimeoutMs = config.requestTimeoutMs ?? 15000;
    this.protocolVersion = config.protocolVersion ?? "2025-06-18";
    this.clientInfo = config.clientInfo ?? {
      name: "hermes-supervisor",
      version: "unknown",
    };
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint && this.authToken.trim().length > 0);
  }

  private resetSession() {
    this.sessionId = null;
    this.sessionInitialized = false;
    this.availableTools = null;
  }

  private nextRequestId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private async rpcCall(
    method: string,
    params: Record<string, unknown>,
    options?: { includeSession?: boolean; notification?: boolean },
  ): Promise<{ result: unknown; sessionId: string | null }> {
    if (!this.endpoint) throw new Error("Fleet MCP endpoint is not configured.");
    if (!this.authToken.trim()) throw new Error("Fleet MCP auth token is not configured.");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const includeSession = options?.includeSession ?? false;
    const notification = options?.notification ?? false;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.authToken}`,
    };
    if (includeSession && this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      params,
    };
    if (!notification) {
      payload.id = this.nextRequestId();
    }

    try {
      let requestUrl = this.endpoint;
      let redirects = 0;

      while (true) {
        const response = await fetch(requestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
          redirect: "manual",
        });

        const location = response.headers.get("location");
        if (REDIRECT_STATUS_CODES.has(response.status) && typeof location === "string" && location.trim().length > 0) {
          redirects += 1;
          if (redirects > 5) {
            throw new Error(`Fleet MCP redirect limit exceeded for ${method}.`);
          }
          requestUrl = resolveRedirectUrl(requestUrl, location.trim());
          continue;
        }

        const raw = await response.text();
        if (!response.ok) {
          throw new Error(`Fleet MCP HTTP ${response.status}: ${redactSecrets(raw.slice(0, 500))}`);
        }

        const responseSessionId = response.headers.get("mcp-session-id")?.trim()
          ?? response.headers.get("Mcp-Session-Id")?.trim()
          ?? null;

        if (!raw.trim()) {
          return { result: null, sessionId: responseSessionId };
        }

        const envelope = parseRpcEnvelope(raw);
        if (envelope.error) {
          const err = envelope.error;
          const message = redactSecrets(String(err.message ?? "unknown fleet error"));
          throw new Error(`Fleet MCP RPC error (${err.code ?? "unknown"}): ${message}`);
        }
        return { result: envelope.result, sessionId: responseSessionId };
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Fleet MCP request timed out after ${this.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private shouldResetSession(error: unknown): boolean {
    if (!this.sessionId) return false;
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("http 400")
      || message.includes("http 404")
      || message.includes("http 409")
      || message.includes("session")
      || message.includes("mcp-session-id");
  }

  private async initializeSession(): Promise<void> {
    this.resetSession();

    const initializeResult = await this.rpcCall(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
      { includeSession: false },
    );

    let sessionId = initializeResult.sessionId;
    if (!sessionId) {
      const resultRecord = asRecord(initializeResult.result);
      const candidate = resultRecord.session_id ?? resultRecord.sessionId;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        sessionId = candidate.trim();
      }
    }

    if (!sessionId) {
      throw new Error("Fleet MCP initialize did not return an Mcp-Session-Id.");
    }

    this.sessionId = sessionId;

    await this.rpcCall(
      "notifications/initialized",
      {},
      { includeSession: true, notification: true },
    );

    const toolsList = await this.rpcCall("tools/list", {}, { includeSession: true });
    const tools = asArray(asRecord(toolsList.result).tools);
    this.availableTools = new Set<string>(
      tools
        .map((tool) => asRecord(tool).name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    this.sessionInitialized = true;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionInitialized && this.sessionId) return;
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        await this.initializeSession();
      })();
    }

    try {
      await this.sessionPromise;
    } catch (error) {
      this.resetSession();
      throw error;
    } finally {
      this.sessionPromise = null;
    }
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureSession();

    if (this.availableTools && !this.availableTools.has(name)) {
      const refresh = await this.rpcCall("tools/list", {}, { includeSession: true });
      const tools = asArray(asRecord(refresh.result).tools);
      this.availableTools = new Set<string>(
        tools
          .map((tool) => asRecord(tool).name)
          .filter((toolName): toolName is string => typeof toolName === "string" && toolName.length > 0),
      );
    }

    try {
      const response = await this.rpcCall(
        "tools/call",
        { name, arguments: args },
        { includeSession: true },
      );
      return unwrapToolResult(response.result) as T;
    } catch (error) {
      if (this.shouldResetSession(error)) {
        this.resetSession();
        await this.ensureSession();
        const retry = await this.rpcCall(
          "tools/call",
          { name, arguments: args },
          { includeSession: true },
        );
        return unwrapToolResult(retry.result) as T;
      }
      throw error;
    }
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

  async signalIntent(args: {
    target_agent: string;
    kind: string;
    payload?: Record<string, unknown>;
    source_agent?: string;
  }) {
    return this.callTool<Record<string, unknown>>("signal_intent", args as unknown as Record<string, unknown>);
  }

  async consumeOpenIntents(agentName: string, limit = 10) {
    const raw = await this.callTool<unknown>("consume_open_intents", {
      agent_name: agentName,
      limit,
    });
    if (Array.isArray(raw)) {
      return raw.map((entry) => asRecord(entry));
    }
    const nested = asArray(asRecord(raw).result);
    return nested.map((entry) => asRecord(entry));
  }

  async queueLocalTask(args: {
    kind: string;
    payload: Record<string, unknown>;
    description?: string;
    source?: string;
    dedup_key?: string;
    ttl_seconds?: number;
  }) {
    return this.callTool<Record<string, unknown>>("queue_local_task", args as unknown as Record<string, unknown>);
  }

  async requestCapability(args: {
    capability: string;
    justification: string;
    requested_by?: string;
    repo?: string;
    move_id?: number;
  }) {
    return this.callTool<Record<string, unknown>>("request_capability", args as unknown as Record<string, unknown>);
  }
}
