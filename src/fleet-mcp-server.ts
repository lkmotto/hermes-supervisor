import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface FleetAgentRecord {
  agent_id: string;
  name: string;
  kind: string;
  deploy_target: string | null;
  version: string | null;
  registered_at: string;
  last_heartbeat_at: string | null;
  last_status: Record<string, unknown> | null;
}

interface FleetRunRecord {
  run_id: string;
  agent_name: string;
  kind: string;
  intent: string | null;
  parent_run_id: string | null;
  status: "running" | "success" | "error" | "cancelled";
  summary: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  event_ids: number[];
  artifact_ids: number[];
}

interface FleetEventRecord {
  event_id: number;
  run_id: string | null;
  agent_name: string;
  kind: string;
  level: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface FleetArtifactRecord {
  artifact_id: number;
  run_id: string | null;
  agent_name: string;
  kind: string;
  name: string | null;
  intent: string | null;
  repo: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  content: {
    body: string;
  };
}

interface FleetIntentRecord {
  intent_id: string;
  target_agent: string;
  kind: string;
  payload: Record<string, unknown>;
  source_agent: string | null;
  status: "open" | "consumed";
  created_at: string;
  consumed_at: string | null;
}

interface FleetLocalTaskRecord {
  id: string;
  kind: string;
  status: "queued" | "in_progress" | "succeeded" | "failed" | "cancelled";
  payload: Record<string, unknown>;
  description: string;
  source: string;
  dedup_key: string | null;
  ttl_seconds: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface FleetCapabilityRequestRecord {
  request_id: string;
  capability: string;
  justification: string;
  requested_by: string | null;
  repo: string | null;
  move_id: number | null;
  status: "pending" | "reused_existing";
  blocker_key: string;
  created_at: string;
}

interface FleetStateSnapshot {
  counters: {
    run: number;
    event: number;
    artifact: number;
    intent: number;
    task: number;
    capability: number;
  };
  agents: FleetAgentRecord[];
  runs: FleetRunRecord[];
  events: FleetEventRecord[];
  artifacts: FleetArtifactRecord[];
  intents: FleetIntentRecord[];
  localTasks: FleetLocalTaskRecord[];
  capabilityRequests: FleetCapabilityRequestRecord[];
}

class FleetStateStore {
  private readonly statePath: string;
  private readonly agents = new Map<string, FleetAgentRecord>();
  private readonly runs = new Map<string, FleetRunRecord>();
  private readonly events = new Map<number, FleetEventRecord>();
  private readonly artifacts = new Map<number, FleetArtifactRecord>();
  private readonly intents = new Map<string, FleetIntentRecord>();
  private readonly localTasks = new Map<string, FleetLocalTaskRecord>();
  private readonly capabilityRequests = new Map<string, FleetCapabilityRequestRecord>();
  private counters = {
    run: 0,
    event: 0,
    artifact: 0,
    intent: 0,
    task: 0,
    capability: 0,
  };

  constructor(statePath: string) {
    this.statePath = statePath;
    this.load();
  }

  registerAgent(args: {
    name: string;
    kind: string;
    deploy_target?: string;
    version?: string;
  }) {
    const now = nowIso();
    const existing = this.agents.get(args.name);
    const record: FleetAgentRecord = existing ?? {
      agent_id: `agent-${args.name}`,
      name: args.name,
      kind: args.kind || "variable",
      deploy_target: asOptionalString(args.deploy_target),
      version: asOptionalString(args.version),
      registered_at: now,
      last_heartbeat_at: null,
      last_status: null,
    };
    record.kind = args.kind || record.kind || "variable";
    record.deploy_target = asOptionalString(args.deploy_target) ?? record.deploy_target;
    record.version = asOptionalString(args.version) ?? record.version;
    this.agents.set(record.name, record);
    this.persist();
    return {
      agent_id: record.agent_id,
      name: record.name,
      status: "registered",
      registered_at: record.registered_at,
    };
  }

