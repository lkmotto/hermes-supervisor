#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import initSqlJs from "sql.js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RISK_METADATA, evaluateToolPolicy, type RiskMetadata } from "./policy.js";
import { redactSecrets, redactMetadata } from "./redact.js";
import { FleetClient } from "./fleet.js";

// ─── Version + build provenance (sourced from package/build metadata) ──

function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgRaw = readFileSync(join(here, "..", "package.json"), "utf8");
    const version = JSON.parse(pkgRaw).version;
    if (typeof version === "string" && version.length > 0) return version;
  } catch {
    // fall through to default
  }
  return "0.0.0";
}

const VERSION = resolveVersion();

interface BuildInfo {
  name: string;
  version: string;
  commit: string;
  ref: string;
  repository: string;
  builtAt: string;
}

function resolveBuildInfo(): BuildInfo {
  const fallback: BuildInfo = {
    name: "hermes-supervisor",
    version: VERSION,
    commit: process.env.HERMES_BUILD_COMMIT ?? "unknown",
    ref: process.env.HERMES_BUILD_REF ?? "unknown",
    repository: "https://github.com/lkmotto/hermes-supervisor",
    builtAt: "unknown",
  };
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "build-info.json"), "utf8");
    const bi = JSON.parse(raw) as Partial<BuildInfo>;
    return {
      name: bi.name ?? fallback.name,
      version: bi.version ?? VERSION,
      commit: bi.commit ?? fallback.commit,
      ref: bi.ref ?? fallback.ref,
      repository: bi.repository ?? fallback.repository,
      builtAt: bi.builtAt ?? fallback.builtAt,
    };
  } catch {
    return fallback;
  }
}

const BUILD_INFO = resolveBuildInfo();

// ─── Config ────────────────────────────────────────────────────────

const HOSTINGER_TOKEN = process.env.HOSTINGER_API_TOKEN ?? "";
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY ?? "";
const HOSTINGER_API_BASE = "https://developers.hostinger.com";
const VPS_ID = parseInt(process.env.HERMES_VPS_ID ?? "1511806", 10);
const DB_PATH = process.env.HERMES_DB_PATH ?? "./hermes.db";
const FLEET_AGENT_NAME = process.env.HERMES_FLEET_AGENT_NAME?.trim() || "hermes";
const FLEET_AUTONOMY_LEVEL = process.env.HERMES_AUTONOMY_LEVEL?.trim() || "managed";
const FLEET_CONTROL_PLANE = new FleetClient({
  baseUrl: process.env.MOTTO_MCP_URL ?? "",
  authToken: process.env.MOTTO_MCP_AUTH_TOKEN ?? "",
});

// ─── SQLite via sql.js (debounced persist for speed) ───────────────

let db: initSqlJs.Database;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveDb() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDb(); saveTimer = null; }, 5000);
}

async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)");
  saveDb();
}

// ─── HTTP helpers ──────────────────────────────────────────────────

