function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

const RAW_FACTORY_API_BASE = firstNonEmpty(
  process.env.FACTORY_API_BASE,
  process.env.FACTORY_MCP_API_BASE,
  "https://api.factory.ai",
);
const FACTORY_API_PATH_PREFIX = firstNonEmpty(
  process.env.FACTORY_API_PATH_PREFIX,
  "/api/v0",
);
const FACTORY_API_BASE = normalizeFactoryApiBase(
  RAW_FACTORY_API_BASE,
  FACTORY_API_PATH_PREFIX,
);
const FACTORY_MCP_URL = firstNonEmpty(
  process.env.FACTORY_MCP_URL,
  process.env.FACTORY_CONNECTOR_MCP_URL,
  "",
);
const FACTORY_API_KEY = (process.env.FACTORY_API_KEY ?? "").trim();
const FACTORY_MCP_API_KEY =
  process.env.FACTORY_MCP_API_KEY?.trim() ||
  process.env.FACTORY_MCP_AUTH_TOKEN?.trim() ||
  FACTORY_API_KEY;
const FACTORY_API_KEY_HEADER = firstNonEmpty(
  process.env.FACTORY_API_KEY_HEADER,
  "Authorization",
);
const FACTORY_API_KEY_PREFIX =
  process.env.FACTORY_API_KEY_PREFIX &&
  process.env.FACTORY_API_KEY_PREFIX.length > 0
    ? process.env.FACTORY_API_KEY_PREFIX
    : "Bearer ";
const FACTORY_SESSION_BACKEND = firstNonEmpty(
  process.env.FACTORY_SESSION_BACKEND,
  "auto",
).toLowerCase();
const FACTORY_MCP_PROTOCOL_VERSION = firstNonEmpty(
  process.env.FACTORY_MCP_PROTOCOL_VERSION,
  "2025-06-18",
);
const FACTORY_MCP_LIST_SESSIONS_TOOL = firstNonEmpty(
  process.env.FACTORY_MCP_LIST_SESSIONS_TOOL,
  "list_sessions",
);
const FACTORY_MCP_GET_SESSION_TOOL = firstNonEmpty(
  process.env.FACTORY_MCP_GET_SESSION_TOOL,
  "get_session",
);
const FACTORY_MCP_GET_SESSION_MESSAGES_TOOL = firstNonEmpty(
  process.env.FACTORY_MCP_GET_SESSION_MESSAGES_TOOL,
  "get_session_messages",
);
const FACTORY_MCP_POST_MESSAGE_TOOL = firstNonEmpty(
  process.env.FACTORY_MCP_POST_MESSAGE_TOOL,
  "add_session_message",
);
const FACTORY_MCP_CREATE_MISSION_TOOL = firstNonEmpty(
  process.env.FACTORY_MCP_CREATE_MISSION_TOOL,
  "create_mission",
);

let factoryMcpSessionId: string | null = null;

interface FactorySession {
  id?: string;
  sessionId?: string;
  status: string;
  model?: string;
  summary?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  computerId?: string;
  cwd?: string;
}

interface FactoryMessage {
  id: string;
  role: string;
  content: unknown;
  createdAt: string;
}

interface FactoryMission {
  id: string;
  title: string;
  status: string;
  createdAt: string;
}

interface FactoryComputer {
  id: string;
  name?: string;
  status?: string;
  providerType?: string;
}

interface FactorySessionSettings {
  interactionMode?: string;
  autonomyLevel?: string;
  model?: string;
  reasoningEffort?: string;
}

interface FactoryCreateSessionInput {
  computerId: string;
  cwd?: string;
  sessionSettings?: FactorySessionSettings;
}

interface FactoryCreateMissionInput {
  title: string;
  description: string;
  repository?: string;
  branch?: string;
}

interface FactoryPostMessageInput {
  text: string;
  computerId?: string;
}

interface FactoryPostMessageResult {
  messageId: string;
  status: "idle" | "pending" | "running";
}

interface FactoryRpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function normalizeFactoryApiBase(raw: string, pathPrefix: string): string {
  const trimmed = raw.trim().replace(/\/+$/g, "");
  const normalizedPrefix =
    pathPrefix.trim().length === 0
      ? ""
      : `/${pathPrefix.trim().replace(/^\/+|\/+$/g, "")}`;
  if (!trimmed) return `https://api.factory.ai${normalizedPrefix}`;

  let pathname = "";
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    pathname = "";
  }

  if (
    /\/api\/|\/mcp(?:\/|$)|\/sessions(?:\/|$)|\/missions(?:\/|$)/i.test(
      pathname,
    )
  ) {
    return trimmed;
  }
  return `${trimmed}${normalizedPrefix}`;
}