  heartbeat(args: { agent_name: string; status?: unknown }) {
    const now = nowIso();
    const agentName = args.agent_name.trim();
    const existing = this.agents.get(agentName) ?? {
      agent_id: `agent-${agentName}`,
      name: agentName,
      kind: "variable",
      deploy_target: null,
      version: null,
      registered_at: now,
      last_heartbeat_at: null,
      last_status: null,
    };
    existing.last_heartbeat_at = now;
    existing.last_status = asRecord(args.status);
    this.agents.set(agentName, existing);
    this.persist();
    return {
      ok: true,
      agent_name: agentName,
      heartbeat_at: now,
    };
  }

  recordRunStart(args: { agent_name: string; kind: string; intent?: string; parent_run_id?: string }) {
    this.counters.run += 1;
    const runId = `run-${String(this.counters.run).padStart(6, "0")}`;
    const run: FleetRunRecord = {
      run_id: runId,
      agent_name: args.agent_name.trim(),
      kind: args.kind.trim(),
      intent: asOptionalString(args.intent),
      parent_run_id: asOptionalString(args.parent_run_id),
      status: "running",
      summary: null,
      started_at: nowIso(),
      ended_at: null,
      event_ids: [],
      artifact_ids: [],
    };
    this.runs.set(runId, run);
    this.persist();
    return {
      run_id: runId,
      status: run.status,
      started_at: run.started_at,
    };
  }

  recordRunEnd(args: { run_id: string; status: "success" | "error" | "cancelled"; summary?: unknown }) {
    const run = this.runs.get(args.run_id.trim());
    if (!run) {
      throw rpcError(-32004, `Unknown run_id: ${args.run_id}`);
    }
    run.status = args.status;
    run.summary = asRecord(args.summary);
    run.ended_at = nowIso();
    this.persist();
    return {
      run_id: run.run_id,
      status: run.status,
      ended_at: run.ended_at,
    };
  }

  recordEvent(args: {
    agent_name: string;
    kind: string;
    payload?: unknown;
    run_id?: string;
    level?: string;
  }) {
    this.counters.event += 1;
    const eventId = this.counters.event;
    const runId = asOptionalString(args.run_id);
    const event: FleetEventRecord = {
      event_id: eventId,
      run_id: runId,
      agent_name: args.agent_name.trim(),
      kind: args.kind.trim(),
      level: asOptionalString(args.level) ?? "info",
      payload: asRecord(args.payload),
      created_at: nowIso(),
    };
    this.events.set(eventId, event);
    if (runId) {
      const run = this.runs.get(runId);
      if (run) run.event_ids.push(eventId);
    }
    this.persist();
    return {
      event_id: eventId,
      run_id: runId,
      created_at: event.created_at,
    };
  }

  recordArtifactContent(args: {
    agent_name: string;
    kind: string;
    body: string;
    name?: string;
    run_id?: string;
    intent?: string;
    repo?: string;
    meta?: unknown;
  }) {
    this.counters.artifact += 1;
    const artifactId = this.counters.artifact;
    const runId = asOptionalString(args.run_id);
    const artifact: FleetArtifactRecord = {
      artifact_id: artifactId,
      run_id: runId,
      agent_name: args.agent_name.trim(),
      kind: args.kind.trim(),
      name: asOptionalString(args.name),
      intent: asOptionalString(args.intent),
      repo: asOptionalString(args.repo),
      meta: asRecord(args.meta),
      created_at: nowIso(),
      content: {
        body: typeof args.body === "string" ? args.body : "",
      },
    };
    this.artifacts.set(artifactId, artifact);
    if (runId) {
      const run = this.runs.get(runId);
      if (run) run.artifact_ids.push(artifactId);
    }
    this.persist();
    return {
      artifact_id: artifactId,
      run_id: runId,
      created_at: artifact.created_at,
    };
  }

  getRun(runIdRaw: string) {
    const runId = runIdRaw.trim();
    const run = this.runs.get(runId);
    if (!run) throw rpcError(-32004, `Unknown run_id: ${runIdRaw}`);
    const events = run.event_ids
      .map((eventId) => this.events.get(eventId))
      .filter((event): event is FleetEventRecord => Boolean(event));
    const artifacts = run.artifact_ids
      .map((artifactId) => this.artifacts.get(artifactId))
      .filter((artifact): artifact is FleetArtifactRecord => Boolean(artifact));
    return {
      run,
      events,
      artifacts,
    };
  }