async function hostingerGet(path: string) {
  const res = await fetch(`${HOSTINGER_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${HOSTINGER_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Hostinger ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hostingerPost(path: string, body?: unknown) {
  const res = await fetch(`${HOSTINGER_API_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HOSTINGER_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Hostinger ${res.status}: ${await res.text()}`);
  return res.json();
}

async function perplexityResearch(query: string) {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${PERPLEXITY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sonar-pro",
      messages: [
        { role: "system", content: "You are a research assistant for a project manager agent. Provide thorough, well-structured answers with citations. Be precise and factual." },
        { role: "user", content: query },
      ],
      max_tokens: 4000,
    }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Fleet lifecycle integration helpers ──────────────────────────

interface FleetHeartbeatStatus {
  mode: string;
  autonomy_level: string;
  current_process_focus: string;
  last_learn_cycle: string;
  pending_approvals: number;
  blocked_capabilities: string[];
}

interface FleetFailureRecord {
  operation: string;
  correlation_id: string;
  run_id: string | null;
  error: string;
  queued_at: string;
  status: "pending_retry";
}

interface BusinessManagementCycleArgs {
  objective: string;
  correlation_id?: string;
  observations?: unknown[];
  plan?: unknown;
  proposed_actions?: unknown[];
  capability_gaps?: unknown[];
  validation_evidence?: unknown;
  learnings?: unknown[];
  pending_approvals?: number;
  blocked_capabilities?: unknown[];
}

const fleetLifecycleState = {
  startupAttempted: false,
  startupHeartbeatAt: null as string | null,
  lastLearnCycle: null as string | null,
  pendingApprovals: 0,
  blockedCapabilities: [] as string[],
  pendingRetries: [] as FleetFailureRecord[],
  lastError: null as string | null,
};

let fleetRegistrationPromise: Promise<void> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeCorrelationId(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : `VALIDATION-FLEET-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function currentBlockedCapabilities(extra: string[] = []): string[] {
  const blocked = new Set<string>([...fleetLifecycleState.blockedCapabilities, ...extra]);
  if (!FLEET_CONTROL_PLANE.isConfigured()) blocked.add("motto_fleet_control_plane_unconfigured");
  if (fleetLifecycleState.pendingRetries.length > 0) blocked.add("fleet_write_pending_retry");
  return [...blocked];
}

function buildHeartbeatStatus(mode: string, currentProcessFocus: string): FleetHeartbeatStatus {
  return {
    mode: redactSecrets(mode),
    autonomy_level: redactSecrets(FLEET_AUTONOMY_LEVEL),
    current_process_focus: redactSecrets(currentProcessFocus),
    last_learn_cycle: fleetLifecycleState.lastLearnCycle ?? "never",
    pending_approvals: fleetLifecycleState.pendingApprovals,
    blocked_capabilities: currentBlockedCapabilities(),
  };
}

function persistFleetRetry(record: FleetFailureRecord) {
  try {
    const content = redactSecrets(`Fleet write pending retry for ${record.operation} [${record.correlation_id}]`);
    const metadata = JSON.stringify(redactMetadata(record));
    db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
      [randomUUID(), "capability_gap", content, metadata]);
    scheduleSave();
  } catch {
    // Persistence is best-effort and should not block the call path.
  }
}

function queueFleetRetry(operation: string, correlationId: string, runId: string | null, error: unknown) {
  const record: FleetFailureRecord = {
    operation,
    correlation_id: correlationId,
    run_id: runId,
    error: redactSecrets(error instanceof Error ? error.message : String(error)),
    queued_at: nowIso(),
    status: "pending_retry",
  };
  fleetLifecycleState.pendingRetries.push(record);
  if (fleetLifecycleState.pendingRetries.length > 25) {
    fleetLifecycleState.pendingRetries.shift();
  }
  fleetLifecycleState.lastError = record.error;
  persistFleetRetry(record);
}

async function ensureFleetRegistered(): Promise<void> {
  if (!FLEET_CONTROL_PLANE.isConfigured()) {
    throw new Error("MOTTO_MCP_URL or MOTTO_MCP_AUTH_TOKEN is missing.");
  }
  if (!fleetRegistrationPromise) {
    fleetRegistrationPromise = (async () => {
      await FLEET_CONTROL_PLANE.registerAgent({
        name: FLEET_AGENT_NAME,
        kind: "variable",
        deploy_target: "hostinger:8150",
        version: VERSION,
      });
    })();
  }
  try {
    await fleetRegistrationPromise;
  } catch (error) {
    fleetRegistrationPromise = null;
    throw error;
  }
}

async function sendFleetHeartbeat(mode: string, currentProcessFocus: string): Promise<void> {
  const status = buildHeartbeatStatus(mode, currentProcessFocus);
  await FLEET_CONTROL_PLANE.heartbeat(FLEET_AGENT_NAME, status);
  if (mode === "startup") {
    fleetLifecycleState.startupHeartbeatAt = nowIso();
  }
}

async function ensureFleetStartupLifecycle(): Promise<void> {
  if (fleetLifecycleState.startupAttempted && fleetLifecycleState.startupHeartbeatAt) return;
  const correlationId = normalizeCorrelationId("STARTUP");
  fleetLifecycleState.startupAttempted = true;
  try {
    await ensureFleetRegistered();
    await sendFleetHeartbeat("startup", "service_bootstrap");
  } catch (error) {
    queueFleetRetry("startup_registration_or_heartbeat", correlationId, null, error);
  }
}

function buildStructuredPlan(args: BusinessManagementCycleArgs, correlationId: string, observedAt: string) {
  const observations = asArray(args.observations);
  const proposedActions = asArray(args.proposed_actions);
  const capabilityGaps = asArray(args.capability_gaps);
  const planInput = args.plan;
  if (planInput && typeof planInput === "object" && !Array.isArray(planInput)) {
    return {
      ...asRecord(planInput),
      correlation_id: correlationId,
      generated_at: observedAt,
    };
  }
  if (typeof planInput === "string" && planInput.trim().length > 0) {
    return {
      correlation_id: correlationId,
      generated_at: observedAt,
      objective: args.objective,
      narrative: redactSecrets(planInput),
    };
  }
  return {
    correlation_id: correlationId,
    generated_at: observedAt,
    objective: args.objective,
    summary: "Structured plan synthesized from cycle inputs.",
    next_steps: [
      { step: "Review observations", count: observations.length, priority: "high", status: "ready" },
      { step: "Execute proposed actions", count: proposedActions.length, priority: "high", status: "awaiting_approval" },
      { step: "Address capability gaps", count: capabilityGaps.length, priority: "medium", status: "blocked" },
      { step: "Capture learning outcomes", priority: "medium", status: "ready" },
    ],
  };
}

// ─── Tool definitions ──────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "research",
    description: "Deep research using Perplexity Sonar Pro. Returns thorough answers with citations.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Research question or topic" } },
      required: ["query"],
    },
  },
  {
    name: "vps_info",
    description: "Get detailed information about the Hostinger VPS including state, resources, IPs, and configuration.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vps_metrics",
    description: "Get CPU, RAM, and disk usage metrics for the VPS.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Days of metrics (default 1)", default: 1 } },
    },
  },
  {
    name: "vps_projects",
    description: "List all Docker Compose projects running on the VPS.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vps_project_logs",
    description: "Get recent logs from a Docker Compose project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name" } },
      required: ["project"],
    },
  },
  {
    name: "vps_restart_project",
    description: "Restart a Docker Compose project on the VPS.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name" } },
      required: ["project"],
    },
  },
  {
    name: "vps_stop_project",
    description: "Stop a Docker Compose project on the VPS.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name" } },
      required: ["project"],
    },
  },
  {
    name: "vps_start_project",
    description: "Start a stopped Docker Compose project on the VPS.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name" } },
      required: ["project"],
    },
  },
  {
    name: "vps_deploy",
    description: "Deploy a new Docker Compose project to the VPS.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (alphanumeric, dashes, underscores)" },
        compose_content: { type: "string", description: "Docker Compose YAML content, or URL to docker-compose.yml/GitHub repo" },
        environment: { type: "string", description: "Environment variables (KEY=VALUE, one per line)" },
      },
      required: ["name", "compose_content"],
    },
  },
  {
    name: "vps_snapshot",
    description: "Create a VPS snapshot for backup. Overwrites any existing snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vps_restart",
    description: "Full restart of the VPS (stop + start).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_store",
    description: "Store a fact, decision, or knowledge in persistent memory.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Category: decision, fact, project, learning" },
        content: { type: "string", description: "Content to remember" },
        metadata: { type: "object", description: "Optional structured metadata" },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "memory_recall",
    description: "Search memory for past facts, decisions, or knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" },
        query: { type: "string", description: "Search term in content" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
    },
  },
  {
    name: "plan",
    description: "Create a structured execution plan using Perplexity research. Stores the plan in memory.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The high-level goal" },
        context: { type: "string", description: "Additional context or constraints" },
      },
      required: ["goal"],
    },
  },
  {
    name: "business_management_cycle",
    description: "Run a structured business-management cycle that writes fleet run boundaries, heartbeats, events, and artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Cycle objective or focus area." },
        correlation_id: { type: "string", description: "Validation correlation ID shared across all generated fleet records." },
        observations: { type: "array", items: { type: "object" }, description: "Observed business signals for this cycle." },
        plan: { type: "object", description: "Optional structured plan payload. If omitted, Hermes synthesizes one." },
        proposed_actions: { type: "array", items: { type: "object" }, description: "Proposed actions for this cycle." },
        capability_gaps: { type: "array", items: { type: "object" }, description: "Capability blockers and missing prerequisites." },
        validation_evidence: {
          oneOf: [
            { type: "array", items: { type: "object" } },
            { type: "object" },
          ],
          description: "Validation evidence entries tied to this cycle.",
        },
        learnings: { type: "array", items: { type: "object" }, description: "Learnings captured from the cycle." },
        pending_approvals: { type: "number", description: "Count of pending approvals associated with the cycle." },
        blocked_capabilities: { type: "array", items: { type: "string" }, description: "Currently blocked capabilities for heartbeat metadata." },
      },
      required: ["objective"],
    },
  },
  {
    name: "fleet_get_run_details",
    description: "Retrieve a fleet run and parse structured artifact bodies recorded by Hermes.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Fleet run UUID to fetch via the control plane." },
      },
      required: ["run_id"],
    },
  },
];