function buildAuthHeaders(token: string) {
  if (!token) return {};
  const headerName = FACTORY_API_KEY_HEADER.trim() || "Authorization";
  const prefix = FACTORY_API_KEY_PREFIX;
  const headerValue =
    headerName.toLowerCase() === "authorization" ? `${prefix}${token}` : token;
  return { [headerName]: headerValue };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePossiblyJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseRpcEnvelope(raw: string): FactoryRpcEnvelope {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Factory MCP response body is empty");
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as FactoryRpcEnvelope;
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  if (dataLines.length === 0) {
    throw new Error("Factory MCP response did not include a JSON payload");
  }
  return JSON.parse(dataLines[dataLines.length - 1]) as FactoryRpcEnvelope;
}

function backendUsesMcp(): boolean {
  if (FACTORY_SESSION_BACKEND === "mcp") return true;
  if (FACTORY_SESSION_BACKEND === "rest") return false;
  return FACTORY_MCP_URL.length > 0;
}

async function factoryRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  if (!FACTORY_API_KEY) {
    throw new Error("FACTORY_API_KEY is not configured");
  }
  const url = `${FACTORY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...buildAuthHeaders(FACTORY_API_KEY),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Factory API ${res.status} (${path}): ${body.slice(0, 500)}`,
    );
  }
  return res.json() as Promise<T>;
}

async function factoryMcpRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!FACTORY_MCP_URL) throw new Error("FACTORY_MCP_URL is not configured");
  if (!FACTORY_MCP_API_KEY)
    throw new Error("FACTORY_MCP_API_KEY is not configured");

  const headers: Record<string, string> = {
    ...buildAuthHeaders(FACTORY_MCP_API_KEY),
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (factoryMcpSessionId) {
    headers["mcp-session-id"] = factoryMcpSessionId;
  }

  const rpcId = `factory-${method}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const res = await fetch(FACTORY_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method,
      params,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Factory MCP ${res.status} (${method}): ${body.slice(0, 500)}`,
    );
  }

  const sessionIdHeader = res.headers.get("mcp-session-id");
  if (sessionIdHeader) {
    factoryMcpSessionId = sessionIdHeader;
  }

  const envelope = parseRpcEnvelope(await res.text());
  if (envelope.error) {
    throw new Error(
      `Factory MCP error (${method}): ${envelope.error.message ?? "unknown"}${
        envelope.error.code ? ` [${envelope.error.code}]` : ""
      }`,
    );
  }
  return envelope.result;
}

async function ensureFactoryMcpSession(): Promise<void> {
  if (factoryMcpSessionId) return;
  await factoryMcpRequest("initialize", {
    protocolVersion: FACTORY_MCP_PROTOCOL_VERSION,
    clientInfo: { name: "hermes-supervisor", version: "2.1.0" },
    capabilities: {},
  });
}

function extractMcpToolPayload(result: unknown): unknown {
  const rec = asRecord(result);
  if (rec.isError === true) {
    const content = asArray(rec.content);
    const message = content
      .map((item) => asOptionalString(asRecord(item).text) ?? "")
      .filter((text) => text.length > 0)
      .join("\n");
    throw new Error(message || "Factory MCP tool call failed");
  }

  const content = asArray(rec.content);
  const textPayload = content
    .map((item) => asOptionalString(asRecord(item).text) ?? "")
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
  if (textPayload) return parsePossiblyJson(textPayload);
  return result;
}

async function factoryMcpCallTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  await ensureFactoryMcpSession();
  const result = await factoryMcpRequest("tools/call", {
    name: toolName,
    arguments: args,
  });
  return extractMcpToolPayload(result);
}

function normalizeSessionsPayload(payload: unknown): FactorySession[] {
  if (Array.isArray(payload)) return payload as FactorySession[];
  const rec = asRecord(payload);
  if (Array.isArray(rec.sessions)) return rec.sessions as FactorySession[];
  if (Array.isArray(rec.data)) return rec.data as FactorySession[];
  return [];
}

function normalizeSessionPayload(payload: unknown): FactorySession {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const rec = payload as FactorySession & { session?: FactorySession };
    return rec.session ?? rec;
  }
  throw new Error("Invalid Factory session payload");
}

function normalizeMessagesPayload(payload: unknown): FactoryMessage[] {
  if (Array.isArray(payload)) return payload as FactoryMessage[];
  const rec = asRecord(payload);
  if (Array.isArray(rec.messages)) return rec.messages as FactoryMessage[];
  if (Array.isArray(rec.data)) return rec.data as FactoryMessage[];
  return [];
}

function normalizeComputersPayload(payload: unknown): FactoryComputer[] {
  if (Array.isArray(payload)) return payload as FactoryComputer[];
  const rec = asRecord(payload);
  if (Array.isArray(rec.computers)) return rec.computers as FactoryComputer[];
  if (Array.isArray(rec.data)) return rec.data as FactoryComputer[];
  return [];
}