  signalIntent(args: {
    target_agent: string;
    kind: string;
    payload?: unknown;
    source_agent?: string;
  }) {
    this.counters.intent += 1;
    const intentId = `intent-${String(this.counters.intent).padStart(6, "0")}`;
    const intent: FleetIntentRecord = {
      intent_id: intentId,
      target_agent: args.target_agent.trim(),
      kind: args.kind.trim(),
      payload: asRecord(args.payload),
      source_agent: asOptionalString(args.source_agent),
      status: "open",
      created_at: nowIso(),
      consumed_at: null,
    };
    this.intents.set(intentId, intent);
    this.persist();
    return {
      intent_id: intentId,
      status: intent.status,
      target_agent: intent.target_agent,
      created_at: intent.created_at,
    };
  }

  consumeOpenIntents(args: { agent_name: string; limit?: number }) {
    const agentName = args.agent_name.trim();
    const limit = Math.max(1, Math.trunc(Number.isFinite(args.limit) ? Number(args.limit) : 10));
    const openIntents = Array.from(this.intents.values())
      .filter((intent) => intent.status === "open" && intent.target_agent === agentName)
      .slice(0, limit);
    const now = nowIso();
    for (const intent of openIntents) {
      intent.status = "consumed";
      intent.consumed_at = now;
    }
    if (openIntents.length > 0) this.persist();
    return openIntents.map((intent) => ({
      intent_id: intent.intent_id,
      target_agent: intent.target_agent,
      kind: intent.kind,
      payload: intent.payload,
      source_agent: intent.source_agent,
      created_at: intent.created_at,
      consumed_at: intent.consumed_at,
    }));
  }

  queueLocalTask(args: {
    kind: string;
    payload: unknown;
    description?: string;
    source?: string;
    dedup_key?: string;
    ttl_seconds?: number;
  }) {
    const dedupKey = asOptionalString(args.dedup_key);
    if (dedupKey) {
      const existing = Array.from(this.localTasks.values()).find((task) => task.dedup_key === dedupKey && task.status === "queued");
      if (existing) {
        return {
          task_id: existing.id,
          status: existing.status,
          kind: existing.kind,
          source: existing.source,
          deduped: true,
        };
      }
    }
    this.counters.task += 1;
    const id = `task-${String(this.counters.task).padStart(6, "0")}`;
    const task: FleetLocalTaskRecord = {
      id,
      kind: args.kind.trim(),
      status: "queued",
      payload: asRecord(args.payload),
      description: asOptionalString(args.description) ?? `Local task ${id}`,
      source: asOptionalString(args.source) ?? "unknown",
      dedup_key: dedupKey,
      ttl_seconds: asNumberOrNull(args.ttl_seconds),
      result: null,
      error: null,
      created_at: nowIso(),
      finished_at: null,
    };
    this.localTasks.set(id, task);
    this.persist();
    return {
      task_id: task.id,
      status: task.status,
      kind: task.kind,
      source: task.source,
      deduped: false,
    };
  }

  getLocalTask(taskIdRaw: string) {
    const task = this.localTasks.get(taskIdRaw.trim());
    if (!task) return null;
    return { ...task };
  }

  listLocalTasks(args: { status?: string; kind?: string; limit?: number }) {
    const status = asOptionalString(args.status)?.toLowerCase();
    const kind = asOptionalString(args.kind);
    const limit = Math.max(1, Math.trunc(Number.isFinite(args.limit) ? Number(args.limit) : 50));
    let tasks = Array.from(this.localTasks.values());
    if (status) tasks = tasks.filter((task) => task.status.toLowerCase() === status);
    if (kind) tasks = tasks.filter((task) => task.kind === kind);
    tasks = tasks.slice(0, limit);
    return tasks.map((task) => ({
      id: task.id,
      status: task.status,
      kind: task.kind,
      source: task.source,
      finished_at: task.finished_at,
      error: task.error,
    }));
  }