// ─── Risk metadata decoration (visible in tools/list) ──────────────

interface RiskAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  riskLevel: string;
  confirmationRequired: boolean;
  approvalRequired: boolean;
}

type HermesTool = Tool & { risk: RiskMetadata; annotations: RiskAnnotations };

const POLICY_FIELD_SCHEMAS: Record<string, { type: string; description: string }> = {
  confirm: {
    type: "boolean",
    description: "Required for mutating tools. Must be true to proceed; calls without it fail closed with no state change.",
  },
  approval: {
    type: "object",
    description: "Explicit approval provenance (e.g. {approved_by, reason, policy}). Required for dangerous/global actions and non-Hermes project control.",
  },
  validation_id: {
    type: "string",
    description: "Validation correlation ID. Required for Hermes-scoped redeploy/restart.",
  },
  validation_evidence: {
    type: "object",
    description: "Current source validation evidence {commit, build_passed:true} matching the deployed commit. Required for Hermes-scoped redeploy/restart.",
  },
};

function policyFieldsFor(name: string): string[] {
  const meta = RISK_METADATA[name];
  if (!meta?.mutating) return [];
  if (meta.scope === "global") return ["confirm", "approval"];
  return ["confirm", "approval", "validation_id", "validation_evidence"];
}

function decorateTool(tool: Tool): HermesTool {
  const meta: RiskMetadata = RISK_METADATA[tool.name] ?? {
    level: "read-only", mutating: false, confirmation_required: false,
    approval_required: false, scope: "read", summary: "",
  };

  const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema)) as {
    type: string; properties?: Record<string, unknown>; required?: string[];
  };
  if (meta.mutating) {
    inputSchema.properties = inputSchema.properties ?? {};
    for (const field of policyFieldsFor(tool.name)) {
      if (!(field in inputSchema.properties)) {
        inputSchema.properties[field] = POLICY_FIELD_SCHEMAS[field];
      }
    }
  }

  return {
    ...tool,
    inputSchema: inputSchema as Tool["inputSchema"],
    risk: meta,
    annotations: {
      title: tool.name,
      readOnlyHint: !meta.mutating && meta.scope === "read",
      destructiveHint: meta.level === "dangerous-global-mutation",
      idempotentHint: false,
      openWorldHint: meta.scope !== "memory",
      riskLevel: meta.level,
      confirmationRequired: meta.confirmation_required,
      approvalRequired: meta.approval_required,
    },
  };
}