function normalizePostMessagePayload(
  payload: unknown,
): FactoryPostMessageResult {
  const rec = asRecord(payload);
  const messageId =
    asOptionalString(rec.messageId) ?? asOptionalString(rec.message_id) ?? "";
  const status = (asOptionalString(rec.status) ??
    "pending") as FactoryPostMessageResult["status"];
  if (!messageId)
    throw new Error("Factory post-message payload is missing messageId");
  return { messageId, status };
}

function normalizeMissionPayload(payload: unknown): FactoryMission {
  const rec = asRecord(payload);
  const mission =
    rec.mission && typeof rec.mission === "object"
      ? asRecord(rec.mission)
      : rec;
  return mission as unknown as FactoryMission;
}

export async function listSessions(limit = 10): Promise<FactorySession[]> {
  if (backendUsesMcp()) {
    try {
      const payload = await factoryMcpCallTool(FACTORY_MCP_LIST_SESSIONS_TOOL, {
        limit,
      });
      return normalizeSessionsPayload(payload);
    } catch (error) {
      if (FACTORY_SESSION_BACKEND === "mcp") throw error;
    }
  }
  const result = await factoryRequest<{ sessions?: FactorySession[] }>(
    `/sessions?limit=${limit}`,
  );
  return result.sessions ?? [];
}

export async function listComputers(limit = 20): Promise<FactoryComputer[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await factoryRequest<{ computers?: FactoryComputer[] }>(
    `/computers?limit=${boundedLimit}`,
  );
  return normalizeComputersPayload(result);
}

export async function getSession(sessionId: string): Promise<FactorySession> {
  if (backendUsesMcp()) {
    try {
      const payload = await factoryMcpCallTool(FACTORY_MCP_GET_SESSION_TOOL, {
        session_id: sessionId,
        sessionId,
      });
      return normalizeSessionPayload(payload);
    } catch (error) {
      if (FACTORY_SESSION_BACKEND === "mcp") throw error;
    }
  }
  return factoryRequest<FactorySession>(`/sessions/${sessionId}`);
}

export async function getSessionMessages(
  sessionId: string,
  limit = 50,
): Promise<FactoryMessage[]> {
  if (backendUsesMcp()) {
    try {
      const payload = await factoryMcpCallTool(
        FACTORY_MCP_GET_SESSION_MESSAGES_TOOL,
        {
          session_id: sessionId,
          sessionId,
          limit,
          message_limit: limit,
        },
      );
      return normalizeMessagesPayload(payload);
    } catch (error) {
      if (FACTORY_SESSION_BACKEND === "mcp") throw error;
    }
  }
  const result = await factoryRequest<{ messages?: FactoryMessage[] }>(
    `/sessions/${sessionId}/messages?limit=${limit}`,
  );
  return result.messages ?? [];
}

export async function createSession(
  input: FactoryCreateSessionInput,
): Promise<FactorySession> {
  const payload: Record<string, unknown> = {
    computerId: input.computerId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sessionSettings
      ? { sessionSettings: input.sessionSettings }
      : {}),
  };
  const result = await factoryRequest<
    FactorySession | { session?: FactorySession }
  >("/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return normalizeSessionPayload(result);
}

export async function createMission(
  input: FactoryCreateMissionInput,
): Promise<FactoryMission> {
  if (backendUsesMcp()) {
    try {
      const missionArgs: Record<string, unknown> = {
        title: input.title,
        description: input.description,
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
      };
      const payload = await factoryMcpCallTool(
        FACTORY_MCP_CREATE_MISSION_TOOL,
        missionArgs,
      );
      return normalizeMissionPayload(payload);
    } catch (error) {
      if (FACTORY_SESSION_BACKEND === "mcp") throw error;
    }
  }
  return factoryRequest<FactoryMission>("/missions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function addSessionMessage(
  sessionId: string,
  input: FactoryPostMessageInput,
): Promise<FactoryPostMessageResult> {
  if (backendUsesMcp()) {
    try {
      const payload = await factoryMcpCallTool(FACTORY_MCP_POST_MESSAGE_TOOL, {
        session_id: sessionId,
        sessionId,
        text: input.text,
        computer_id: input.computerId,
        computerId: input.computerId,
      });
      return normalizePostMessagePayload(payload);
    } catch (error) {
      if (FACTORY_SESSION_BACKEND === "mcp") throw error;
    }
  }

  return factoryRequest<FactoryPostMessageResult>(
    `/sessions/${sessionId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        text: input.text,
        ...(input.computerId ? { computerId: input.computerId } : {}),
      }),
    },
  );
}