  requestCapability(args: {
    capability: string;
    justification: string;
    requested_by?: string;
    repo?: string;
    move_id?: number;
  }) {
    const blockerKey = `${args.capability.trim()}::${args.justification.trim()}`;
    const existing = Array.from(this.capabilityRequests.values())
      .find((request) => request.blocker_key === blockerKey);
    if (existing) {
      return {
        id: existing.request_id,
        request_id: existing.request_id,
        capability: existing.capability,
        status: "reused_existing",
        blocker_key: existing.blocker_key,
      };
    }
    this.counters.capability += 1;
    const requestId = `cap-${String(this.counters.capability).padStart(6, "0")}`;
    const request: FleetCapabilityRequestRecord = {
      request_id: requestId,
      capability: args.capability.trim(),
      justification: args.justification.trim(),
      requested_by: asOptionalString(args.requested_by),
      repo: asOptionalString(args.repo),
      move_id: asNumberOrNull(args.move_id),
      status: "pending",
      blocker_key: blockerKey,
      created_at: nowIso(),
    };
    this.capabilityRequests.set(requestId, request);
    this.persist();
    return {
      id: request.request_id,
      request_id: request.request_id,
      capability: request.capability,
      status: request.status,
      blocker_key: request.blocker_key,
    };
  }

  private load() {
    if (!existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<FleetStateSnapshot>;
      this.counters = {
        run: asInteger(parsed.counters?.run),
        event: asInteger(parsed.counters?.event),
        artifact: asInteger(parsed.counters?.artifact),
        intent: asInteger(parsed.counters?.intent),
        task: asInteger(parsed.counters?.task),
        capability: asInteger(parsed.counters?.capability),
      };
      for (const agent of parsed.agents ?? []) this.agents.set(agent.name, agent);
      for (const run of parsed.runs ?? []) this.runs.set(run.run_id, run);
      for (const event of parsed.events ?? []) this.events.set(event.event_id, event);
      for (const artifact of parsed.artifacts ?? []) this.artifacts.set(artifact.artifact_id, artifact);
      for (const intent of parsed.intents ?? []) this.intents.set(intent.intent_id, intent);
      for (const task of parsed.localTasks ?? []) this.localTasks.set(task.id, task);
      for (const request of parsed.capabilityRequests ?? []) this.capabilityRequests.set(request.request_id, request);
    } catch {
      // Invalid state file should not block startup.
    }
  }

  private persist() {
    const snapshot: FleetStateSnapshot = {
      counters: this.counters,
      agents: Array.from(this.agents.values()),
      runs: Array.from(this.runs.values()),
      events: Array.from(this.events.values()),
      artifacts: Array.from(this.artifacts.values()),
      intents: Array.from(this.intents.values()),
      localTasks: Array.from(this.localTasks.values()),
      capabilityRequests: Array.from(this.capabilityRequests.values()),
    };
    const targetDir = dirname(this.statePath);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    const payload = JSON.stringify(snapshot, null, 2);
    writeFileSync(tempPath, payload);
    try {
      renameSync(tempPath, this.statePath);
    } catch {
      writeFileSync(this.statePath, payload);
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Best effort cleanup.
        }
      }
    }
  }
}

const tools = [
  { name: "register_agent", description: "Register an agent identity in local Fleet MCP state." },
  { name: "heartbeat", description: "Record heartbeat status for an agent." },
  { name: "record_run_start", description: "Create a run envelope and return run_id." },
  { name: "record_event", description: "Persist an event row for a run." },
  { name: "record_artifact_content", description: "Persist artifact content for a run." },
  { name: "record_run_end", description: "Finalize a run and write summary." },
  { name: "get_run", description: "Retrieve run, events, and artifacts by run_id." },
  { name: "signal_intent", description: "Queue an intent for a target agent." },
  { name: "consume_open_intents", description: "Consume open intents for an agent." },
  { name: "queue_local_task", description: "Queue a local task for browser/manual execution." },
  { name: "get_local_task", description: "Retrieve a local task by task_id." },
  { name: "list_local_tasks", description: "List local tasks with filters." },
  { name: "request_capability", description: "Create or reuse a capability request." },
];