const publicTools: HermesTool[] = tools.map(decorateTool);

// ─── Tool handlers ─────────────────────────────────────────────────

async function handleResearch(args: { query: string }) {
  const result = await perplexityResearch(args.query);
  const content = result.choices?.[0]?.message?.content ?? JSON.stringify(result);
  return { content: [{ type: "text", text: content }] };
}

async function handleVpsInfo() {
  const vm = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}`);
  return { content: [{ type: "text", text: JSON.stringify(vm, null, 2) }] };
}

async function handleVpsMetrics(args: { days?: number }) {
  const days = args.days ?? 1;
  const to = new Date().toISOString();
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const m = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}/metrics?date_from=${from}&date_to=${to}`);
  return { content: [{ type: "text", text: JSON.stringify(m, null, 2) }] };
}

async function handleVpsProjects() {
  const p = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}/docker`);
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
}

async function handleVpsProjectLogs(args: { project: string }) {
  const l = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}/docker/${args.project}/logs`);
  return { content: [{ type: "text", text: JSON.stringify(l, null, 2) }] };
}

async function handleVpsRestartProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/docker/${args.project}/restart`);
  return { content: [{ type: "text", text: `Project "${args.project}" restart initiated.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsStopProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/docker/${args.project}/stop`);
  return { content: [{ type: "text", text: `Project "${args.project}" stopped.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsStartProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/docker/${args.project}/start`);
  return { content: [{ type: "text", text: `Project "${args.project}" started.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsDeploy(args: { name: string; compose_content: string; environment?: string }) {
  const body: Record<string, unknown> = { project_name: args.name, content: args.compose_content };
  if (args.environment) body.environment = args.environment;
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/docker`, body);
  return { content: [{ type: "text", text: `Project "${args.name}" deploying.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsSnapshot() {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/snapshot`);
  return { content: [{ type: "text", text: `Snapshot initiated.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsRestart() {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/restart`);
  return { content: [{ type: "text", text: `VPS restart initiated.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleMemoryStore(args: { category: string; content: string; metadata?: Record<string, unknown> }) {
  const id = randomUUID();
  const safeContent = redactSecrets(args.content);
  const safeMetadata = JSON.stringify(redactMetadata(args.metadata ?? {}));
  db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
    [id, args.category, safeContent, safeMetadata]);
  scheduleSave();
  return { content: [{ type: "text", text: `Memory stored [${id}] in "${args.category}"` }] };
}

async function handleMemoryRecall(args: { category?: string; query?: string; limit?: number }) {
  const limit = args.limit ?? 20;
  let stmt: ReturnType<typeof db.prepare>;
  let params: unknown[] = [];

  if (args.category && args.query) {
    stmt = db.prepare("SELECT * FROM memories WHERE category = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?");
    params = [args.category, `%${args.query}%`, limit];
  } else if (args.category) {
    stmt = db.prepare("SELECT * FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT ?");
    params = [args.category, limit];
  } else if (args.query) {
    stmt = db.prepare("SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?");
    params = [`%${args.query}%`, limit];
  } else {
    stmt = db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?");
    params = [limit];
  }
  const rows: unknown[] = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

async function handlePlan(args: { goal: string; context?: string }) {
  const query = `Create a structured execution plan for this goal. Break into phases with acceptance criteria and deliverables.

Goal: ${args.goal}
${args.context ? `Context: ${args.context}` : ""}

Format: numbered phases with name, acceptance criteria, deliverables, risks, and effort estimate.`;

  const result = await perplexityResearch(query);
  const planText = result.choices?.[0]?.message?.content ?? "Plan generation failed";

  const id = randomUUID();
  const planRecord = redactSecrets(`## Plan: ${args.goal}\n\n${planText}`);
  const safeMetadata = JSON.stringify(redactMetadata({ goal: args.goal, context: args.context ?? "" }));
  db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
    [id, "plan", planRecord, safeMetadata]);
  scheduleSave();

  return { content: [{ type: "text", text: `${planRecord}\n\n---\nStored [${id}]` }] };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function validationEvidenceEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

async function handleBusinessManagementCycle(args: BusinessManagementCycleArgs) {
  const objective = redactSecrets((args.objective ?? "").trim());
  if (!objective) {
    return { content: [{ type: "text", text: "Error: objective is required" }], isError: true };
  }

  const correlationId = normalizeCorrelationId(args.correlation_id);
  const observedAt = nowIso();
  fleetLifecycleState.pendingApprovals = asNonNegativeInt(args.pending_approvals, 0);
  fleetLifecycleState.blockedCapabilities = asStringArray(args.blocked_capabilities);

  await ensureFleetStartupLifecycle();
  if (!FLEET_CONTROL_PLANE.isConfigured()) {
    const message = "Fleet control plane is not configured; set MOTTO_MCP_URL and MOTTO_MCP_AUTH_TOKEN.";
    queueFleetRetry("cycle_preflight", correlationId, null, message);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "degraded", correlation_id: correlationId, reason: message }, null, 2) }],
      isError: true,
    };
  }

  try {
    await ensureFleetRegistered();
  } catch (error) {
    queueFleetRetry("register_agent", correlationId, null, error);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "degraded", correlation_id: correlationId, reason: "Failed to register Hermes with fleet." }, null, 2) }],
      isError: true,
    };
  }

  try {
    await sendFleetHeartbeat("cycle_start", objective);
  } catch (error) {
    queueFleetRetry("heartbeat_cycle_start", correlationId, null, error);
  }

  let runId: string | null = null;
  try {
    const runStart = await FLEET_CONTROL_PLANE.recordRunStart({
      agent_name: FLEET_AGENT_NAME,
      kind: "business-management-cycle",
      intent: `${objective} [${correlationId}]`,
    });
    runId = String(asRecord(runStart).run_id ?? "");
    if (!runId) throw new Error("record_run_start did not return run_id");
  } catch (error) {
    queueFleetRetry("record_run_start", correlationId, null, error);
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "degraded", correlation_id: correlationId, reason: "Failed to start fleet run." }, null, 2) }],
      isError: true,
    };
  }

  const plan = buildStructuredPlan(args, correlationId, observedAt);
  const observations = asArray(args.observations);
  const proposedActions = asArray(args.proposed_actions);
  const capabilityGaps = asArray(args.capability_gaps);
  const validationEvidence = validationEvidenceEntries(args.validation_evidence);
  const learnings = asArray(args.learnings);

  const sectionPayloads: Array<{ section: string; event_kind: string; artifact_kind: string; data: unknown; level?: string }> = [
    { section: "observations", event_kind: "cycle.observations", artifact_kind: "business_observations", data: observations },
    { section: "plan", event_kind: "cycle.plan", artifact_kind: "business_plan", data: plan },
    { section: "proposed_actions", event_kind: "cycle.proposed_actions", artifact_kind: "business_proposed_actions", data: proposedActions },
    { section: "capability_gaps", event_kind: "cycle.capability_gaps", artifact_kind: "business_capability_gaps", data: capabilityGaps, level: "warn" },
    { section: "validation_evidence", event_kind: "cycle.validation_evidence", artifact_kind: "business_validation_evidence", data: validationEvidence },
    { section: "learnings", event_kind: "cycle.learnings", artifact_kind: "business_learnings", data: learnings },
  ];

  const emittedSections: Array<Record<string, unknown>> = [];
  const cycleErrors: string[] = [];

  for (const section of sectionPayloads) {
    const eventPayload = {
      correlation_id: correlationId,
      objective,
      section: section.section,
      generated_at: observedAt,
      run_id: runId,
      data: section.data,
    };

    let eventId: number | null = null;
    try {
      const eventRes = await FLEET_CONTROL_PLANE.recordEvent({
        agent_name: FLEET_AGENT_NAME,
        kind: section.event_kind,
        payload: eventPayload,
        run_id: runId,
        level: section.level ?? "info",
      });
      const rawEventId = asRecord(eventRes).event_id;
      eventId = typeof rawEventId === "number" ? rawEventId : null;
    } catch (error) {
      const msg = `record_event(${section.section}) failed`;
      cycleErrors.push(msg);
      queueFleetRetry(msg, correlationId, runId, error);
    }

    let artifactId: number | null = null;
    const artifactBody = JSON.stringify(eventPayload, null, 2);
    try {
      const artifactRes = await FLEET_CONTROL_PLANE.recordArtifactContent({
        agent_name: FLEET_AGENT_NAME,
        kind: section.artifact_kind,
        name: `${correlationId}-${section.section}.json`,
        body: artifactBody,
        run_id: runId,
        intent: objective,
        repo: BUILD_INFO.repository,
        meta: {
          correlation_id: correlationId,
          run_id: runId,
          section: section.section,
          structured: true,
          generated_at: observedAt,
        },
      });
      const rawArtifactId = asRecord(artifactRes).artifact_id;
      artifactId = typeof rawArtifactId === "number" ? rawArtifactId : null;
    } catch (error) {
      const msg = `record_artifact_content(${section.section}) failed`;
      cycleErrors.push(msg);
      queueFleetRetry(msg, correlationId, runId, error);
    }

    emittedSections.push({
      section: section.section,
      event_id: eventId,
      artifact_id: artifactId,
      body_format: "json",
    });
  }

  const businessPmOutput = {
    correlation_id: correlationId,
    run_id: runId,
    objective,
    generated_at: observedAt,
    event_artifact_map: emittedSections,
    pending_retries: fleetLifecycleState.pendingRetries.filter((retry) => retry.correlation_id === correlationId),
  };

  try {
    const pmOutputRes = await FLEET_CONTROL_PLANE.recordArtifactContent({
      agent_name: FLEET_AGENT_NAME,
      kind: "business_pm_output",
      name: `${correlationId}-business-pm-output.json`,
      body: JSON.stringify(businessPmOutput, null, 2),
      run_id: runId,
      intent: objective,
      repo: BUILD_INFO.repository,
      meta: { correlation_id: correlationId, run_id: runId, section: "business_pm_output", structured: true },
    });
    emittedSections.push({
      section: "business_pm_output",
      event_id: null,
      artifact_id: asRecord(pmOutputRes).artifact_id ?? null,
      body_format: "json",
    });
  } catch (error) {
    const msg = "record_artifact_content(business_pm_output) failed";
    cycleErrors.push(msg);
    queueFleetRetry(msg, correlationId, runId, error);
  }

  const finalStatus: "success" | "error" = cycleErrors.length === 0 ? "success" : "error";

  try {
    await FLEET_CONTROL_PLANE.recordRunEnd({
      run_id: runId,
      status: finalStatus,
      summary: {
        correlation_id: correlationId,
        objective,
        emitted_sections: emittedSections,
        errors: cycleErrors,
        pending_retry_count: fleetLifecycleState.pendingRetries.filter((retry) => retry.correlation_id === correlationId).length,
      },
    });
  } catch (error) {
    queueFleetRetry("record_run_end", correlationId, runId, error);
  }

  fleetLifecycleState.lastLearnCycle = observedAt;
  try {
    await sendFleetHeartbeat(finalStatus === "success" ? "idle" : "degraded", objective);
  } catch (error) {
    queueFleetRetry("heartbeat_cycle_end", correlationId, runId, error);
  }

  const cycleResult = {
    status: finalStatus === "success" ? "ok" : "degraded",
    correlation_id: correlationId,
    run_id: runId,
    emitted_sections: emittedSections,
    errors: cycleErrors,
    heartbeat: buildHeartbeatStatus(finalStatus === "success" ? "idle" : "degraded", objective),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(redactMetadata(cycleResult), null, 2) }],
    isError: finalStatus !== "success",
  };
}