const requiredSessionMethods = new Set(["notifications/initialized", "tools/list", "tools/call"]);
const sessions = new Set<string>();
const fleetStore = new FleetStateStore(
  resolve(process.env.FLEET_MCP_STATE_PATH ?? "./fleet-mcp-local-state.json"),
);
const requiredAuthToken = normalizeAuthToken(process.env.FLEET_MCP_AUTH_TOKEN ?? process.env.MOTTO_MCP_AUTH_TOKEN ?? "");

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/mcp") {
      sendPlain(res, 404, "Not Found");
      return;
    }
    if (!isAuthorized(req, requiredAuthToken)) {
      sendJsonRpcError(res, null, { code: -32001, message: "Unauthorized" });
      return;
    }

    const body = await readBody(req);
    const rpc = parseRpcRequest(body);
    const method = rpc.method;
    if (!method) {
      sendJsonRpcError(res, rpc.id ?? null, { code: -32600, message: "Invalid request: method is required" });
      return;
    }

    const incomingSession = normalizeSessionId(req.headers["mcp-session-id"]);
    if (requiredSessionMethods.has(method) && !incomingSession) {
      sendJsonRpcError(res, rpc.id ?? null, { code: -32002, message: "MCP session required" });
      return;
    }
    if (requiredSessionMethods.has(method) && incomingSession && !sessions.has(incomingSession)) {
      sendJsonRpcError(res, rpc.id ?? null, { code: -32003, message: "Unknown MCP session" });
      return;
    }

    if (method === "initialize") {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      sendJsonRpcResult(
        res,
        rpc.id ?? 0,
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fleet-mcp-local", version: "0.1.0" },
          session_id: sessionId,
        },
        sessionId,
      );
      return;
    }

    if (method === "notifications/initialized") {
      sendNoContent(res, incomingSession);
      return;
    }

    if (method === "tools/list") {
      sendJsonRpcResult(
        res,
        rpc.id ?? 0,
        {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
          })),
        },
        incomingSession,
      );
      return;
    }

    if (method === "tools/call") {
      const params = asRecord(rpc.params);
      const name = asOptionalString(params.name);
      const args = asRecord(params.arguments);
      if (!name) {
        sendJsonRpcError(res, rpc.id ?? null, { code: -32602, message: "tools/call requires name" }, incomingSession);
        return;
      }
      const toolResult = dispatchToolCall(name, args);
      sendJsonRpcResult(
        res,
        rpc.id ?? 0,
        {
          content: [{ type: "text", text: JSON.stringify(toolResult) }],
          structuredContent: toolResult as JsonValue,
        },
        incomingSession,
      );
      return;
    }

    sendJsonRpcError(res, rpc.id ?? null, { code: -32601, message: `Unknown method: ${method}` }, incomingSession);
  } catch (error) {
    const rpcErrorShape = asRpcError(error);
    sendJsonRpcError(res, null, rpcErrorShape);
  }
});

const port = Number.parseInt(process.env.FLEET_MCP_PORT ?? "8151", 10) || 8151;
server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`fleet-mcp-local listening on http://127.0.0.1:${port}/mcp`);
});

function dispatchToolCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "register_agent":
      return fleetStore.registerAgent({
        name: requiredString(args.name, "name"),
        kind: asOptionalString(args.kind) ?? "variable",
        deploy_target: asOptionalString(args.deploy_target) ?? undefined,
        version: asOptionalString(args.version) ?? undefined,
      });
    case "heartbeat":
      return fleetStore.heartbeat({
        agent_name: requiredString(args.agent_name, "agent_name"),
        status: args.status,
      });
    case "record_run_start":
      return fleetStore.recordRunStart({
        agent_name: requiredString(args.agent_name, "agent_name"),
        kind: requiredString(args.kind, "kind"),
        intent: asOptionalString(args.intent) ?? undefined,
        parent_run_id: asOptionalString(args.parent_run_id) ?? undefined,
      });
    case "record_event":
      return fleetStore.recordEvent({
        agent_name: requiredString(args.agent_name, "agent_name"),
        kind: requiredString(args.kind, "kind"),
        payload: args.payload,
        run_id: asOptionalString(args.run_id) ?? undefined,
        level: asOptionalString(args.level) ?? "info",
      });
    case "record_artifact_content":
      return fleetStore.recordArtifactContent({
        agent_name: requiredString(args.agent_name, "agent_name"),
        kind: requiredString(args.kind, "kind"),
        body: requiredString(args.body, "body"),
        name: asOptionalString(args.name) ?? undefined,
        run_id: asOptionalString(args.run_id) ?? undefined,
        intent: asOptionalString(args.intent) ?? undefined,
        repo: asOptionalString(args.repo) ?? undefined,
        meta: args.meta,
      });
    case "record_run_end":
      return fleetStore.recordRunEnd({
        run_id: requiredString(args.run_id, "run_id"),
        status: requiredRunEndStatus(args.status),
        summary: args.summary,
      });
    case "get_run":
      return fleetStore.getRun(requiredString(args.run_id, "run_id"));
    case "signal_intent":
      return fleetStore.signalIntent({
        target_agent: requiredString(args.target_agent, "target_agent"),
        kind: requiredString(args.kind, "kind"),
        payload: args.payload,
        source_agent: asOptionalString(args.source_agent) ?? undefined,
      });
    case "consume_open_intents":
      return fleetStore.consumeOpenIntents({
        agent_name: requiredString(args.agent_name, "agent_name"),
        limit: asNumberOrNull(args.limit) ?? undefined,
      });
    case "queue_local_task":
      return fleetStore.queueLocalTask({
        kind: requiredString(args.kind, "kind"),
        payload: args.payload,
        description: asOptionalString(args.description) ?? undefined,
        source: asOptionalString(args.source) ?? undefined,
        dedup_key: asOptionalString(args.dedup_key) ?? undefined,
        ttl_seconds: asNumberOrNull(args.ttl_seconds) ?? undefined,
      });
    case "get_local_task":
      return fleetStore.getLocalTask(requiredString(args.task_id, "task_id"));
    case "list_local_tasks":
      return fleetStore.listLocalTasks({
        status: asOptionalString(args.status) ?? undefined,
        kind: asOptionalString(args.kind) ?? undefined,
        limit: asNumberOrNull(args.limit) ?? undefined,
      });
    case "request_capability":
      return fleetStore.requestCapability({
        capability: requiredString(args.capability, "capability"),
        justification: requiredString(args.justification, "justification"),
        requested_by: asOptionalString(args.requested_by) ?? undefined,
        repo: asOptionalString(args.repo) ?? undefined,
        move_id: asNumberOrNull(args.move_id) ?? undefined,
      });
    default:
      throw rpcError(-32601, `Unknown tool: ${name}`);
  }
}

function requiredRunEndStatus(value: unknown): "success" | "error" | "cancelled" {
  if (value === "success" || value === "error" || value === "cancelled") return value;
  throw rpcError(-32602, "status must be one of success, error, cancelled");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw rpcError(-32602, `${field} is required`);
}

function parseRpcRequest(body: string): JsonRpcRequest {
  try {
    const parsed = JSON.parse(body) as JsonRpcRequest;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    return parsed;
  } catch {
    throw rpcError(-32700, "Parse error");
  }
}

function sendJsonRpcResult(
  res: ServerResponse,
  id: string | number | null,
  result: unknown,
  sessionId?: string | null,
) {
  const payload = {
    jsonrpc: "2.0",
    id,
    result,
  };
  sendJson(res, 200, payload, sessionId);
}

function sendJsonRpcError(
  res: ServerResponse,
  id: string | number | null,
  error: JsonRpcErrorShape,
  sessionId?: string | null,
) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error,
  };
  sendJson(res, 200, payload, sessionId);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown, sessionId?: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const session = normalizeSessionId(sessionId);
  if (session) headers["Mcp-Session-Id"] = session;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function sendNoContent(res: ServerResponse, sessionId?: string | null) {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  const session = normalizeSessionId(sessionId);
  if (session) headers["Mcp-Session-Id"] = session;
  res.writeHead(204, headers);
  res.end();
}

function sendPlain(res: ServerResponse, statusCode: number, message: string) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return null;
}

function normalizeAuthToken(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isAuthorized(req: IncomingMessage, expectedToken: string | null): boolean {
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const token = extractBearerToken(value);
  return token === expectedToken;
}

function nowIso(): string {
  return new Date().toISOString();
}

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

function asNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function asInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buf);
    const total = chunks.reduce((sum, item) => sum + item.length, 0);
    if (total > 1_000_000) {
      throw rpcError(-32600, "Request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function rpcError(code: number, message: string, data?: unknown): JsonRpcErrorShape {
  return { code, message, data };
}

function asRpcError(error: unknown): JsonRpcErrorShape {
  const maybe = asRecord(error);
  if (typeof maybe.code === "number" && typeof maybe.message === "string") {
    return { code: maybe.code, message: maybe.message, data: maybe.data };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: -32000, message };
}