async function handleFleetGetRunDetails(args: { run_id: string }) {
  const runId = (args.run_id ?? "").trim();
  if (!runId) {
    return { content: [{ type: "text", text: "Error: run_id is required" }], isError: true };
  }
  if (!FLEET_CONTROL_PLANE.isConfigured()) {
    return { content: [{ type: "text", text: "Error: fleet control plane is not configured" }], isError: true };
  }

  try {
    const runBundle = asRecord(await FLEET_CONTROL_PLANE.getRun(runId));
    const artifacts = asArray(runBundle.artifacts).map((artifact) => {
      const artifactRecord = asRecord(artifact);
      const content = asRecord(artifactRecord.content);
      const body = typeof content.body === "string" ? content.body : "";
      return {
        ...artifactRecord,
        content: {
          ...content,
          parsed_body: typeof body === "string" && body.length > 0 ? tryParseJson(body) : null,
        },
      };
    });

    const response = {
      ...runBundle,
      artifacts,
    };
    return { content: [{ type: "text", text: JSON.stringify(redactMetadata(response), null, 2) }] };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

// ─── Dispatch: policy gate + secret redaction + audit ──────────────

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const HANDLERS: Record<string, (a: any) => Promise<ToolResult>> = {
  research: handleResearch, vps_info: handleVpsInfo, vps_metrics: handleVpsMetrics,
  vps_projects: handleVpsProjects, vps_project_logs: handleVpsProjectLogs,
  vps_restart_project: handleVpsRestartProject, vps_stop_project: handleVpsStopProject,
  vps_start_project: handleVpsStartProject, vps_deploy: handleVpsDeploy,
  vps_snapshot: handleVpsSnapshot, vps_restart: handleVpsRestart,
  memory_store: handleMemoryStore, memory_recall: handleMemoryRecall, plan: handlePlan,
  business_management_cycle: handleBusinessManagementCycle,
  fleet_get_run_details: handleFleetGetRunDetails,
};

function redactResult(result: ToolResult): ToolResult {
  return {
    ...result,
    content: result.content.map((c) =>
      c.type === "text" ? { ...c, text: redactSecrets(c.text) } : c),
  };
}

function recordMutationAudit(name: string, args: Record<string, unknown>, level: string) {
  try {
    const approval = args.approval;
    const approver = approval && typeof approval === "object"
      ? ((approval as Record<string, unknown>).approved_by ?? (approval as Record<string, unknown>).approver ?? "provided")
      : (typeof approval === "string" ? "provided" : "none");
    const evidence = args.validation_evidence as Record<string, unknown> | undefined;
    const meta = {
      tool: name,
      risk_level: level,
      project: args.project ?? args.name ?? null,
      validation_id: args.validation_id ?? null,
      validated_commit: evidence?.commit ?? null,
      approver,
      deployed_commit: BUILD_INFO.commit,
      at: new Date().toISOString(),
    };
    db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
      [randomUUID(), "deployment", redactSecrets(`Authorized ${level} action via ${name}`), redactSecrets(JSON.stringify(meta))]);
    scheduleSave();
  } catch {
    // audit must never block or fail the action
  }
}

async function dispatchTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const policy = evaluateToolPolicy(name, args, { buildCommit: BUILD_INFO.commit });
  if (!policy.allowed && policy.denial) {
    return { content: [{ type: "text", text: JSON.stringify(policy.denial, null, 2) }], isError: true };
  }
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Error: Unknown tool: ${name}` }], isError: true };
  }
  if (RISK_METADATA[name]?.mutating) recordMutationAudit(name, args, policy.effective_level);
  try {
    const result = await handler(args);
    return redactResult(result);
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

// ─── Server ────────────────────────────────────────────────────────

const server = new Server(
  { name: "hermes-supervisor", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: publicTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await dispatchTool(name, args);
});

// ─── Entrypoint ────────────────────────────────────────────────────

async function main() {
  await initDb();
  await ensureFleetStartupLifecycle();

  const argv = process.argv.slice(2);
  const useHttp = argv.includes("--http");
  const host = argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : "0.0.0.0";
  const port = argv.includes("--port") ? parseInt(argv[argv.indexOf("--port") + 1], 10) : 8150;

  if (useHttp) {
    console.error(`Hermes MCP starting on http://${host}:${port}`);
    const { createServer } = await import("node:http");
    const httpServer = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          name: "hermes-supervisor",
          version: VERSION,
          commit: BUILD_INFO.commit,
          ref: BUILD_INFO.ref,
          repository: BUILD_INFO.repository,
          builtAt: BUILD_INFO.builtAt,
        }));
        return;
      }

      if (req.method === "POST") {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString();
          const rpc = JSON.parse(raw);

          const result = await handleRpc(rpc);

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          const errorResult = {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message },
          };
          res.write(`event: message\ndata: ${JSON.stringify(errorResult)}\n\n`);
          res.end();
        }
        return;
      }

      // GET: SSE stream placeholder (required by MCP spec)
      if (req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(":ok\n\n");
        res.end();
        return;
      }

      res.writeHead(405);
      res.end();
    });
    httpServer.listen(port, host);
    console.error(`Hermes MCP ready on ${host}:${port}`);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Hermes MCP running (stdio)");
  }
}

type RpcRequest = { jsonrpc: string; id: number | string; method: string; params?: Record<string, unknown> };

async function handleRpc(rpc: RpcRequest) {
  switch (rpc.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "hermes-supervisor",
            version: VERSION,
            commit: BUILD_INFO.commit,
            ref: BUILD_INFO.ref,
            repository: BUILD_INFO.repository,
          },
        },
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { tools: publicTools },
      };
    case "tools/call": {
      const params = rpc.params as { name: string; arguments?: Record<string, unknown> };
      const result = await dispatchTool(params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id: rpc.id, result };
    }
    case "notifications/initialized":
      return { jsonrpc: "2.0", id: rpc.id, result: {} };
    default:
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Unknown method: ${rpc.method}` },
      };
  }
}

process.on("SIGTERM", () => { if (saveTimer) { clearTimeout(saveTimer); saveDb(); } process.exit(0); });
process.on("SIGINT", () => { if (saveTimer) { clearTimeout(saveTimer); saveDb(); } process.exit(0); });
main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
