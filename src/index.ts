#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import initSqlJs from "sql.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RISK_METADATA, evaluateToolPolicy, type RiskMetadata } from "./policy.js";
import { redactSecrets, redactMetadata } from "./redact.js";
import { FleetClient } from "./fleet.js";
import { TelegramBot, type TelegramBotCallbacks } from "./telegram.js";
import { listSessions, getSession, getSessionMessages, createMission } from "./factory-client.js";

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
const MCP_PROTOCOL_VERSION = "2025-06-18";

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
const HERMES_MCP_AUTH_TOKEN = (process.env.HERMES_MCP_AUTH_TOKEN ?? "").trim();
const FACTORY_API_KEY = (process.env.FACTORY_API_KEY ?? "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.HERMES_TELE_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const MOTTO_SKILLS_TOOLS_DIR = process.env.MOTTO_SKILLS_TOOLS_DIR?.trim() || "/root/motto-skills/tools";
const MOTTO_KNOWLEDGE_DIR = process.env.MOTTO_KNOWLEDGE_DIR?.trim() || join(homedir(), ".factory", "knowledge");
const WF1_PROMPT_PATH = "/root/missions/neon-wf1/prompts/wf1_prompt.md";
const ORDER_INTAKE_WORKER_PATH = "/opt/motto-skills/workers/order-intake/src/index.js";
const FLEET_CONTROL_PLANE = new FleetClient({
  baseUrl: process.env.MOTTO_MCP_URL ?? "",
  authToken: process.env.MOTTO_MCP_AUTH_TOKEN ?? "",
  protocolVersion: MCP_PROTOCOL_VERSION,
  clientInfo: { name: "hermes-supervisor", version: VERSION },
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
  failure_surface: "fleet" | "knowledge_store";
}

// FleetFailureRecord covers both fleet and knowledge-store retry entries.
// Maintained as separate queues in state for operational clarity but share the same schema.

interface CoordinationIntentRequest {
  target_agent: string;
  kind: string;
  payload?: Record<string, unknown>;
  source_agent?: string;
}

interface LocalTaskRequest {
  kind: string;
  payload: Record<string, unknown>;
  description?: string;
  source?: string;
  dedup_key?: string;
  ttl_seconds?: number;
}

interface CapabilityRequest {
  capability: string;
  justification: string;
  requested_by?: string;
  repo?: string;
  move_id?: number;
}

interface SimulateFailuresConfig {
  fleet_operations?: string[];
  fleet_sections?: string[];
  knowledge_operations?: string[];
  knowledge_store?: boolean;
}

interface BusinessManagementCycleArgs {
  objective: string;
  correlation_id?: string;
  observations?: unknown[];
  plan?: unknown;
  proposed_actions?: unknown[];
  capability_gaps?: unknown[];
  coordination_intents?: unknown[];
  local_tasks?: unknown[];
  capability_requests?: unknown[];
  consume_intents_limit?: number;
  simulate_failures?: SimulateFailuresConfig;
  validation_evidence?: unknown;
  learnings?: unknown[];
  pending_approvals?: number;
  blocked_capabilities?: unknown[];
  ingest_completed_local_tasks?: boolean;
  local_task_ingest_limit?: number;
  recall_bridged_limit?: number;
}

const fleetLifecycleState = {
  startupAttempted: false,
  startupHeartbeatAt: null as string | null,
  lastLearnCycle: null as string | null,
  pendingApprovals: 0,
  blockedCapabilities: [] as string[],
  pendingRetries: [] as FleetFailureRecord[],
  pendingKnowledgeRetries: [] as FleetFailureRecord[],
  lastError: null as string | null,
};

let fleetRegistrationPromise: Promise<void> | null = null;

type TypedMemoryCategory =
  | "fact"
  | "decision"
  | "project"
  | "learning"
  | "workflow"
  | "observation"
  | "capability_gap"
  | "approval_request"
  | "validation";

type ConfidenceLevel = "high" | "medium" | "low";

const TYPED_MEMORY_CATEGORIES = new Set<TypedMemoryCategory>([
  "fact",
  "decision",
  "project",
  "learning",
  "workflow",
  "observation",
  "capability_gap",
  "approval_request",
  "validation",
]);

const MEMORY_CATEGORY_ALIASES: Record<string, TypedMemoryCategory> = {
  fact: "fact",
  decision: "decision",
  project: "project",
  learning: "learning",
  workflow: "workflow",
  observation: "observation",
  capability_gap: "capability_gap",
  approval_request: "approval_request",
  validation: "validation",
  plan: "project",
  deployment: "decision",
};

interface TraceabilityOptions {
  source: string;
  correlationId?: string;
  runId?: string | null;
  taskId?: string | null;
  timestamp?: string;
  confidence?: unknown;
}

interface StoredMemoryRecord {
  id: string;
  category: TypedMemoryCategory;
  metadata: Record<string, unknown>;
}

function normalizeMemoryCategory(raw: unknown, fallback: TypedMemoryCategory = "observation"): TypedMemoryCategory {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized in MEMORY_CATEGORY_ALIASES) {
    return MEMORY_CATEGORY_ALIASES[normalized];
  }
  if (TYPED_MEMORY_CATEGORIES.has(normalized as TypedMemoryCategory)) {
    return normalized as TypedMemoryCategory;
  }
  return fallback;
}

function normalizeConfidence(raw: unknown, fallback: ConfidenceLevel = "medium"): ConfidenceLevel {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "high" || value === "medium" || value === "low") return value;
  return fallback;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

function buildTraceabilityMetadata(input: unknown, opts: TraceabilityOptions): Record<string, unknown> {
  const incoming = parseMetadata(input);
  const source = typeof incoming.source === "string" && incoming.source.trim().length > 0
    ? incoming.source
    : opts.source;
  const timestamp = typeof incoming.timestamp === "string" && incoming.timestamp.trim().length > 0
    ? incoming.timestamp
    : (opts.timestamp ?? nowIso());
  const confidence = normalizeConfidence(incoming.confidence ?? opts.confidence, "medium");
  const base: Record<string, unknown> = {
    ...incoming,
    source,
    timestamp,
    confidence,
  };
  if (opts.correlationId) base.correlation_id = opts.correlationId;
  if (opts.runId) base.run_id = opts.runId;
  if (opts.taskId) {
    base.task_id = opts.taskId;
    base.local_task_id = opts.taskId;
  }
  return redactMetadata(base) as Record<string, unknown>;
}

function storeTypedMemoryRecord(args: {
  category: unknown;
  content: string;
  metadata?: unknown;
  fallbackCategory?: TypedMemoryCategory;
  trace: TraceabilityOptions;
}): StoredMemoryRecord {
  const id = randomUUID();
  const category = normalizeMemoryCategory(args.category, args.fallbackCategory ?? "observation");
  const metadata = buildTraceabilityMetadata(args.metadata, args.trace);
  db.run(
    "INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
    [id, category, redactSecrets(args.content), JSON.stringify(metadata)],
  );
  scheduleSave();
  return { id, category, metadata };
}

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

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(normalized)) return true;
    if (["0", "false", "no", "n"].includes(normalized)) return false;
  }
  return fallback;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asIdentifier(value: unknown): string | null {
  const text = asOptionalString(value);
  if (text) return text;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

function normalizeHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeHandle(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

interface SeededWorkflowStep {
  step_number: number;
  portal: string;
  action: string;
  execution_classification: "headless-safe" | "session-bound";
}

interface OnlineSeededWorkflowAwareness {
  loaded_at: string;
  source_paths: string[];
  wf1_steps: SeededWorkflowStep[];
  order_intake_fields: string[];
  handoff_points: string[];
}

let cachedOnlineWorkflowAwareness: OnlineSeededWorkflowAwareness | null = null;

function loadOnlineWorkflowAwareness(): OnlineSeededWorkflowAwareness {
  if (cachedOnlineWorkflowAwareness) return cachedOnlineWorkflowAwareness;

  const sourcePaths: string[] = [];
  const wf1Steps: SeededWorkflowStep[] = [];
  const orderIntakeFields: string[] = [];
  const handoffPoints: string[] = [];

  if (existsSync(WF1_PROMPT_PATH)) {
    try {
      const wf1Raw = readFileSync(WF1_PROMPT_PATH, "utf8");
      sourcePaths.push(WF1_PROMPT_PATH);
      const stepRegex = /STEP\s+(\d+)\s+([^:]+):\s*(.+)/gi;
      let match: RegExpExecArray | null;
      while ((match = stepRegex.exec(wf1Raw)) !== null) {
        const stepNumber = Number.parseInt(match[1], 10);
        const portal = match[2].trim();
        const action = match[3].trim();
        const executionClassification: "headless-safe" | "session-bound"
          = /(auth|login|session|desktop|browser|mfa|gmail|matrix|taxnet|mls|comet|sharepoint)/i.test(`${portal} ${action}`)
            ? "session-bound"
            : "headless-safe";
        wf1Steps.push({
          step_number: Number.isFinite(stepNumber) ? stepNumber : wf1Steps.length + 1,
          portal,
          action: redactSecrets(action),
          execution_classification: executionClassification,
        });
      }
      for (let i = 0; i + 1 < wf1Steps.length; i += 1) {
        handoffPoints.push(`${wf1Steps[i].portal} -> ${wf1Steps[i + 1].portal}`);
      }
    } catch {
      // Best-effort seeding.
    }
  }

  if (existsSync(ORDER_INTAKE_WORKER_PATH)) {
    try {
      const orderIntakeRaw = readFileSync(ORDER_INTAKE_WORKER_PATH, "utf8");
      sourcePaths.push(ORDER_INTAKE_WORKER_PATH);
      const fieldRegex = /fields\.([a-z_]+)\s*=/g;
      let match: RegExpExecArray | null;
      while ((match = fieldRegex.exec(orderIntakeRaw)) !== null) {
        orderIntakeFields.push(match[1]);
      }
    } catch {
      // Best-effort seeding.
    }
  }

  cachedOnlineWorkflowAwareness = {
    loaded_at: nowIso(),
    source_paths: sourcePaths,
    wf1_steps: wf1Steps,
    order_intake_fields: uniqueStrings(orderIntakeFields),
    handoff_points: uniqueStrings(handoffPoints),
  };
  return cachedOnlineWorkflowAwareness;
}

type BridgeStoreType = "workflow-library" | "decision-log" | "knowledge-distiller" | "session-postmortem";

interface BridgeResult {
  store_type: BridgeStoreType;
  record_id: string;
  store_path: string;
  action: string;
  correlation_id: string;
  run_id: string | null;
  memory_id: string;
  category: TypedMemoryCategory;
}

interface LocalTaskOutcome {
  task_id: string;
  kind: string;
  status: string;
  source: string;
  finished_at: string | null;
  correlation_id: string | null;
  run_id: string | null;
  memory_id: string;
  memory_category: TypedMemoryCategory;
}

function bridgeStorePath(storeType: BridgeStoreType, recordId: string): string {
  switch (storeType) {
    case "workflow-library":
      return `${MOTTO_KNOWLEDGE_DIR}/workflows.json#${recordId}`;
    case "decision-log":
      return `${MOTTO_KNOWLEDGE_DIR}/decisions.jsonl#${recordId}`;
    case "session-postmortem":
      return `${MOTTO_KNOWLEDGE_DIR}/postmortems/${recordId}.md`;
    default:
      return `${MOTTO_KNOWLEDGE_DIR}/facts.json#${recordId}`;
  }
}

function executeMottoSkillsTool(scriptName: string, command: string, payload: Record<string, unknown>): Record<string, unknown> {
  const scriptPath = join(MOTTO_SKILLS_TOOLS_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`motto-skills tool missing: ${scriptPath}`);
  }
  // NOTE: spawnSync blocks the Node.js event loop for the duration of the
  // Python subprocess (up to 20-second timeout). Bridge calls must not be
  // placed on hot paths that require concurrent request handling. Each bridge
  // call adds N×20s of blocking if fire-and-forget semantics are unsuitable.
  const proc = spawnSync(
    "python3",
    [scriptPath, command, JSON.stringify(redactMetadata(payload))],
    {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        MOTTO_KNOWLEDGE_DIR,
      },
    },
  );
  if (proc.error) {
    throw new Error(`motto-skills ${scriptName} failed: ${proc.error.message}`);
  }
  if (typeof proc.status === "number" && proc.status !== 0) {
    throw new Error(`motto-skills ${scriptName} exit ${proc.status}: ${redactSecrets((proc.stderr ?? "").trim())}`);
  }
  const stdout = (proc.stdout ?? "").trim();
  if (!stdout) return {};
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(`motto-skills ${scriptName} returned non-JSON output`);
  }
}

function memoryAlreadyIngestedForTask(taskId: string): boolean {
  const stmt = db.prepare("SELECT id FROM memories WHERE metadata LIKE ? LIMIT 1");
  // Escape SQL LIKE wildcards (_ %) in the literal field-name portion of the pattern.
  stmt.bind([`%\"local\\_task\\_id\":\"${taskId}\"%`]);
  const found = stmt.step();
  stmt.free();
  return found;
}

function recentBridgeReferences(limit: number): Array<Record<string, unknown>> {
  const stmt = db.prepare(
    "SELECT id, category, metadata, created_at FROM memories WHERE metadata LIKE ? ORDER BY created_at DESC LIMIT ?",
  );
  // Escape SQL LIKE wildcards (_ %) in the literal field-name portion of the pattern.
  stmt.bind(["%\"bridge\\_store\\_type\"%", Math.max(1, Math.trunc(limit))]);
  const out: Array<Record<string, unknown>> = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as Record<string, unknown>;
    const metadata = parseMetadata(row.metadata);
    const storeType = asOptionalString(metadata.bridge_store_type);
    const recordId = asOptionalString(metadata.bridge_record_id);
    const storePath = asOptionalString(metadata.bridge_store_path);
    if (!storeType || !recordId || !storePath) continue;
    out.push({
      memory_id: row.id ?? null,
      category: row.category ?? null,
      bridge_store_type: storeType,
      bridge_record_id: recordId,
      bridge_store_path: storePath,
      bridge_status: metadata.bridge_status ?? "bridged",
      source: metadata.source ?? null,
      timestamp: metadata.timestamp ?? row.created_at ?? null,
      confidence: metadata.confidence ?? null,
      correlation_id: metadata.correlation_id ?? null,
      run_id: metadata.run_id ?? null,
    });
  }
  stmt.free();
  return out;
}

function restoreLearningStateFromMemory() {
  // Best-effort recovery of learning state from the most recent 50 memory records.
  // Known limitation: retry queues (pendingRetries, pendingKnowledgeRetries) are NOT
  // restored from memory on restart — they rely on in-memory arrays that reset to
  // empty. Retry-queue entries are persisted to capability_gap records for audit
  // but are not re-hydrated on startup. See persistFleetRetry/persistKnowledgeRetry.
  try {
    // Scan the most recent records, prioritizing learning-category records for
    // lastLearnCycle timestamp discovery, then all records as fallback.
    const stmt = db.prepare(
      "SELECT category, metadata, created_at FROM memories ORDER BY created_at DESC LIMIT 50",
    );
    const blocked = new Set<string>(fleetLifecycleState.blockedCapabilities);
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const metadata = parseMetadata(row.metadata);
      // Only set lastLearnCycle from learning-category records.
      if (!fleetLifecycleState.lastLearnCycle && row.category === "learning") {
        const ts = asOptionalString(metadata.timestamp)
          ?? asOptionalString(metadata.observed_at)
          ?? asOptionalString(row.created_at);
        if (ts) fleetLifecycleState.lastLearnCycle = ts;
      }
      if (row.category === "capability_gap") {
        const status = asOptionalString(metadata.status);
        if (status === "pending_retry") {
          const operation = asOptionalString(metadata.operation);
          if (operation) blocked.add("knowledge_store_pending_retry");
        }
      }
    }
    stmt.free();
    fleetLifecycleState.blockedCapabilities = [...blocked];
    // Fallback: if no learning-category records found in the scan window,
    // accept any recent record's timestamp as a rough proxy.
    if (!fleetLifecycleState.lastLearnCycle) {
      const fallbackStmt = db.prepare(
        "SELECT created_at FROM memories ORDER BY created_at DESC LIMIT 1",
      );
      if (fallbackStmt.step()) {
        const fbRow = fallbackStmt.getAsObject() as Record<string, unknown>;
        const ts = asOptionalString(fbRow.created_at);
        if (ts) fleetLifecycleState.lastLearnCycle = ts;
      }
      fallbackStmt.free();
    }
  } catch {
    // Recovery is best-effort.
  }
}

function currentBlockedCapabilities(extra: string[] = []): string[] {
  const blocked = new Set<string>([...fleetLifecycleState.blockedCapabilities, ...extra]);
  if (!FLEET_CONTROL_PLANE.isConfigured()) blocked.add("motto_fleet_control_plane_unconfigured");
  if (fleetLifecycleState.pendingRetries.length > 0) blocked.add("fleet_write_pending_retry");
  if (fleetLifecycleState.pendingKnowledgeRetries.length > 0) blocked.add("knowledge_store_pending_retry");
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
    storeTypedMemoryRecord({
      category: "capability_gap",
      content: `Fleet write pending retry for ${record.operation} [${record.correlation_id}]`,
      metadata: {
        ...record,
        failure_surface: "fleet",
      },
      trace: {
        source: "fleet_retry_queue",
        correlationId: record.correlation_id,
        runId: record.run_id,
        timestamp: record.queued_at,
        confidence: "high",
      },
    });
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
    failure_surface: "fleet",
  };
  fleetLifecycleState.pendingRetries.push(record);
  if (fleetLifecycleState.pendingRetries.length > 25) {
    fleetLifecycleState.pendingRetries.shift();
  }
  fleetLifecycleState.lastError = record.error;
  persistFleetRetry(record);
}

function persistKnowledgeRetry(record: FleetFailureRecord) {
  try {
    storeTypedMemoryRecord({
      category: "capability_gap",
      content: `Knowledge-store write pending retry for ${record.operation} [${record.correlation_id}]`,
      metadata: {
        ...record,
        failure_surface: "knowledge_store",
      },
      trace: {
        source: "knowledge_retry_queue",
        correlationId: record.correlation_id,
        runId: record.run_id,
        timestamp: record.queued_at,
        confidence: "high",
      },
    });
  } catch {
    // Persistence is best-effort and should not block the call path.
  }
}

function queueKnowledgeRetry(operation: string, correlationId: string, runId: string | null, error: unknown) {
  const record: FleetFailureRecord = {
    operation,
    correlation_id: correlationId,
    run_id: runId,
    error: redactSecrets(error instanceof Error ? error.message : String(error)),
    queued_at: nowIso(),
    status: "pending_retry",
    failure_surface: "knowledge_store",
  };
  fleetLifecycleState.pendingKnowledgeRetries.push(record);
  if (fleetLifecycleState.pendingKnowledgeRetries.length > 25) {
    fleetLifecycleState.pendingKnowledgeRetries.shift();
  }
  fleetLifecycleState.lastError = record.error;
  persistKnowledgeRetry(record);
}

/**
 * Drain pending retry queues. Called at the start of a cycle to clear
 * retries from prior cycles that are no longer actionable. Retry entries
 * are purely informational after the initial failure — actual re-attempts
 * of fleet or knowledge-store operations are not automatically retried.
 * This is a known limitation: retry queues serve as an audit trail rather
 * than an active reprocessing pipeline.
 */
function drainRetryQueues(): void {
  fleetLifecycleState.pendingRetries = [];
  fleetLifecycleState.pendingKnowledgeRetries = [];
}

/**
 * Known limitation: Fleet intents are consumed only at cycle start via
 * consumeOpenIntents. Intents that arrive mid-cycle are not re-consumed
 * until the next cycle invocation. There is no intra-cycle re-polling
 * mechanism. Callers should batch coordination intents before invoking
 * the cycle to ensure they are consumed.
 */

function shouldSimulateOperationFailure(
  simulateConfig: SimulateFailuresConfig | undefined,
  operation: string,
  section?: string,
): boolean {
  const operationMatches = asStringArray(simulateConfig?.fleet_operations).includes(operation);
  const sectionMatches = typeof section === "string"
    ? asStringArray(simulateConfig?.fleet_sections).includes(section)
    : false;
  return operationMatches || sectionMatches;
}

function persistCycleKnowledgeRecord(args: {
  correlationId: string;
  runId: string | null;
  objective: string;
  observedAt: string;
  status: "ok" | "degraded";
  consumedInboundIntents: unknown[];
  signaledIntents: unknown[];
  queuedLocalTasks: unknown[];
  ingestedLocalTaskOutcomes: unknown[];
  capabilityRequests: unknown[];
  learningMemoryRecords: unknown[];
  mottoSkillsBridges: unknown[];
  errors: string[];
  emittedSections: Array<Record<string, unknown>>;
  simulateFailures?: SimulateFailuresConfig;
}): { ok: boolean; memoryId?: string; error?: string } {
  try {
    if (args.simulateFailures?.knowledge_store) {
      throw new Error("Simulated knowledge-store write failure");
    }
    const metadata = {
      correlation_id: args.correlationId,
      run_id: args.runId,
      objective: args.objective,
      observed_at: args.observedAt,
      status: args.status,
      source: "business_management_cycle",
      consumed_intent_count: args.consumedInboundIntents.length,
      signaled_intent_count: args.signaledIntents.length,
      local_task_count: args.queuedLocalTasks.length,
      local_task_outcome_count: args.ingestedLocalTaskOutcomes.length,
      capability_request_count: args.capabilityRequests.length,
      learning_memory_count: args.learningMemoryRecords.length,
      motto_skills_bridge_count: args.mottoSkillsBridges.length,
      emitted_sections: args.emittedSections.map((section) => section.section),
      errors: args.errors,
    };
    const stored = storeTypedMemoryRecord({
      category: "validation",
      content: `Cycle knowledge persisted for ${args.correlationId} (${args.objective})`,
      metadata,
      trace: {
        source: "business_management_cycle",
        correlationId: args.correlationId,
        runId: args.runId,
        timestamp: args.observedAt,
        confidence: args.status === "ok" ? "high" : "medium",
      },
    });
    return { ok: true, memoryId: stored.id };
  } catch (error) {
    return {
      ok: false,
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

interface NormalizedLearning {
  index: number;
  category: TypedMemoryCategory;
  content: string;
  metadata: Record<string, unknown>;
  repeated: boolean;
  material: boolean;
  bridgeStoreHint: BridgeStoreType | null;
}

function parseRepeatCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function inferBridgeStoreHint(value: unknown): BridgeStoreType | null {
  const normalized = asOptionalString(value)?.toLowerCase() ?? null;
  if (!normalized) return null;
  if (["workflow", "workflow-library", "workflow_library"].includes(normalized)) return "workflow-library";
  if (["decision", "decision-log", "decision_log"].includes(normalized)) return "decision-log";
  if (["knowledge", "knowledge-distiller", "knowledge_distiller", "fact", "facts"].includes(normalized)) return "knowledge-distiller";
  if (["postmortem", "session-postmortem", "session_postmortem"].includes(normalized)) return "session-postmortem";
  return null;
}

function normalizeLearningEntries(
  rawLearnings: unknown[],
  correlationId: string,
  runId: string | null,
  observedAt: string,
): NormalizedLearning[] {
  const out: NormalizedLearning[] = [];
  for (let index = 0; index < rawLearnings.length; index += 1) {
    const source = asRecord(rawLearnings[index]);
    const content = asOptionalString(source.content)
      ?? asOptionalString(source.summary)
      ?? asOptionalString(source.learning)
      ?? asOptionalString(source.note)
      ?? "";
    if (!content) continue;
    const category = normalizeMemoryCategory(source.category ?? source.type, "learning");
    const repeated = asBool(source.repeated ?? source.is_repeated, false)
      || parseRepeatCount(source.repeat_count ?? source.repetition_count) >= 2;
    const material = asBool(source.material ?? source.is_material, false)
      || ["high", "critical", "p0", "p1"].includes((asOptionalString(source.priority) ?? "").toLowerCase())
      || ["high", "critical", "material"].includes((asOptionalString(source.impact) ?? "").toLowerCase());
    const metadata = buildTraceabilityMetadata(
      {
        ...source,
        repeated,
        material,
        observed_at: observedAt,
      },
      {
        source: asOptionalString(source.source) ?? "business_management_cycle_learning",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: source.confidence,
      },
    );
    out.push({
      index,
      category,
      content,
      metadata,
      repeated,
      material,
      bridgeStoreHint: inferBridgeStoreHint(source.bridge_store ?? source.bridge_target),
    });
  }
  return out;
}

function resolveBridgeStore(learning: NormalizedLearning): BridgeStoreType {
  if (learning.bridgeStoreHint) return learning.bridgeStoreHint;
  if (learning.category === "workflow") return "workflow-library";
  if (learning.category === "decision" || learning.category === "approval_request") return "decision-log";
  if (learning.category === "learning" && learning.bridgeStoreHint === "session-postmortem") return "session-postmortem";
  return "knowledge-distiller";
}

function bridgeLearningToMottoSkills(
  learning: NormalizedLearning,
  correlationId: string,
  runId: string | null,
  memoryId: string,
): BridgeResult {
  const storeType = resolveBridgeStore(learning);
  const metadata = learning.metadata;
  let result: Record<string, unknown>;
  if (storeType === "workflow-library") {
    const workflowName = asOptionalString(metadata.workflow_name)
      ?? asOptionalString(metadata.name)
      ?? `${correlationId.toLowerCase()}-workflow-${learning.index + 1}`;
    const workflowSteps = asArray(metadata.steps)
      .map((step, stepIndex) => {
        const s = asRecord(step);
        const name = asOptionalString(s.name) ?? asOptionalString(s.step) ?? `step-${stepIndex + 1}`;
        return {
          order: stepIndex + 1,
          name,
          description: asOptionalString(s.description) ?? undefined,
        };
      });
    const template = {
      name: workflowName,
      description: learning.content,
      steps: workflowSteps.length > 0
        ? workflowSteps
        : [{ order: 1, name: "review-learning", description: "Review and apply the captured learning." }],
      tags: asArray(metadata.tags).filter((tag): tag is string => typeof tag === "string"),
      extracted_from: [correlationId],
      source: metadata.source ?? "hermes",
      correlation_id: correlationId,
      run_id: runId,
    };
    result = executeMottoSkillsTool("workflow_library.py", "save", template);
  } else if (storeType === "decision-log") {
    const decision = {
      domain: asOptionalString(metadata.domain) ?? "hermes",
      question: asOptionalString(metadata.question) ?? `Learning decision ${correlationId} #${learning.index + 1}`,
      chosen: asOptionalString(metadata.chosen) ?? learning.content,
      rationale: asOptionalString(metadata.rationale) ?? learning.content,
      decision_class: asOptionalString(metadata.decision_class) ?? "hermes_learning_bridge",
      outcome: asOptionalString(metadata.outcome) ?? "recorded",
      session_id: correlationId,
      correlation_id: correlationId,
      run_id: runId,
    };
    result = executeMottoSkillsTool("decision_log.py", "log", decision);
  } else {
    const domain = asOptionalString(metadata.domain) ?? "hermes";
    const key = asOptionalString(metadata.key) ?? `learning-${correlationId}-${learning.index + 1}`;
    const fact = {
      domain,
      key,
      fact: learning.content,
      confidence: normalizeConfidence(metadata.confidence, "medium"),
      source: metadata.source ?? "hermes",
      tags: asArray(metadata.tags).filter((tag): tag is string => typeof tag === "string"),
      correlation_id: correlationId,
      run_id: runId,
    };
    result = executeMottoSkillsTool("knowledge_distiller.py", "capture", fact);
  }

  const item = asRecord(result.item);
  const recordId = asOptionalString(result.id)
    ?? asOptionalString(item.id)
    ?? asOptionalString(item.name)
    ?? asOptionalString(item.key)
    ?? `${correlationId}-${learning.index + 1}`;
  const action = asOptionalString(result.action) ?? "upserted";
  return {
    store_type: storeType,
    record_id: recordId,
    store_path: bridgeStorePath(storeType, recordId),
    action,
    correlation_id: correlationId,
    run_id: runId,
    memory_id: memoryId,
    category: learning.category,
  };
}

async function ingestCompletedLocalTasks(args: {
  cycleCorrelationId: string;
  runId: string | null;
  objective: string;
  observedAt: string;
  limit?: number;
}): Promise<LocalTaskOutcome[]> {
  const summaries = asArray(await FLEET_CONTROL_PLANE.listLocalTasks({ limit: args.limit ?? 50 }))
    .map((entry) => asRecord(entry));
  const completedSummaries = summaries.filter((entry) => {
    const status = (asOptionalString(entry.status) ?? "").toLowerCase();
    return ["succeeded", "failed", "cancelled"].includes(status)
      && (asOptionalString(entry.source) ?? "") === FLEET_AGENT_NAME;
  });

  const outcomes: LocalTaskOutcome[] = [];
  for (const summary of completedSummaries) {
    const taskId = asOptionalString(summary.id);
    if (!taskId || memoryAlreadyIngestedForTask(taskId)) continue;

    const detailRaw = await FLEET_CONTROL_PLANE.getLocalTask(taskId);
    const detail = asRecord(detailRaw);
    if (!detail || Object.keys(detail).length === 0) continue;
    const payload = asRecord(detail.payload ?? asRecord(detail).payload);
    const taskCorrelationId = asOptionalString(payload.correlation_id);
    const taskRunId = asOptionalString(payload.run_id);
    const status = (asOptionalString(detail.status) ?? asOptionalString(summary.status) ?? "unknown").toLowerCase();
    const kind = asOptionalString(detail.kind) ?? asOptionalString(summary.kind) ?? "local";
    const finishedAt = asOptionalString(detail.finished_at) ?? asOptionalString(summary.finished_at);
    const errorText = asOptionalString(detail.error) ?? asOptionalString(summary.error) ?? undefined;
    const resultPayload = parseMetadata(detail.result);
    const outcomeCategory: TypedMemoryCategory = status === "succeeded"
      ? (kind.includes("browser") ? "workflow" : "learning")
      : "capability_gap";
    const content = status === "succeeded"
      ? `Completed local task ${taskId} (${kind}) for objective "${args.objective}".`
      : `Local task ${taskId} (${kind}) finished with status "${status}".`;
    const stored = storeTypedMemoryRecord({
      category: outcomeCategory,
      content,
      metadata: {
        source: "local_task_completion",
        task_kind: kind,
        task_status: status,
        task_finished_at: finishedAt,
        task_result: resultPayload,
        task_error: errorText,
        objective: args.objective,
        ingested_by_correlation_id: args.cycleCorrelationId,
        originating_correlation_id: taskCorrelationId,
        originating_run_id: taskRunId,
      },
      trace: {
        source: "local_task_completion",
        correlationId: taskCorrelationId ?? args.cycleCorrelationId,
        runId: taskRunId ?? args.runId,
        taskId,
        timestamp: finishedAt ?? args.observedAt,
        confidence: status === "succeeded" ? "high" : "medium",
      },
    });
    outcomes.push({
      task_id: taskId,
      kind,
      status,
      source: asOptionalString(summary.source) ?? FLEET_AGENT_NAME,
      finished_at: finishedAt,
      correlation_id: taskCorrelationId,
      run_id: taskRunId,
      memory_id: stored.id,
      memory_category: stored.category,
    });
  }
  return outcomes;
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

function buildStructuredPlan(
  args: BusinessManagementCycleArgs,
  correlationId: string,
  observedAt: string,
  consumedInboundIntents: unknown[],
  recalledBridgeReferences: Array<Record<string, unknown>>,
) {
  const observations = asArray(args.observations);
  const proposedActions = asArray(args.proposed_actions);
  const capabilityGaps = asArray(args.capability_gaps);
  const intentIds = consumedInboundIntents
    .map((intent) => asRecord(intent).intent_id)
    .filter((intentId): intentId is string => typeof intentId === "string" && intentId.length > 0);
  const planInput = args.plan;
  if (planInput && typeof planInput === "object" && !Array.isArray(planInput)) {
    return {
      ...asRecord(planInput),
      correlation_id: correlationId,
      generated_at: observedAt,
      inbound_intent_ids: intentIds,
      bridged_knowledge_references: recalledBridgeReferences,
    };
  }
  if (typeof planInput === "string" && planInput.trim().length > 0) {
    return {
      correlation_id: correlationId,
      generated_at: observedAt,
      objective: args.objective,
      narrative: redactSecrets(planInput),
      inbound_intent_ids: intentIds,
      bridged_knowledge_references: recalledBridgeReferences,
    };
  }
  return {
    correlation_id: correlationId,
    generated_at: observedAt,
    objective: args.objective,
    summary: "Structured plan synthesized from cycle inputs.",
    inbound_intent_ids: intentIds,
    bridged_knowledge_references: recalledBridgeReferences,
    next_steps: [
      { step: "Review observations", count: observations.length, priority: "high", status: "ready" },
      { step: "Process inbound intents", count: intentIds.length, priority: "high", status: intentIds.length > 0 ? "ready" : "none" },
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
    description: "Store typed knowledge in persistent memory with traceability metadata.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Typed category: fact, decision, project, learning, workflow, observation, capability_gap, approval_request, or validation.",
        },
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
    name: "perplexity_ingest",
    description: "Ingest Perplexity research context (queries, threads, findings) into Hermes observation memory for shadow learning. Push-based fallback when direct Perplexity activity API is unavailable. Allows Hermes to watch and learn from user research activity across Perplexity threads.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Perplexity thread/conversation identifier." },
        query: { type: "string", description: "The research question or topic queried in Perplexity." },
        findings: { type: "string", description: "Key findings, answers, or summary from the Perplexity research output." },
        context: { type: "string", description: "Additional context about the research session or purpose." },
        source_url: { type: "string", description: "URL to the Perplexity thread or source (if available)." },
        correlation_id: { type: "string", description: "Optional correlation ID for traceability." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization." },
      },
      required: ["query"],
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
        coordination_intents: {
          type: "array",
          items: { type: "object" },
          description: "Cross-agent intents to emit via signal_intent (target_agent, kind, payload?, source_agent?).",
        },
        local_tasks: {
          type: "array",
          items: { type: "object" },
          description: "Local/browser/authenticated work requests queued via queue_local_task.",
        },
        capability_requests: {
          type: "array",
          items: { type: "object" },
          description: "Missing credential/tool/session requests sent via request_capability.",
        },
        consume_intents_limit: {
          type: "number",
          description: "Maximum open intents Hermes should consume for this cycle (default 10).",
          default: 10,
        },
        simulate_failures: {
          type: "object",
          description: "Validation-only failure simulation. fleet_operations/fleet_sections trigger pending retries; knowledge_store simulates memory write failure.",
          properties: {
            fleet_operations: { type: "array", items: { type: "string" } },
            fleet_sections: { type: "array", items: { type: "string" } },
            knowledge_store: { type: "boolean" },
          },
        },
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
        ingest_completed_local_tasks: {
          type: "boolean",
          description: "When true (default), Hermes ingests completed local task outcomes into typed memory learnings.",
          default: true,
        },
        local_task_ingest_limit: {
          type: "number",
          description: "Maximum completed local tasks to scan for ingestion in this cycle (default 50).",
          default: 50,
        },
        recall_bridged_limit: {
          type: "number",
          description: "How many recent motto-skills bridge records to include in recalled plan context (default 10).",
          default: 10,
        },
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
  {
    name: "business_pm_loop",
    description: "Canonical Hermes business PM loop invocation returning structured perceive/recall/plan/propose/learn output. Uses seeded memory/workflow/decision context, persists outcomes as learning and decision records, risk-classifies proposed actions, blocks unsafe actions without approval, and generates a business status report.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Business operations objective or focus area for this loop iteration." },
        correlation_id: { type: "string", description: "Validation correlation ID shared across all generated records." },
        observations: { type: "array", items: { type: "object" }, description: "Observed business signals and process observations for the perceive phase." },
        required_signals: {
          type: "array",
          items: { type: "string" },
          description: "Signal names required for this cycle. Missing signals are marked unknown/blocked and become capability requests.",
        },
        workflow_trace: {
          type: "object",
          description: "Optional workflow trace payload to convert into workflow candidates, handoffs, and capability gaps.",
        },
        workflow_traces: {
          type: "array",
          items: { type: "object" },
          description: "Optional list of workflow trace payloads to convert into reusable process knowledge.",
        },
        proposed_actions: { type: "array", items: { type: "object" }, description: "Proposed business actions for risk classification and approval gating." },
        capability_gaps: { type: "array", items: { type: "object" }, description: "Known capability blockers and missing prerequisites." },
        learnings: { type: "array", items: { type: "object" }, description: "Learnings captured from the cycle to persist as learning and decision records." },
        validation_evidence: {
          oneOf: [
            { type: "array", items: { type: "object" } },
            { type: "object" },
          ],
          description: "Validation evidence entries tied to this cycle.",
        },
        coordination_intents: {
          type: "array",
          items: { type: "object" },
          description: "Cross-agent intents to emit via signal_intent.",
        },
        local_tasks: {
          type: "array",
          items: { type: "object" },
          description: "Local/browser/authenticated work requests queued via queue_local_task.",
        },
        capability_requests: {
          type: "array",
          items: { type: "object" },
          description: "Missing credential/tool/session requests sent via request_capability.",
        },
        consume_intents_limit: {
          type: "number",
          description: "Maximum open intents to consume (default 10).",
          default: 10,
        },
        recall_categories: {
          type: "array",
          items: { type: "string" },
          description: "Memory categories to recall for the recall phase. Default: decision, workflow, fact, project, learning, capability_gap.",
        },
        recall_query: {
          type: "string",
          description: "Optional search query for memory recall. Defaults to the objective.",
        },
        recall_limit: {
          type: "number",
          description: "Maximum memory records to recall per category (default 10).",
          default: 10,
        },
        ingest_completed_local_tasks: {
          type: "boolean",
          description: "When true (default), ingest completed local task outcomes into typed memory learnings.",
          default: true,
        },
        local_task_ingest_limit: {
          type: "number",
          description: "Maximum completed local tasks to scan (default 50).",
          default: 50,
        },
        simulated_local_task_outcomes: {
          type: "array",
          items: { type: "object" },
          description: "Optional validation-only local/browser task outcomes to ingest into learning and planning when live task completion is unavailable.",
        },
        recall_bridged_limit: {
          type: "number",
          description: "How many recent motto-skills bridge records to include (default 10).",
          default: 10,
        },
        simulate_failures: {
          type: "object",
          description: "Validation-only failure simulation.",
          properties: {
            fleet_operations: { type: "array", items: { type: "string" } },
            fleet_sections: { type: "array", items: { type: "string" } },
            knowledge_store: { type: "boolean" },
          },
        },
        pending_approvals: { type: "number", description: "Count of pending approvals associated with the cycle." },
        blocked_capabilities: { type: "array", items: { type: "string" }, description: "Currently blocked capabilities for heartbeat metadata." },
      },
      required: ["objective"],
    },
  },
  {
    name: "business_status_report",
    description: "Generate a high-level business operations status report summarizing current process focus, observed signals, active projects/workflows, pending approvals, blocked capabilities, risks, and recommended next steps.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Current process focus area (defaults to last cycle objective)." },
        correlation_id: { type: "string", description: "Optional validation correlation ID." },
      },
    },
  },
  {
    name: "perplexity_shadow_status",
    description: "Retrieve recent Perplexity shadow observations from Hermes memory. Surfaces what Hermes has learned from Perplexity research activity, including queries, threads, findings, and derived awareness. Read-only diagnostic tool for Perplexity shadow listener.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum recent Perplexity observations to return (default 20).", default: 20 },
        correlation_id: { type: "string", description: "Optional correlation ID for traceability." },
      },
    },
  },
  {
    name: "factory_list_sessions",
    description: "List recent Factory Droid sessions for cross-session awareness.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max sessions (default 10)", default: 10 } },
    },
  },
  {
    name: "factory_get_session",
    description: "Get a Factory Droid session by ID, optionally including message history.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Factory session ID" },
        include_messages: { type: "boolean", description: "Include message history" },
        message_limit: { type: "number", description: "Max messages (default 50)", default: 50 },
      },
      required: ["session_id"],
    },
  },
  {
    name: "factory_create_mission",
    description: "Create a new Factory mission from Hermes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Mission title" },
        description: { type: "string", description: "Mission description and goal" },
        repository: { type: "string", description: "Git repository URL" },
        branch: { type: "string", description: "Target branch" },
      },
      required: ["title", "description"],
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
  const metadata = parseMetadata(args.metadata);
  const stored = storeTypedMemoryRecord({
    category: args.category,
    content: args.content,
    metadata,
    fallbackCategory: "observation",
    trace: {
      source: asOptionalString(metadata.source) ?? "memory_store",
      correlationId: asOptionalString(metadata.correlation_id) ?? undefined,
      runId: asOptionalString(metadata.run_id),
      taskId: asOptionalString(metadata.task_id) ?? asOptionalString(metadata.local_task_id),
      timestamp: asOptionalString(metadata.timestamp) ?? undefined,
      confidence: metadata.confidence,
    },
  });
  return { content: [{ type: "text", text: `Memory stored [${stored.id}] in "${stored.category}"` }] };
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

  const planRecord = redactSecrets(`## Plan: ${args.goal}\n\n${planText}`);
  const stored = storeTypedMemoryRecord({
    category: "project",
    content: planRecord,
    metadata: { goal: args.goal, context: args.context ?? "", generated_by: "plan_tool" },
    trace: {
      source: "plan_tool",
      confidence: "medium",
    },
  });

  return { content: [{ type: "text", text: `${planRecord}\n\n---\nStored [${stored.id}]` }] };
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
  const simulateFailuresRaw = asRecord(args.simulate_failures);
  const simulateFailures = Object.keys(simulateFailuresRaw).length > 0
    ? (simulateFailuresRaw as SimulateFailuresConfig)
    : undefined;
  fleetLifecycleState.pendingApprovals = asNonNegativeInt(args.pending_approvals, 0);
  fleetLifecycleState.blockedCapabilities = asStringArray(args.blocked_capabilities);

  // Drain retry queues from prior cycles before starting new work.
  drainRetryQueues();

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

  const cycleErrors: string[] = [];
  const consumedInboundIntents: Array<Record<string, unknown>> = [];
  const signaledIntents: Array<Record<string, unknown>> = [];
  const queuedLocalTasks: Array<Record<string, unknown>> = [];
  const filedCapabilityRequests: Array<Record<string, unknown>> = [];
  const ingestedLocalTaskOutcomes: LocalTaskOutcome[] = [];
  const learningMemoryRecords: Array<Record<string, unknown>> = [];
  const mottoSkillsBridges: BridgeResult[] = [];

  try {
    await sendFleetHeartbeat("cycle_start", objective);
  } catch (error) {
    queueFleetRetry("heartbeat_cycle_start", correlationId, null, error);
    cycleErrors.push("heartbeat_cycle_start failed");
  }

  let runId: string | null = null;
  try {
    if (shouldSimulateOperationFailure(simulateFailures, "record_run_start")) {
      throw new Error("Simulated fleet run-start failure");
    }
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

  const consumeIntentsLimit = Math.max(1, asNonNegativeInt(args.consume_intents_limit, 10));
  try {
    if (shouldSimulateOperationFailure(simulateFailures, "consume_open_intents", "inbound_intents")) {
      throw new Error("Simulated intent-consume failure");
    }
    const consumed = await FLEET_CONTROL_PLANE.consumeOpenIntents(FLEET_AGENT_NAME, consumeIntentsLimit);
    consumedInboundIntents.push(...asArray(consumed).map((intent) => asRecord(intent)));
  } catch (error) {
    cycleErrors.push("consume_open_intents failed");
    queueFleetRetry("consume_open_intents", correlationId, runId, error);
  }

  const coordinationIntentRequests = asArray(args.coordination_intents);
  for (let index = 0; index < coordinationIntentRequests.length; index += 1) {
    const intentReq = asRecord(coordinationIntentRequests[index]);
    const targetAgent = typeof intentReq.target_agent === "string" ? intentReq.target_agent.trim() : "";
    const kind = typeof intentReq.kind === "string" ? intentReq.kind.trim() : "";
    if (!targetAgent || !kind) {
      cycleErrors.push(`coordination_intents[${index}] missing target_agent or kind`);
      continue;
    }
    const sourceAgent = typeof intentReq.source_agent === "string" && intentReq.source_agent.trim().length > 0
      ? intentReq.source_agent.trim()
      : FLEET_AGENT_NAME;
    const payload = redactMetadata({
      ...asRecord(intentReq.payload),
      correlation_id: correlationId,
      run_id: runId,
      objective,
      requested_at: observedAt,
    }) as Record<string, unknown>;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "signal_intent", "coordination_intents")) {
        throw new Error("Simulated signal_intent failure");
      }
      const result = asRecord(await FLEET_CONTROL_PLANE.signalIntent({
        target_agent: targetAgent,
        kind,
        payload,
        source_agent: sourceAgent,
      }));
      signaledIntents.push({
        intent_id: result.intent_id ?? null,
        target_agent: targetAgent,
        kind,
        source_agent: sourceAgent,
      });
    } catch (error) {
      cycleErrors.push(`signal_intent failed for coordination_intents[${index}]`);
      queueFleetRetry("signal_intent", correlationId, runId, error);
    }
  }

  const localTaskRequests = asArray(args.local_tasks);
  for (let index = 0; index < localTaskRequests.length; index += 1) {
    const taskReq = asRecord(localTaskRequests[index]);
    const kind = typeof taskReq.kind === "string" ? taskReq.kind.trim() : "";
    if (!kind) {
      cycleErrors.push(`local_tasks[${index}] missing kind`);
      continue;
    }
    const payload = redactMetadata({
      ...asRecord(taskReq.payload),
      correlation_id: correlationId,
      run_id: runId,
      objective,
      queued_at: observedAt,
      created_by: FLEET_AGENT_NAME,
    }) as Record<string, unknown>;
    const source = typeof taskReq.source === "string" && taskReq.source.trim().length > 0
      ? taskReq.source.trim()
      : FLEET_AGENT_NAME;
    const description = typeof taskReq.description === "string" && taskReq.description.trim().length > 0
      ? taskReq.description
      : `Local/browser task for ${objective} [${correlationId}]`;
    const dedupKey = typeof taskReq.dedup_key === "string" && taskReq.dedup_key.trim().length > 0
      ? taskReq.dedup_key
      : `${correlationId}:local:${index}:${kind}`;
    const ttlSeconds = Math.max(60, asNonNegativeInt(taskReq.ttl_seconds, 600));
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "queue_local_task", "local_tasks")) {
        throw new Error("Simulated queue_local_task failure");
      }
      const queued = asRecord(await FLEET_CONTROL_PLANE.queueLocalTask({
        kind,
        payload,
        description,
        source,
        dedup_key: dedupKey,
        ttl_seconds: ttlSeconds,
      }));
      queuedLocalTasks.push({
        task_id: queued.task_id ?? queued.id ?? queued.local_task_id ?? null,
        kind,
        source,
        status: queued.status ?? queued.state ?? null,
      });
    } catch (error) {
      cycleErrors.push(`queue_local_task failed for local_tasks[${index}]`);
      queueFleetRetry("queue_local_task", correlationId, runId, error);
    }
  }

  const capabilityRequests = asArray(args.capability_requests);
  for (let index = 0; index < capabilityRequests.length; index += 1) {
    const req = asRecord(capabilityRequests[index]);
    const capability = typeof req.capability === "string" ? req.capability.trim() : "";
    const justificationRaw = typeof req.justification === "string" ? req.justification.trim() : "";
    if (!capability || !justificationRaw) {
      cycleErrors.push(`capability_requests[${index}] missing capability or justification`);
      continue;
    }
    const requestedBy = typeof req.requested_by === "string" && req.requested_by.trim().length > 0
      ? req.requested_by.trim()
      : FLEET_AGENT_NAME;
    const justification = redactSecrets(justificationRaw.includes(correlationId)
      ? justificationRaw
      : `[${correlationId}] ${justificationRaw}`);
    const repo = typeof req.repo === "string" ? req.repo : undefined;
    const moveId = typeof req.move_id === "number" && Number.isFinite(req.move_id)
      ? Math.trunc(req.move_id)
      : undefined;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "request_capability", "capability_requests")) {
        throw new Error("Simulated request_capability failure");
      }
      const result = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
        capability,
        justification,
        requested_by: requestedBy,
        repo,
        move_id: moveId,
      }));
      filedCapabilityRequests.push({
        capability,
        request_id: result.id ?? result.request_id ?? null,
        status: result.status ?? "pending",
        requested_by: requestedBy,
      });
    } catch (error) {
      cycleErrors.push(`request_capability failed for capability_requests[${index}]`);
      queueFleetRetry("request_capability", correlationId, runId, error);
    }
  }

  const observations = asArray(args.observations);
  const proposedActions = asArray(args.proposed_actions);
  if (proposedActions.length === 0 && consumedInboundIntents.length > 0) {
    for (const intent of consumedInboundIntents) {
      proposedActions.push({
        action: "triage_inbound_intent",
        intent_id: asRecord(intent).intent_id ?? null,
        correlation_id: correlationId,
        status: "ready",
      });
    }
  }
  const capabilityGaps = asArray(args.capability_gaps);
  const validationEvidence = validationEvidenceEntries(args.validation_evidence);
  const normalizedLearnings = normalizeLearningEntries(
    asArray(args.learnings),
    correlationId,
    runId,
    observedAt,
  );

  if (asBool(args.ingest_completed_local_tasks, true)) {
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "list_local_tasks", "local_task_outcomes")) {
        throw new Error("Simulated local task outcome ingestion failure");
      }
      const outcomes = await ingestCompletedLocalTasks({
        cycleCorrelationId: correlationId,
        runId,
        objective,
        observedAt,
        limit: asNonNegativeInt(args.local_task_ingest_limit, 50),
      });
      ingestedLocalTaskOutcomes.push(...outcomes);
    } catch (error) {
      cycleErrors.push("ingest_completed_local_tasks failed");
      queueFleetRetry("ingest_completed_local_tasks", correlationId, runId, error);
    }
  }

  for (const learning of normalizedLearnings) {
    const learningMemory = storeTypedMemoryRecord({
      category: learning.category,
      content: learning.content,
      metadata: {
        ...learning.metadata,
        repeated: learning.repeated,
        material: learning.material,
      },
      trace: {
        source: asOptionalString(learning.metadata.source) ?? "business_management_cycle_learning",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: learning.metadata.confidence,
      },
    });
    learningMemoryRecords.push({
      memory_id: learningMemory.id,
      category: learningMemory.category,
      repeated: learning.repeated,
      material: learning.material,
    });
    if (!(learning.repeated || learning.material)) continue;
    try {
      const bridge = bridgeLearningToMottoSkills(learning, correlationId, runId, learningMemory.id);
      const bridgeMemory = storeTypedMemoryRecord({
        category: learning.category,
        content: `Bridged learning to ${bridge.store_type} (${bridge.record_id})`,
        metadata: {
          ...learning.metadata,
          bridge_status: "bridged",
          bridge_store_type: bridge.store_type,
          bridge_record_id: bridge.record_id,
          bridge_store_path: bridge.store_path,
          bridge_action: bridge.action,
          bridged_from_memory_id: learningMemory.id,
        },
        trace: {
          source: "motto_skills_bridge",
          correlationId,
          runId,
          timestamp: observedAt,
          confidence: "high",
        },
      });
      mottoSkillsBridges.push({ ...bridge, memory_id: bridgeMemory.id });
    } catch (error) {
      cycleErrors.push(`motto_skills_bridge failed for learning[${learning.index}]`);
      queueKnowledgeRetry("motto_skills_bridge", correlationId, runId, error);
    }
  }

  const recalledBridgeReferences = recentBridgeReferences(
    asNonNegativeInt(args.recall_bridged_limit, 10),
  );
  const plan = buildStructuredPlan(
    args,
    correlationId,
    observedAt,
    consumedInboundIntents,
    recalledBridgeReferences,
  );
  const learnings = normalizedLearnings.map((learning) => ({
    category: learning.category,
    content: learning.content,
    repeated: learning.repeated,
    material: learning.material,
    metadata: learning.metadata,
  }));

  const sectionPayloads: Array<{ section: string; event_kind: string; artifact_kind: string; data: unknown; level?: string }> = [
    {
      section: "inbound_intents",
      event_kind: "cycle.inbound_intents",
      artifact_kind: "business_inbound_intents",
      data: {
        consumed_count: consumedInboundIntents.length,
        intents: consumedInboundIntents,
      },
    },
    {
      section: "coordination_intents",
      event_kind: "cycle.coordination_intents",
      artifact_kind: "business_coordination_intents",
      data: signaledIntents,
    },
    {
      section: "local_tasks",
      event_kind: "cycle.local_tasks",
      artifact_kind: "business_local_tasks",
      data: queuedLocalTasks,
    },
    {
      section: "local_task_outcomes",
      event_kind: "cycle.local_task_outcomes",
      artifact_kind: "business_local_task_outcomes",
      data: ingestedLocalTaskOutcomes,
    },
    {
      section: "capability_requests",
      event_kind: "cycle.capability_requests",
      artifact_kind: "business_capability_requests",
      data: filedCapabilityRequests,
      level: "warn",
    },
    { section: "observations", event_kind: "cycle.observations", artifact_kind: "business_observations", data: observations },
    { section: "plan", event_kind: "cycle.plan", artifact_kind: "business_plan", data: plan },
    { section: "proposed_actions", event_kind: "cycle.proposed_actions", artifact_kind: "business_proposed_actions", data: proposedActions },
    { section: "capability_gaps", event_kind: "cycle.capability_gaps", artifact_kind: "business_capability_gaps", data: capabilityGaps, level: "warn" },
    { section: "validation_evidence", event_kind: "cycle.validation_evidence", artifact_kind: "business_validation_evidence", data: validationEvidence },
    { section: "learning_memory_records", event_kind: "cycle.learning_memory_records", artifact_kind: "business_learning_memory_records", data: learningMemoryRecords },
    { section: "learnings", event_kind: "cycle.learnings", artifact_kind: "business_learnings", data: learnings },
    { section: "motto_skills_bridge", event_kind: "cycle.motto_skills_bridge", artifact_kind: "business_motto_skills_bridge", data: mottoSkillsBridges },
    { section: "recalled_bridges", event_kind: "cycle.recalled_bridges", artifact_kind: "business_recalled_bridges", data: recalledBridgeReferences },
  ];

  const emittedSections: Array<Record<string, unknown>> = [];

  for (const section of sectionPayloads) {
    const safeSectionData = redactMetadata(section.data);
    const eventPayload = {
      correlation_id: correlationId,
      objective,
      section: section.section,
      generated_at: observedAt,
      run_id: runId,
      data: safeSectionData,
    };

    let eventId: number | null = null;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "record_event", section.section)) {
        throw new Error(`Simulated record_event failure for ${section.section}`);
      }
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
      if (shouldSimulateOperationFailure(simulateFailures, "record_artifact_content", section.section)) {
        throw new Error(`Simulated record_artifact_content failure for ${section.section}`);
      }
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

  let knowledgeRecordId: string | null = null;
  const knowledgeWrite = persistCycleKnowledgeRecord({
    correlationId,
    runId,
    objective,
    observedAt,
    status: cycleErrors.length === 0 ? "ok" : "degraded",
    consumedInboundIntents,
    signaledIntents,
    queuedLocalTasks,
    ingestedLocalTaskOutcomes,
    capabilityRequests: filedCapabilityRequests,
    learningMemoryRecords,
    mottoSkillsBridges,
    errors: cycleErrors,
    emittedSections,
    simulateFailures,
  });
  if (knowledgeWrite.ok && knowledgeWrite.memoryId) {
    knowledgeRecordId = knowledgeWrite.memoryId;
  } else {
    cycleErrors.push("knowledge_store_write failed");
    queueKnowledgeRetry("cycle_knowledge_write", correlationId, runId, knowledgeWrite.error ?? "unknown knowledge-store failure");
  }

  const businessPmOutput = {
    correlation_id: correlationId,
    run_id: runId,
    objective,
    generated_at: observedAt,
    event_artifact_map: emittedSections,
    inbound_intents_consumed: consumedInboundIntents,
    intents_signaled: signaledIntents,
    local_tasks_queued: queuedLocalTasks,
    local_task_outcomes_ingested: ingestedLocalTaskOutcomes,
    capability_requests_filed: filedCapabilityRequests,
    learning_memory_records: learningMemoryRecords,
    motto_skills_bridges: mottoSkillsBridges,
    recalled_bridged_knowledge: recalledBridgeReferences,
    knowledge_record_id: knowledgeRecordId,
    pending_retries: fleetLifecycleState.pendingRetries.filter((retry) => retry.correlation_id === correlationId),
    pending_knowledge_retries: fleetLifecycleState.pendingKnowledgeRetries
      .filter((retry) => retry.correlation_id === correlationId),
  };

  try {
    if (shouldSimulateOperationFailure(simulateFailures, "record_artifact_content", "business_pm_output")) {
      throw new Error("Simulated record_artifact_content failure for business_pm_output");
    }
    const pmOutputRes = await FLEET_CONTROL_PLANE.recordArtifactContent({
      agent_name: FLEET_AGENT_NAME,
      kind: "business_pm_output",
      name: `${correlationId}-business-pm-output.json`,
      body: JSON.stringify(redactMetadata(businessPmOutput), null, 2),
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
        pending_knowledge_retry_count: fleetLifecycleState.pendingKnowledgeRetries
          .filter((retry) => retry.correlation_id === correlationId).length,
        knowledge_record_id: knowledgeRecordId,
        local_task_outcome_count: ingestedLocalTaskOutcomes.length,
        learning_memory_count: learningMemoryRecords.length,
        motto_skills_bridge_count: mottoSkillsBridges.length,
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
    inbound_intents_consumed: consumedInboundIntents,
    intents_signaled: signaledIntents,
    local_tasks_queued: queuedLocalTasks,
    local_task_outcomes_ingested: ingestedLocalTaskOutcomes,
    capability_requests_filed: filedCapabilityRequests,
    learning_memory_records: learningMemoryRecords,
    motto_skills_bridges: mottoSkillsBridges,
    recalled_bridged_knowledge: recalledBridgeReferences,
    knowledge_record_id: knowledgeRecordId,
    pending_retries: fleetLifecycleState.pendingRetries.filter((retry) => retry.correlation_id === correlationId),
    pending_knowledge_retries: fleetLifecycleState.pendingKnowledgeRetries.filter((retry) => retry.correlation_id === correlationId),
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

// ─── Risk classification for proposed actions ──────────────────────

type ActionRiskLevel = "read-only" | "low-impact-write" | "hermes-scoped-mutation" | "dangerous-global-mutation";

function classifyActionRisk(
  action: Record<string, unknown>,
  blockedSignals?: string[],
): {
  risk_level: ActionRiskLevel;
  approval_required: boolean;
  blocked: boolean;
  blocked_reason?: string;
} {
  const toolName = asOptionalString(action.tool ?? action.tool_name);
  const actionType = asOptionalString(action.type ?? action.action ?? action.kind) ?? "";
  const actionMaterial = [
    actionType,
    asOptionalString(action.description),
    asOptionalString(action.summary),
    asOptionalString(action.reason),
    asOptionalString(action.portal),
    asOptionalString(action.surface),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  // If the action references a known tool, use the existing risk policy
  if (toolName && RISK_METADATA[toolName]) {
    const meta = RISK_METADATA[toolName];
    const blocked = meta.level === "dangerous-global-mutation" || (meta.mutating && meta.level === "hermes-scoped-mutation");
    return {
      risk_level: meta.level as ActionRiskLevel,
      approval_required: meta.approval_required || meta.mutating,
      blocked,
      blocked_reason: blocked
        ? `Action references tool "${toolName}" classified as ${meta.level}; requires explicit approval.`
        : undefined,
    };
  }

  // Classify by action type keywords
  if (/restart\s+(full\s+)?vps|vps\s+restart/i.test(actionMaterial)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "VPS restart is a dangerous/global action requiring explicit approval." };
  }
  if (/snapshot/i.test(actionMaterial)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "VPS snapshot is a dangerous/global action requiring explicit approval." };
  }
  if (/stop\s+(project|service)/i.test(actionMaterial) && !/hermes/i.test(actionMaterial)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Stopping a non-Hermes project is a dangerous/global action requiring explicit approval." };
  }
  if (/deploy|restart\s+project|start\s+project/i.test(actionMaterial) && !/hermes/i.test(actionMaterial)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Non-Hermes project deployment/control is a dangerous/global action requiring explicit approval." };
  }
  if (/restart\s+hermes|redeploy\s+hermes|deploy\s+hermes|start\s+hermes/i.test(actionMaterial)) {
    return { risk_level: "hermes-scoped-mutation", approval_required: true, blocked: true, blocked_reason: "Hermes-scoped mutation requires validation evidence and approval." };
  }
  if (
    /submit|send[\s_-]email|purchase|order[\s_-]change|change[\s_-]order|credential[\s_-]change|portal[\s_-]mutation|data[\s_-]mutation|paid\s+(lookup|search|query)|download.*(official|legal|record)/i
      .test(actionMaterial)
  ) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Business-impacting online mutation requires explicit approval." };
  }
  if (/research|read|query|list|info|metrics|logs|recall|status|report/i.test(actionMaterial)) {
    const result = { risk_level: "read-only" as ActionRiskLevel, approval_required: false, blocked: false };
    return reclassifyPortalIfSignalsBlocked(action, result, blockedSignals);
  }
  if (/store\s+memory|plan|write\s+memory|record|emit|log\s+decision/i.test(actionMaterial)) {
    const result = { risk_level: "low-impact-write" as ActionRiskLevel, approval_required: false, blocked: false };
    return reclassifyPortalIfSignalsBlocked(action, result, blockedSignals);
  }

  // Default: if the action mentions mutating keywords, classify as hermes-scoped
  if (/restart|deploy|stop|start|create|delete|update|modify|change/i.test(actionMaterial)) {
    return { risk_level: "hermes-scoped-mutation", approval_required: true, blocked: true, blocked_reason: "Potential mutating action requires approval before execution." };
  }

  // Default to low-impact-write for unspecified actions
  const defaultResult = { risk_level: "low-impact-write" as ActionRiskLevel, approval_required: false, blocked: false };
  return reclassifyPortalIfSignalsBlocked(action, defaultResult, blockedSignals);
}

function reclassifyPortalIfSignalsBlocked(
  action: Record<string, unknown>,
  result: { risk_level: ActionRiskLevel; approval_required: boolean; blocked: boolean; blocked_reason?: string },
  blockedSignals?: string[],
): { risk_level: ActionRiskLevel; approval_required: boolean; blocked: boolean; blocked_reason?: string } {
  if (!result.blocked && blockedSignals && blockedSignals.length > 0) {
    const actionPortal = detectPortalSurface(action);
    if (actionPortal) {
      const blockedPortals = extractBlockedPortalSignals(blockedSignals);
      if (blockedPortals.has(actionPortal) || blockedPortals.has("portal_generic")) {
        const signalList = blockedSignals.slice(0, 5).join(", ");
        return {
          ...result,
          blocked: true,
          blocked_reason: `Portal action on "${actionPortal}" is blocked because required signals are unavailable: ${signalList}`,
        };
      }
    }
  }
  return result;
}

type OnlineExecutionClassification = "headless-safe" | "session-bound" | "blocked";

interface AuthSessionNeed {
  type: "session" | "credential" | "mfa" | "browser_profile" | "tooling" | "capability";
  handle: string;
  surface: string;
}

interface OnlineWorkflowProfile {
  is_online_workflow: boolean;
  portal_surface: string | null;
  execution_classification: OnlineExecutionClassification;
  classification_reason: string;
  missing_prerequisites: string[];
  auth_session_needs: AuthSessionNeed[];
  blocked_missing_capability: boolean;
  requires_local_task: boolean;
}

type OnlineFailureType =
  | "auth_failure"
  | "rate_limit"
  | "mfa_captcha"
  | "network_failure"
  | "provider_error"
  | "missing_evidence";

interface OnlineFailureDetails {
  failure_type: OnlineFailureType;
  blocker_type: string;
  provider: string | null;
  message: string;
  missing_prerequisites: string[];
  auth_session_needs: AuthSessionNeed[];
  requires_capability_request: boolean;
  requires_local_task: boolean;
}

interface OnlineEvidenceRecord {
  success_claim: boolean;
  source: string | null;
  tool: string | null;
  task_id: string | null;
  evidence_id: string | null;
  timestamp: string;
  provider: string | null;
  portal_surface: string | null;
  result_excerpt: string | null;
  observed_fields: Record<string, unknown> | null;
  evidence_complete: boolean;
  missing_fields: string[];
}

const ONLINE_SURFACE_DEFAULT_CAPABILITY: Record<string, string> = {
  gmail: "gmail_authenticated_session",
  matrix_mls: "matrix_mls_authenticated_session",
  taxnetusa: "taxnetusa_authenticated_session",
  county_cad: "county_cad_access",
  comet_browser: "comet_browser_desktop_session",
  sharepoint_onedrive: "sharepoint_authenticated_session",
  portal_generic: "portal_authenticated_session",
};

function detectOnlineProvider(action: Record<string, unknown>): string | null {
  const material = [
    asOptionalString(action.provider),
    asOptionalString(action.vendor),
    asOptionalString(action.tool),
    asOptionalString(action.tool_name),
    asOptionalString(action.portal),
    asOptionalString(action.surface),
    asOptionalString(action.action),
    asOptionalString(action.type),
    asOptionalString(action.description),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();
  if (!material) return null;
  if (/perplexity|sonar/.test(material)) return "perplexity";
  if (/gmail|google/.test(material)) return "gmail";
  if (/matrix|mls|ntrdd/.test(material)) return "matrix_mls";
  if (/taxnet/.test(material)) return "taxnetusa";
  if (/\bcad\b|dallascad|county\s+cad/.test(material)) return "county_cad";
  if (/comet|opera\s+neon|browser/.test(material)) return "comet_browser";
  if (/sharepoint|onedrive/.test(material)) return "sharepoint_onedrive";
  if (/hostinger/.test(material)) return "hostinger";
  return null;
}

function detectPortalSurface(action: Record<string, unknown>): string | null {
  const material = [
    asOptionalString(action.portal),
    asOptionalString(action.surface),
    asOptionalString(action.action),
    asOptionalString(action.type),
    asOptionalString(action.kind),
    asOptionalString(action.description),
    asOptionalString(action.summary),
    asOptionalString(action.tool),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  if (!material) return null;
  if (/gmail|mail\.google/.test(material)) return "gmail";
  if (/matrix|mls|ntrdd/.test(material)) return "matrix_mls";
  if (/taxnet/.test(material)) return "taxnetusa";
  if (/\bcad\b|dallascad|county\s+cad/.test(material)) return "county_cad";
  if (/comet|opera\s+neon|browser/.test(material)) return "comet_browser";
  if (/sharepoint|onedrive/.test(material)) return "sharepoint_onedrive";
  if (/portal|session|auth|login/.test(material)) return "portal_generic";
  return null;
}

function extractBlockedPortalSignals(blockedSignals: string[]): Set<string> {
  const portals = new Set<string>();
  for (const signal of blockedSignals) {
    const lower = signal.toLowerCase();
    if (/taxnet/.test(lower)) portals.add("taxnetusa");
    if (/gmail|mail/.test(lower)) portals.add("gmail");
    if (/matrix|mls/.test(lower)) portals.add("matrix_mls");
    if (/\bcad\b/.test(lower)) portals.add("county_cad");
    if (/comet|browser/.test(lower)) portals.add("comet_browser");
    if (/sharepoint|onedrive/.test(lower)) portals.add("sharepoint_onedrive");
    if (/portal|session|auth/.test(lower) && !/taxnet|gmail|mail|matrix|mls|cad|comet|browser|sharepoint|onedrive/.test(lower)) {
      portals.add("portal_generic");
    }
  }
  return portals;
}

function inferMissingPrerequisites(action: Record<string, unknown>, portalSurface: string | null): string[] {
  const explicit: string[] = [];

  explicit.push(...asStringArray(action.missing_prerequisites));
  explicit.push(...asStringArray(action.required_capabilities));
  const singleFields = [
    asOptionalString(action.missing_prerequisite),
    asOptionalString(action.required_capability),
    asOptionalString(action.required_session),
    asOptionalString(action.required_credential),
  ].filter((entry): entry is string => Boolean(entry));
  explicit.push(...singleFields);

  const inferredFlags = [
    asBool(action.requires_session, false),
    asBool(action.session_required, false),
    asBool(action.auth_required, false),
    asBool(action.login_required, false),
    asBool(action.desktop_required, false),
    asBool(action.browser_required, false),
  ].some(Boolean);

  const text = [
    asOptionalString(action.action),
    asOptionalString(action.type),
    asOptionalString(action.kind),
    asOptionalString(action.description),
    asOptionalString(action.summary),
    asOptionalString(action.reason),
    asOptionalString(action.blocker),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  const indicatesMissing = /missing|unavailable|not\s+authenticated|no\s+session|login\s+required|mfa|captcha|blocked/.test(text);
  const defaultCapability = portalSurface ? ONLINE_SURFACE_DEFAULT_CAPABILITY[portalSurface] : null;

  if (explicit.length === 0 && (inferredFlags || indicatesMissing) && defaultCapability) {
    explicit.push(defaultCapability);
  }
  return uniqueStrings(explicit);
}

function classifyOnlineFailureType(action: Record<string, unknown>, profile: OnlineWorkflowProfile): OnlineFailureDetails | null {
  if (!profile.is_online_workflow) return null;

  const status = (asOptionalString(action.status) ?? "").toLowerCase();
  const details = [
    asOptionalString(action.error),
    asOptionalString(action.blocker),
    asOptionalString(action.failure_reason),
    asOptionalString(action.provider_error),
    asOptionalString(action.description),
    asOptionalString(action.summary),
    asOptionalString(action.reason),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  const material = `${status} ${details}`.toLowerCase();

  const explicitFailureType = (asOptionalString(action.failure_type) ?? asOptionalString(action.blocker_type) ?? "")
    .trim()
    .toLowerCase();
  const hasFailureSignal = asBool(action.failed ?? action.is_failed ?? action.error_present, false)
    || /failed|error|blocked|denied|unauthor|forbidden|rate.?limit|quota|captcha|mfa|2fa|otp|timeout|network|unavailable|provider/i.test(material)
    || ["failed", "error", "blocked", "denied"].includes(status);
  if (!hasFailureSignal && explicitFailureType.length === 0) return null;

  let failureType: OnlineFailureType = "provider_error";
  if (explicitFailureType.includes("auth")) {
    failureType = "auth_failure";
  } else if (explicitFailureType.includes("rate")) {
    failureType = "rate_limit";
  } else if (explicitFailureType.includes("mfa") || explicitFailureType.includes("captcha") || explicitFailureType.includes("otp")) {
    failureType = "mfa_captcha";
  } else if (explicitFailureType.includes("network") || explicitFailureType.includes("timeout")) {
    failureType = "network_failure";
  } else if (/unauthor|forbidden|auth|token|credential|login|session|403|401/.test(material)) {
    failureType = "auth_failure";
  } else if (/rate.?limit|quota|429|too many requests/.test(material)) {
    failureType = "rate_limit";
  } else if (/mfa|captcha|otp|2fa/.test(material)) {
    failureType = "mfa_captcha";
  } else if (/timeout|network|dns|connection|503|502|gateway|service unavailable/.test(material)) {
    failureType = "network_failure";
  }

  const portalSurface = profile.portal_surface ?? "portal_generic";
  const missing = inferMissingPrerequisites(action, portalSurface);
  if (failureType === "auth_failure" && missing.length === 0) {
    missing.push(ONLINE_SURFACE_DEFAULT_CAPABILITY[portalSurface] ?? "portal_authenticated_session");
  }
  if (failureType === "mfa_captcha" && missing.length === 0) {
    missing.push(`${portalSurface}_mfa_access`);
  }
  const normalizedMissing = uniqueStrings(missing);
  const provider = detectOnlineProvider(action) ?? profile.portal_surface;
  const authSessionNeeds = inferAuthSessionNeeds(portalSurface, normalizedMissing);
  const message = redactSecrets(
    asOptionalString(action.error)
    ?? asOptionalString(action.blocker)
    ?? asOptionalString(action.failure_reason)
    ?? `${failureType} detected for ${provider ?? portalSurface}`,
  );

  return {
    failure_type: failureType,
    blocker_type: `online_${failureType}`,
    provider,
    message,
    missing_prerequisites: normalizedMissing,
    auth_session_needs: authSessionNeeds,
    requires_capability_request: normalizedMissing.length > 0 || failureType === "auth_failure" || failureType === "mfa_captcha",
    requires_local_task: profile.requires_local_task || failureType === "auth_failure" || failureType === "mfa_captcha",
  };
}

function normalizeObservedFields(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactMetadata(value) as Record<string, unknown>;
  }
  return null;
}

function buildOnlineEvidenceRecord(
  action: Record<string, unknown>,
  profile: OnlineWorkflowProfile,
  observedAt: string,
): OnlineEvidenceRecord {
  const status = (asOptionalString(action.status) ?? "").toLowerCase();
  const source = redactSecrets(
    asOptionalString(action.evidence_source)
    ?? asOptionalString(action.source)
    ?? asOptionalString(action.provider)
    ?? asOptionalString(action.surface)
    ?? asOptionalString(action.portal)
    ?? "",
  ) || null;
  const tool = asOptionalString(action.tool) ?? asOptionalString(action.tool_name);
  const taskId = asOptionalString(action.task_id) ?? asOptionalString(action.local_task_id) ?? asOptionalString(action.task_reference);
  const evidenceId = asOptionalString(action.evidence_id) ?? asOptionalString(action.source_record_id);
  const resultExcerpt = redactSecrets(
    asOptionalString(action.result_excerpt)
    ?? asOptionalString(action.evidence_excerpt)
    ?? asOptionalString(action.observed_summary)
    ?? "",
  ) || null;
  const observedFields = normalizeObservedFields(action.observed_fields ?? action.observed_field_values ?? action.fields);
  const successClaim = asBool(action.success, false)
    || asBool(action.completed, false)
    || ["success", "succeeded", "completed", "done", "ok"].includes(status);
  const hasResultEvidence = Boolean(resultExcerpt || observedFields || evidenceId || asOptionalString(action.evidence_url));

  const missingFields: string[] = [];
  if (successClaim) {
    if (!source) missingFields.push("source");
    if (!tool && !taskId) missingFields.push("tool_or_task_id");
    if (!hasResultEvidence) missingFields.push("result_excerpt_or_observed_fields_or_evidence_id");
  }

  return {
    success_claim: successClaim,
    source,
    tool,
    task_id: taskId,
    evidence_id: evidenceId,
    timestamp: asOptionalString(action.evidence_timestamp) ?? asOptionalString(action.timestamp) ?? asOptionalString(action.observed_at) ?? observedAt,
    provider: detectOnlineProvider(action),
    portal_surface: profile.portal_surface,
    result_excerpt: resultExcerpt,
    observed_fields: observedFields,
    evidence_complete: missingFields.length === 0,
    missing_fields: missingFields,
  };
}

function inferAuthSessionNeeds(portalSurface: string, prerequisites: string[]): AuthSessionNeed[] {
  const needs: AuthSessionNeed[] = [];
  for (const prerequisite of prerequisites) {
    const normalized = normalizeHandle(prerequisite);
    if (!normalized) continue;
    let type: AuthSessionNeed["type"] = "capability";
    if (/session|cookie|auth/.test(normalized)) type = "session";
    else if (/credential|password|oauth|token|login/.test(normalized)) type = "credential";
    else if (/mfa|captcha|otp|2fa/.test(normalized)) type = "mfa";
    else if (/browser|profile|comet|neon/.test(normalized)) type = "browser_profile";
    else if (/tool|mcp/.test(normalized)) type = "tooling";
    needs.push({ type, handle: normalized, surface: portalSurface });
  }
  return needs;
}

function classifyOnlineWorkflowStep(
  action: Record<string, unknown>,
  risk: { blocked: boolean; blocked_reason?: string },
): OnlineWorkflowProfile {
  const portalSurface = detectPortalSurface(action);
  const material = [
    asOptionalString(action.action),
    asOptionalString(action.type),
    asOptionalString(action.kind),
    asOptionalString(action.description),
    asOptionalString(action.summary),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  const readOnlyHint = /research|read|query|list|info|metrics|logs|recall/.test(material);
  const sessionHint = /portal|browser|session|auth|login|gmail|matrix|mls|taxnet|cad|comet|sharepoint|onedrive/.test(material);
  const isOnlineWorkflow = portalSurface !== null || readOnlyHint || sessionHint;

  if (!isOnlineWorkflow) {
    return {
      is_online_workflow: false,
      portal_surface: null,
      execution_classification: "headless-safe",
      classification_reason: "non-online or unspecified action",
      missing_prerequisites: [],
      auth_session_needs: [],
      blocked_missing_capability: false,
      requires_local_task: false,
    };
  }

  const normalizedSurface = portalSurface ?? "portal_generic";
  const missingPrerequisites = inferMissingPrerequisites(action, normalizedSurface);
  const authSessionNeeds = inferAuthSessionNeeds(normalizedSurface, missingPrerequisites);
  const blockedMissingCapability = missingPrerequisites.length > 0;

  if (blockedMissingCapability || (risk.blocked && sessionHint)) {
    return {
      is_online_workflow: true,
      portal_surface: normalizedSurface,
      execution_classification: "blocked",
      classification_reason: blockedMissingCapability
        ? "missing credential/session/tool prerequisite"
        : (risk.blocked_reason ?? "policy blocked"),
      missing_prerequisites: missingPrerequisites,
      auth_session_needs: authSessionNeeds,
      blocked_missing_capability: blockedMissingCapability,
      requires_local_task: true,
    };
  }

  if (sessionHint) {
    return {
      is_online_workflow: true,
      portal_surface: normalizedSurface,
      execution_classification: "session-bound",
      classification_reason: "requires authenticated browser/desktop execution surface",
      missing_prerequisites: missingPrerequisites,
      auth_session_needs: authSessionNeeds,
      blocked_missing_capability: false,
      requires_local_task: true,
    };
  }

  return {
    is_online_workflow: true,
    portal_surface: normalizedSurface,
    execution_classification: "headless-safe",
    classification_reason: "headless-safe read/research step",
    missing_prerequisites: [],
    auth_session_needs: [],
    blocked_missing_capability: false,
    requires_local_task: false,
  };
}

function capabilityGapByBlockerKey(blockerKey: string): { memory_id: string | null; request_id: string | null } | null {
  try {
    // Use exact JSON substring match rather than LIKE with unescaped wildcards.
    // LIKE treats _ as single-char wildcard; field names like blocker_key need escaping.
    const stmt = db.prepare(
      "SELECT id, metadata FROM memories WHERE category = 'capability_gap' AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1",
    );
    // Escape SQL LIKE wildcards (_ %) in the literal pattern portion (not the user-supplied key).
    stmt.bind([`%\"blocker\\_key\":\"${blockerKey}\"%`]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    const metadata = parseMetadata(row.metadata);
    return {
      memory_id: asIdentifier(row.id),
      request_id: asIdentifier(metadata.capability_request_id),
    };
  } catch {
    return null;
  }
}

type ObservationFactLabel = "fact" | "assumption";

function normalizeObservationFactLabel(raw: unknown): ObservationFactLabel | null {
  const value = asOptionalString(raw)?.toLowerCase();
  if (!value) return null;
  if (["fact", "observed_fact", "observation", "observed"].includes(value)) return "fact";
  if (["assumption", "inference", "inferred", "hypothesis"].includes(value)) return "assumption";
  return null;
}

function inferObservationFactLabel(observation: Record<string, unknown>): ObservationFactLabel {
  const explicit = normalizeObservationFactLabel(
    observation.fact_vs_assumption ?? observation.observation_type ?? observation.label,
  );
  if (explicit) return explicit;

  const summary = (
    asOptionalString(observation.summary)
    ?? asOptionalString(observation.content)
    ?? asOptionalString(observation.note)
    ?? ""
  ).toLowerCase();
  if (/assum|hypothes|likely|estimate|unknown|unclear|infer/.test(summary)) {
    return "assumption";
  }

  const evidence = asOptionalString(observation.evidence_id)
    ?? asOptionalString(observation.evidence_url)
    ?? asOptionalString(observation.source_record_id);
  if (evidence) return "fact";

  const source = (asOptionalString(observation.source) ?? "").toLowerCase();
  if (/vps|fleet|memory|research|monitor|tool|trace/.test(source)) return "fact";
  return "assumption";
}

interface WorkflowTraceSummary {
  trace_id: string;
  workflow_name: string;
  steps: Array<Record<string, unknown>>;
  handoffs: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  capability_gaps: Array<Record<string, unknown>>;
}

function summarizeWorkflowTrace(
  rawTrace: unknown,
  index: number,
  correlationId: string,
  observedAt: string,
): WorkflowTraceSummary {
  const trace = asRecord(rawTrace);
  const traceId = asOptionalString(trace.trace_id) ?? `${correlationId}-trace-${index + 1}`;
  const workflowName = asOptionalString(trace.workflow_name)
    ?? asOptionalString(trace.name)
    ?? `workflow-candidate-${index + 1}`;
  const rawSteps = asArray(trace.steps ?? trace.trace ?? trace.events ?? trace.workflow_steps);
  const steps = rawSteps.map((entry, stepIndex) => {
    const step = asRecord(entry);
    return {
      step_index: stepIndex + 1,
      step_id: asOptionalString(step.step_id) ?? `${traceId}-step-${stepIndex + 1}`,
      actor: asOptionalString(step.actor) ?? asOptionalString(step.owner) ?? "unknown",
      action: asOptionalString(step.action) ?? asOptionalString(step.step) ?? asOptionalString(step.name) ?? `step-${stepIndex + 1}`,
      status: asOptionalString(step.status) ?? "observed",
      handoff_to: asOptionalString(step.handoff_to) ?? asOptionalString(step.next_actor),
      blocker: asOptionalString(step.blocker) ?? asOptionalString(step.error),
      required_capability: asOptionalString(step.required_capability) ?? asOptionalString(step.capability),
      timestamp: asOptionalString(step.timestamp) ?? asOptionalString(step.observed_at) ?? observedAt,
    };
  });

  const handoffs: Array<Record<string, unknown>> = [];
  for (let i = 0; i < steps.length; i += 1) {
    const current = asRecord(steps[i]);
    const next = i + 1 < steps.length ? asRecord(steps[i + 1]) : null;
    const explicitHandoff = asOptionalString(current.handoff_to);
    const fromActor = asOptionalString(current.actor) ?? "unknown";
    const toActor = explicitHandoff
      ?? (next ? asOptionalString(next.actor) : null)
      ?? null;
    if (toActor && toActor !== fromActor) {
      handoffs.push({
        from_step_id: current.step_id ?? null,
        from_actor: fromActor,
        to_actor: toActor,
        reason: explicitHandoff ? "explicit_handoff" : "actor_transition",
      });
    }
  }

  const blockers = steps
    .filter((step) => {
      const status = (asOptionalString(asRecord(step).status) ?? "").toLowerCase();
      return status === "blocked" || Boolean(asOptionalString(asRecord(step).blocker));
    })
    .map((step) => {
      const s = asRecord(step);
      return {
        step_id: s.step_id ?? null,
        actor: s.actor ?? null,
        blocker: asOptionalString(s.blocker) ?? `Step status is ${asOptionalString(s.status) ?? "blocked"}`,
        required_capability: asOptionalString(s.required_capability),
      };
    });

  const capabilityGaps = blockers.reduce<Array<Record<string, unknown>>>((acc, blocker) => {
    const b = asRecord(blocker);
    const capability = asOptionalString(b.required_capability);
    if (!capability) return acc;
    acc.push({
      capability,
      blocker: b.blocker ?? "workflow blocker",
      trace_id: traceId,
    });
    return acc;
  }, []);

  return {
    trace_id: traceId,
    workflow_name: workflowName,
    steps,
    handoffs,
    blockers,
    capability_gaps: capabilityGaps,
  };
}

// ─── Business PM Loop handler ─────────────────────────────────────

interface BusinessPmLoopArgs {
  objective: string;
  correlation_id?: string;
  observations?: unknown[];
  required_signals?: unknown[];
  workflow_trace?: unknown;
  workflow_traces?: unknown[];
  proposed_actions?: unknown[];
  capability_gaps?: unknown[];
  learnings?: unknown[];
  validation_evidence?: unknown;
  coordination_intents?: unknown[];
  local_tasks?: unknown[];
  capability_requests?: unknown[];
  consume_intents_limit?: number;
  recall_categories?: unknown[];
  recall_query?: string;
  recall_limit?: number;
  ingest_completed_local_tasks?: boolean;
  local_task_ingest_limit?: number;
  simulated_local_task_outcomes?: unknown[];
  recall_bridged_limit?: number;
  simulate_failures?: SimulateFailuresConfig;
  pending_approvals?: number;
  blocked_capabilities?: unknown[];
}

async function handleBusinessPmLoop(args: BusinessPmLoopArgs) {
  const objective = redactSecrets((args.objective ?? "").trim());
  if (!objective) {
    return { content: [{ type: "text", text: "Error: objective is required" }], isError: true };
  }

  const correlationId = normalizeCorrelationId(args.correlation_id);
  const observedAt = nowIso();
  const simulateFailuresRaw = asRecord(args.simulate_failures);
  const simulateFailures = Object.keys(simulateFailuresRaw).length > 0
    ? (simulateFailuresRaw as SimulateFailuresConfig)
    : undefined;
  fleetLifecycleState.pendingApprovals = asNonNegativeInt(args.pending_approvals, 0);
  fleetLifecycleState.blockedCapabilities = asStringArray(args.blocked_capabilities);

  // Drain retry queues from prior cycles before starting new work.
  drainRetryQueues();

  const cycleErrors: string[] = [];

  // ── Fleet startup ──
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
    await sendFleetHeartbeat("pm_loop_start", objective);
  } catch (error) {
    queueFleetRetry("heartbeat_pm_loop_start", correlationId, null, error);
    cycleErrors.push("heartbeat_pm_loop_start failed");
  }

  // ── Start fleet run ──
  let runId: string | null = null;
  try {
    if (shouldSimulateOperationFailure(simulateFailures, "record_run_start")) {
      throw new Error("Simulated fleet run-start failure");
    }
    const runStart = await FLEET_CONTROL_PLANE.recordRunStart({
      agent_name: FLEET_AGENT_NAME,
      kind: "business-pm-loop",
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

  // ════════════════════════════════════════════════════════════════
  // PHASE 1: PERCEIVE — Gather observations and live signals
  // ════════════════════════════════════════════════════════════════

  const observations = asArray(args.observations).map((obs) => {
    const r = asRecord(obs);
    const observationFactLabel = inferObservationFactLabel(r);
    return {
      ...r,
      source: asOptionalString(r.source) ?? "user_input",
      timestamp: asOptionalString(r.timestamp) ?? observedAt,
      confidence: normalizeConfidence(r.confidence, "medium"),
      fact_vs_assumption: observationFactLabel,
      correlation_id: correlationId,
    };
  });
  const observationMemoryRecords: Array<Record<string, unknown>> = [];
  for (let i = 0; i < observations.length; i += 1) {
    const observation = asRecord(observations[i]);
    const observationSummary = asOptionalString(observation.summary)
      ?? asOptionalString(observation.content)
      ?? asOptionalString(observation.note)
      ?? `Observation ${i + 1} for objective "${objective}"`;
    const storedObservation = storeTypedMemoryRecord({
      category: "observation",
      content: observationSummary,
      metadata: {
        ...observation,
        observation_index: i + 1,
      },
      trace: {
        source: asOptionalString(observation.source) ?? "business_pm_loop_perceive",
        correlationId,
        runId,
        timestamp: asOptionalString(observation.timestamp) ?? observedAt,
        confidence: observation.confidence,
      },
    });
    observationMemoryRecords.push({
      memory_id: storedObservation.id,
      category: storedObservation.category,
      fact_vs_assumption: observation.fact_vs_assumption ?? "assumption",
      source: observation.source ?? null,
      timestamp: observation.timestamp ?? observedAt,
      confidence: observation.confidence ?? "medium",
    });
  }

  // ── Pull recent Perplexity shadow observations ──
  const perplexityShadowObservations: Array<Record<string, unknown>> = [];
  try {
    const perpStmt = db.prepare(
      "SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'observation' AND metadata LIKE '%perplexity%' ORDER BY created_at DESC LIMIT 20",
    );
    while (perpStmt.step()) {
      const row = perpStmt.getAsObject() as Record<string, unknown>;
      const meta = parseMetadata(row.metadata);
      perplexityShadowObservations.push({
        memory_id: row.id,
        signal_type: "perplexity_shadow",
        source: "perplexity",
        query: asOptionalString(meta.query) ?? "unknown",
        thread_id: asOptionalString(meta.thread_id) ?? null,
        findings_snippet: asOptionalString(meta.findings)?.slice(0, 200) ?? null,
        context: asOptionalString(meta.context) ?? null,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        ingested_at: row.created_at,
        correlation_id: correlationId,
        confidence: "high",
      });
    }
    perpStmt.free();
  } catch {
    // Best-effort: shadow pull is non-blocking
  }

  if (perplexityShadowObservations.length > 0) {
    console.error(
      "[perplexity_shadow] Pulled " + String(perplexityShadowObservations.length) +
      " recent Perplexity observations into perceive phase for correlation_id=" + correlationId,
    );
  }

  // Consume inbound intents as signals
  const consumedInboundIntents: Array<Record<string, unknown>> = [];
  const consumeIntentsLimit = Math.max(1, asNonNegativeInt(args.consume_intents_limit, 10));
  try {
    if (shouldSimulateOperationFailure(simulateFailures, "consume_open_intents", "perceive")) {
      throw new Error("Simulated intent-consume failure");
    }
    const consumed = await FLEET_CONTROL_PLANE.consumeOpenIntents(FLEET_AGENT_NAME, consumeIntentsLimit);
    consumedInboundIntents.push(...asArray(consumed).map((intent) => asRecord(intent)));
  } catch (error) {
    cycleErrors.push("consume_open_intents failed");
    queueFleetRetry("consume_open_intents", correlationId, runId, error);
  }

  // Add consumed intents as perceive signals
  const perceivedSignals = consumedInboundIntents.map((intent) => ({
    signal_type: "inbound_intent",
    intent_id: asRecord(intent).intent_id ?? null,
    kind: asRecord(intent).kind ?? null,
    source: asRecord(intent).source_agent ?? "fleet",
    timestamp: observedAt,
    confidence: "high",
    correlation_id: correlationId,
  }));

  const requiredSignals = asStringArray(args.required_signals);
  const observedSignalKeys = new Set<string>([
    ...observations
      .map((obs) => asOptionalString(asRecord(obs).type) ?? asOptionalString(asRecord(obs).signal_type))
      .filter((signal): signal is string => Boolean(signal))
      .map((signal) => signal.toLowerCase()),
    ...perceivedSignals
      .map((signal) => asOptionalString(asRecord(signal).signal_type) ?? asOptionalString(asRecord(signal).kind))
      .filter((signal): signal is string => Boolean(signal))
      .map((signal) => signal.toLowerCase()),
  ]);

  const unknownSignals = requiredSignals
    .filter((signal) => !observedSignalKeys.has(signal.toLowerCase()))
    .map((signal) => ({
      signal,
      status: "unknown",
      blocker_status: "blocked",
      reason: "required signal not observed in current cycle",
      correlation_id: correlationId,
    }));

  const unknownSignalCapabilityRequests: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unknownSignals.length; i += 1) {
    const missing = asRecord(unknownSignals[i]);
    const capabilityName = `signal_access_${asOptionalString(missing.signal) ?? `unknown_${i + 1}`}`;
    try {
      if (FLEET_CONTROL_PLANE.isConfigured()
        && !shouldSimulateOperationFailure(simulateFailures, "request_capability", "missing_signals")) {
        const capabilityResult = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
          capability: capabilityName,
          justification: `[${correlationId}] Required signal "${asOptionalString(missing.signal) ?? "unknown"}" is unavailable; mark status as unknown/blocked and request capability access.`,
          requested_by: FLEET_AGENT_NAME,
        }));
        unknownSignalCapabilityRequests.push({
          capability: capabilityName,
          request_id: capabilityResult.id ?? capabilityResult.request_id ?? null,
          status: capabilityResult.status ?? "pending",
          source: "missing_signal",
          signal: missing.signal ?? null,
        });
      }
    } catch (error) {
      cycleErrors.push(`request_capability for missing signal ${i} failed`);
      queueFleetRetry("request_capability", correlationId, runId, error);
    }

    storeTypedMemoryRecord({
      category: "capability_gap",
      content: `Signal "${asOptionalString(missing.signal) ?? "unknown"}" unavailable; status marked unknown/blocked.`,
      metadata: {
        source: "business_pm_loop_perceive",
        signal: missing.signal ?? null,
        status: "unknown",
        blocker_status: "blocked",
        capability: capabilityName,
      },
      trace: {
        source: "business_pm_loop_perceive",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: "high",
      },
    });
  }

  const workflowTraces = [
    ...(args.workflow_trace ? [args.workflow_trace] : []),
    ...asArray(args.workflow_traces),
  ];
  const workflowSummaries: WorkflowTraceSummary[] = workflowTraces.map((trace, index) =>
    summarizeWorkflowTrace(trace, index, correlationId, observedAt),
  );
  const workflowCandidateRecords: Array<Record<string, unknown>> = [];
  const workflowDerivedCapabilityGaps: Array<Record<string, unknown>> = [];
  const seededWorkflowAwareness = loadOnlineWorkflowAwareness();
  let seededWorkflowRecord: Record<string, unknown> | null = null;

  if (seededWorkflowAwareness.source_paths.length > 0) {
    const seeded = storeTypedMemoryRecord({
      category: "workflow",
      content: `Seeded appraisal workflow awareness from WF1/order-intake assets (${seededWorkflowAwareness.wf1_steps.length} steps, ${seededWorkflowAwareness.order_intake_fields.length} intake fields).`,
      metadata: {
        source: "wf1_order_intake_assets",
        source_paths: seededWorkflowAwareness.source_paths,
        wf1_steps: seededWorkflowAwareness.wf1_steps,
        order_intake_fields: seededWorkflowAwareness.order_intake_fields,
        handoff_points: seededWorkflowAwareness.handoff_points,
      },
      trace: {
        source: "wf1_order_intake_assets",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: "high",
      },
    });
    seededWorkflowRecord = {
      memory_id: seeded.id,
      category: seeded.category,
      source_paths: seededWorkflowAwareness.source_paths,
      wf1_step_count: seededWorkflowAwareness.wf1_steps.length,
      intake_field_count: seededWorkflowAwareness.order_intake_fields.length,
    };
  }

  for (let i = 0; i < workflowSummaries.length; i += 1) {
    const summary = workflowSummaries[i];
    const storedWorkflow = storeTypedMemoryRecord({
      category: "workflow",
      content: `Workflow candidate "${summary.workflow_name}" from trace ${summary.trace_id}: ${summary.steps.length} steps, ${summary.handoffs.length} handoffs, ${summary.blockers.length} blockers.`,
      metadata: {
        source: "workflow_trace",
        trace_id: summary.trace_id,
        workflow_name: summary.workflow_name,
        step_count: summary.steps.length,
        handoff_count: summary.handoffs.length,
        blocker_count: summary.blockers.length,
        steps: summary.steps,
        handoffs: summary.handoffs,
        blockers: summary.blockers,
      },
      trace: {
        source: "workflow_trace",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: summary.steps.length > 0 ? "high" : "medium",
      },
    });
    workflowCandidateRecords.push({
      memory_id: storedWorkflow.id,
      category: storedWorkflow.category,
      trace_id: summary.trace_id,
      workflow_name: summary.workflow_name,
      handoff_count: summary.handoffs.length,
      blocker_count: summary.blockers.length,
    });

    for (const gap of summary.capability_gaps) {
      const capability = asOptionalString(gap.capability);
      if (!capability) continue;
      workflowDerivedCapabilityGaps.push({
        capability,
        reason: asOptionalString(gap.blocker) ?? "workflow trace blocker",
        trace_id: summary.trace_id,
        source: "workflow_trace",
      });
    }
  }

  const perceiveSection = {
    observations,
    signals: perceivedSignals,
    perplexity_shadow: {
      observation_count: perplexityShadowObservations.length,
      observations: perplexityShadowObservations,
    },
    observation_records: observationMemoryRecords,
    unknown_signals: unknownSignals,
    workflow_summary: {
      traces_processed: workflowSummaries.length,
      workflow_candidates: workflowCandidateRecords,
      handoffs: workflowSummaries.flatMap((summary) => summary.handoffs),
      blockers: workflowSummaries.flatMap((summary) => summary.blockers),
      capability_gaps: workflowDerivedCapabilityGaps,
      seeded_asset_awareness: {
        source_paths: seededWorkflowAwareness.source_paths,
        wf1_steps: seededWorkflowAwareness.wf1_steps,
        order_intake_fields: seededWorkflowAwareness.order_intake_fields,
        handoff_points: seededWorkflowAwareness.handoff_points,
        seeded_record: seededWorkflowRecord,
      },
    },
    consumed_intents_count: consumedInboundIntents.length,
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 2: RECALL — Retrieve prior decisions, workflows, memories
  // ════════════════════════════════════════════════════════════════

  const defaultRecallCategories = ["decision", "workflow", "fact", "project", "learning", "capability_gap"];
  const recallCategories = asStringArray(args.recall_categories).length > 0
    ? asStringArray(args.recall_categories)
    : defaultRecallCategories;
  const recallQuery = asOptionalString(args.recall_query) ?? objective;
  const recallLimit = asNonNegativeInt(args.recall_limit, 10);

  const recalledMemories: Array<Record<string, unknown>> = [];
  for (const category of recallCategories) {
    try {
      const stmt = db.prepare(
        "SELECT id, category, content, metadata, created_at FROM memories WHERE category = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?",
      );
      stmt.bind([category, `%${recallQuery}%`, recallLimit]);
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>;
        recalledMemories.push({
          memory_id: row.id,
          category: row.category,
          content: row.content,
          metadata: parseMetadata(row.metadata),
          created_at: row.created_at,
          correlation_id: correlationId,
        });
      }
      stmt.free();
    } catch {
      // Recall is best-effort
    }
  }

  // Also recall recent records without query filter if no category matches
  if (recalledMemories.length === 0) {
    try {
      for (const category of recallCategories) {
        const stmt = db.prepare(
          "SELECT id, category, content, metadata, created_at FROM memories WHERE category = ? ORDER BY created_at DESC LIMIT ?",
        );
        stmt.bind([category, Math.max(1, Math.trunc(recallLimit / 2))]);
        while (stmt.step()) {
          const row = stmt.getAsObject() as Record<string, unknown>;
          recalledMemories.push({
            memory_id: row.id,
            category: row.category,
            content: row.content,
            metadata: parseMetadata(row.metadata),
            created_at: row.created_at,
            correlation_id: correlationId,
          });
        }
        stmt.free();
      }
    } catch {
      // Recall is best-effort
    }
  }

  // Recall bridged knowledge
  const recalledBridgeReferences = recentBridgeReferences(
    asNonNegativeInt(args.recall_bridged_limit, 10),
  );

  // Ingest completed local task outcomes
  const ingestedLocalTaskOutcomes: LocalTaskOutcome[] = [];
  if (asBool(args.ingest_completed_local_tasks, true)) {
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "list_local_tasks", "local_task_outcomes")) {
        throw new Error("Simulated local task outcome ingestion failure");
      }
      const outcomes = await ingestCompletedLocalTasks({
        cycleCorrelationId: correlationId,
        runId,
        objective,
        observedAt,
        limit: asNonNegativeInt(args.local_task_ingest_limit, 50),
      });
      ingestedLocalTaskOutcomes.push(...outcomes);
    } catch (error) {
      cycleErrors.push("ingest_completed_local_tasks failed");
      queueFleetRetry("ingest_completed_local_tasks", correlationId, runId, error);
    }
  }

  const simulatedLocalTaskOutcomes = asArray(args.simulated_local_task_outcomes).map((entry) => asRecord(entry));
  for (let i = 0; i < simulatedLocalTaskOutcomes.length; i += 1) {
    const simulated = simulatedLocalTaskOutcomes[i];
    const taskId = asOptionalString(simulated.task_id)
      ?? asOptionalString(simulated.local_task_id)
      ?? `${correlationId}-simulated-local-task-${i + 1}`;
    const kind = asOptionalString(simulated.kind) ?? "browser";
    const status = (asOptionalString(simulated.status) ?? "succeeded").toLowerCase();
    const finishedAt = asOptionalString(simulated.finished_at) ?? observedAt;
    const simulatedResult = parseMetadata(simulated.result);
    const outcomeCategory: TypedMemoryCategory = status === "succeeded"
      ? (kind.includes("browser") ? "workflow" : "learning")
      : "capability_gap";
    const outcomeContent = status === "succeeded"
      ? `Completed local task ${taskId} (${kind}) for objective "${objective}".`
      : `Local task ${taskId} (${kind}) finished with status "${status}".`;
    const storedOutcome = storeTypedMemoryRecord({
      category: outcomeCategory,
      content: outcomeContent,
      metadata: {
        source: "local_task_completion",
        task_kind: kind,
        task_status: status,
        task_finished_at: finishedAt,
        task_result: simulatedResult,
        task_error: asOptionalString(simulated.error),
        objective,
        simulated_outcome: true,
        ingested_by_correlation_id: correlationId,
        originating_correlation_id: asOptionalString(simulated.correlation_id),
        originating_run_id: asOptionalString(simulated.run_id),
      },
      trace: {
        source: "local_task_completion",
        correlationId: asOptionalString(simulated.correlation_id) ?? correlationId,
        runId: asOptionalString(simulated.run_id) ?? runId,
        taskId,
        timestamp: finishedAt,
        confidence: status === "succeeded" ? "high" : "medium",
      },
    });
    ingestedLocalTaskOutcomes.push({
      task_id: taskId,
      kind,
      status,
      source: "simulated_validation",
      finished_at: finishedAt,
      correlation_id: asOptionalString(simulated.correlation_id),
      run_id: asOptionalString(simulated.run_id),
      memory_id: storedOutcome.id,
      memory_category: storedOutcome.category,
    });
  }

  const recallSection = {
    prior_decisions: recalledMemories.filter((m) => m.category === "decision"),
    prior_workflows: recalledMemories.filter((m) => m.category === "workflow"),
    prior_facts: recalledMemories.filter((m) => m.category === "fact"),
    prior_projects: recalledMemories.filter((m) => m.category === "project"),
    prior_learnings: recalledMemories.filter((m) => m.category === "learning"),
    prior_capability_gaps: recalledMemories.filter((m) => m.category === "capability_gap"),
    other_memories: recalledMemories.filter(
      (m) => !["decision", "workflow", "fact", "project", "learning", "capability_gap"].includes(m.category as string),
    ),
    bridged_knowledge: recalledBridgeReferences,
    local_task_outcomes: ingestedLocalTaskOutcomes,
    total_recalled: recalledMemories.length + recalledBridgeReferences.length + ingestedLocalTaskOutcomes.length,
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 3: PLAN — Build structured plan citing recalled records
  // ════════════════════════════════════════════════════════════════

  // Cite recalled records in the plan
  const citedRecordIds = recalledMemories.map((m) => m.memory_id);
  const citedBridgeIds = recalledBridgeReferences.map((b) => ({
    store_type: b.bridge_store_type,
    record_id: b.bridge_record_id,
    store_path: b.bridge_store_path,
  }));
  const explicitCapabilityGaps = asArray(args.capability_gaps).map((gap) => asRecord(gap));
  const missingSignalCapabilityGaps = unknownSignals.map((missing) => ({
    capability: `signal_access_${asOptionalString(asRecord(missing).signal) ?? "unknown"}`,
    reason: asOptionalString(asRecord(missing).reason) ?? "missing signal",
    source: "missing_signal",
  }));
  const priorOnlineObservationRecords = recalledMemories.filter((memory) => {
    const metadata = asRecord(memory.metadata);
    const source = (asOptionalString(metadata.source) ?? "").toLowerCase();
    const content = (asOptionalString(memory.content) ?? "").toLowerCase();
    return source.startsWith("online_workflow")
      || source === "local_task_completion"
      || source === "workflow_trace"
      || source === "wf1_order_intake_assets"
      || /online workflow|portal|gmail|matrix|mls|taxnet|cad|comet|session/.test(content);
  });
  const priorOnlineCapabilityGapRecords = recalledMemories.filter((memory) => {
    if (memory.category !== "capability_gap") return false;
    const metadata = asRecord(memory.metadata);
    const source = (asOptionalString(metadata.source) ?? "").toLowerCase();
    const content = (asOptionalString(memory.content) ?? "").toLowerCase();
    return source.startsWith("online_workflow")
      || source === "local_task_completion"
      || source === "workflow_trace"
      || /portal|session|auth|mfa|captcha|taxnet|mls|cad|gmail|browser/.test(content);
  });
  const recalledCapabilityGapInputs = priorOnlineCapabilityGapRecords.map((memory) => {
    const metadata = asRecord(memory.metadata);
    return {
      capability: asOptionalString(metadata.capability),
      reason: asOptionalString(metadata.blocker) ?? asOptionalString(memory.content) ?? "prior capability gap",
      source: asOptionalString(metadata.source) ?? "prior_online_capability_gap",
      memory_id: asOptionalString(memory.memory_id),
      blocker_status: asOptionalString(metadata.blocker_status) ?? "blocked",
    };
  });
  const capabilityGaps = [
    ...explicitCapabilityGaps,
    ...workflowDerivedCapabilityGaps,
    ...missingSignalCapabilityGaps,
    ...recalledCapabilityGapInputs,
  ];

  const recalledLearningRecords = recalledMemories.filter((m) => m.category === "learning" || m.category === "capability_gap");
  const localTaskOutcomeEvidenceIds = ingestedLocalTaskOutcomes
    .map((outcome) => outcome.memory_id || outcome.task_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const priorOnlineObservationEvidenceIds = priorOnlineObservationRecords
    .map((memory) => asOptionalString(memory.memory_id))
    .filter((id): id is string => Boolean(id));
  const capabilityGapEvidenceIds = capabilityGaps
    .map((gap) => asOptionalString(asRecord(gap).memory_id) ?? asOptionalString(asRecord(gap).capability))
    .filter((id): id is string => Boolean(id));
  const learningInfluencedChanges: string[] = [];
  let executeSafePriority: "high" | "medium" | "low" = "high";
  let resolveBlockersPriority: "high" | "medium" | "low" = capabilityGaps.length > 0 ? "high" : "medium";
  let resolveBlockersStatus: "ready" | "blocked" = capabilityGaps.length > 0 ? "blocked" : "ready";

  for (const learningRecord of recalledLearningRecords) {
    const content = (asOptionalString(learningRecord.content) ?? "").toLowerCase();
    if (/blocked|missing|failed|unknown|unable|gap|pending/.test(content)) {
      resolveBlockersPriority = "high";
      resolveBlockersStatus = "blocked";
      learningInfluencedChanges.push(
        `Prior learning ${asOptionalString(learningRecord.memory_id) ?? "unknown"} indicates blocker risk, so blocker-resolution priority was raised.`,
      );
    }
    if (/success|succeeded|completed|resolved|unblocked/.test(content)) {
      executeSafePriority = "medium";
      learningInfluencedChanges.push(
        `Prior learning ${asOptionalString(learningRecord.memory_id) ?? "unknown"} indicates successful completion, so execution priority was tempered for validation focus.`,
      );
    }
  }

  if (priorOnlineObservationRecords.length > 0) {
    learningInfluencedChanges.push(
      `Prior online observations (${priorOnlineObservationRecords.length}) were carried into planning evidence and used to refine online step recommendations.`,
    );
  }

  if (priorOnlineCapabilityGapRecords.length > 0) {
    resolveBlockersPriority = "high";
    resolveBlockersStatus = "blocked";
    learningInfluencedChanges.push(
      `Prior online capability gaps (${priorOnlineCapabilityGapRecords.length}) were fed into the next plan as explicit blocked inputs.`,
    );
  }

  const succeededOutcomes = ingestedLocalTaskOutcomes.filter((outcome) => outcome.status === "succeeded");
  const failedOutcomes = ingestedLocalTaskOutcomes.filter((outcome) => ["failed", "cancelled", "blocked"].includes(outcome.status));
  if (succeededOutcomes.length > 0) {
    executeSafePriority = "medium";
    learningInfluencedChanges.push(
      `Completed local/browser tasks (${succeededOutcomes.length}) were ingested and used to refine next-cycle online execution priorities.`,
    );
  }
  if (failedOutcomes.length > 0) {
    resolveBlockersPriority = "high";
    resolveBlockersStatus = "blocked";
    learningInfluencedChanges.push(
      `Failed or blocked local/browser tasks (${failedOutcomes.length}) were ingested as blockers for the next plan.`,
    );
  }

  if (learningInfluencedChanges.length === 0 && recalledLearningRecords.length > 0) {
    learningInfluencedChanges.push(
      `Prior learning records (${recalledLearningRecords.length}) were cited and retained as planning evidence with no additional risk/priority override.`,
    );
  }

  const nextCheckAt = new Date(Date.parse(observedAt) + (30 * 60 * 1000)).toISOString();
  const dueAt = new Date(Date.parse(observedAt) + (24 * 60 * 60 * 1000)).toISOString();

  const planActions = [
    {
      step: "Review and triage observations",
      owner: "hermes",
      target_agent: "hermes",
      priority: "high",
      dependencies: [],
      timing: "immediate",
      due_at: dueAt,
      next_check_at: nextCheckAt,
      success_criteria: "All observations categorized with provenance and fact-vs-assumption labels",
      status: "ready",
      ready_state: "ready",
      evidence_ids: observationMemoryRecords.map((record) => asOptionalString(record.memory_id)).filter((id): id is string => Boolean(id)),
    },
    {
      step: "Integrate recalled decisions and workflows into current plan",
      owner: "hermes",
      target_agent: "hermes",
      priority: "high",
      dependencies: ["Review and triage observations"],
      timing: "immediate",
      due_at: dueAt,
      next_check_at: nextCheckAt,
      success_criteria: "Prior context properly referenced and applied to recommendations",
      status: (citedRecordIds.length > 0 || localTaskOutcomeEvidenceIds.length > 0 || priorOnlineObservationEvidenceIds.length > 0) ? "ready" : "blocked",
      ready_state: (citedRecordIds.length > 0 || localTaskOutcomeEvidenceIds.length > 0 || priorOnlineObservationEvidenceIds.length > 0) ? "ready" : "blocked",
      evidence_ids: [...citedRecordIds, ...localTaskOutcomeEvidenceIds, ...priorOnlineObservationEvidenceIds],
    },
    {
      step: "Execute safe proposed actions",
      owner: "hermes",
      target_agent: "hermes",
      priority: executeSafePriority,
      dependencies: ["Integrate recalled decisions and workflows into current plan"],
      timing: "next_cycle",
      due_at: dueAt,
      next_check_at: nextCheckAt,
      success_criteria: "All safe actions completed or queued with traceable records",
      status: "ready",
      ready_state: "ready",
      evidence_ids: [],
    },
    {
      step: "Resolve blocked capabilities and pending approvals",
      owner: "hermes",
      target_agent: "hermes+approver",
      priority: resolveBlockersPriority,
      dependencies: ["Execute safe proposed actions"],
      timing: "next_cycle",
      due_at: dueAt,
      next_check_at: nextCheckAt,
      success_criteria: "Blockers resolved, or capability requests/local tasks created with correlation links",
      status: resolveBlockersStatus,
      ready_state: resolveBlockersStatus === "blocked" ? "blocked" : "ready",
      evidence_ids: capabilityGapEvidenceIds,
    },
    {
      step: "Capture and persist learning outcomes",
      owner: "hermes",
      target_agent: "hermes",
      priority: "medium",
      dependencies: ["Execute safe proposed actions"],
      timing: "end_of_cycle",
      due_at: dueAt,
      next_check_at: nextCheckAt,
      success_criteria: "All learnings and decisions persisted with typed metadata and source provenance",
      status: "ready",
      ready_state: "ready",
      evidence_ids: [],
    },
  ];

  const onlineStepRecommendations = [
    ...priorOnlineCapabilityGapRecords.map((memory) => ({
      source_memory_id: asOptionalString(memory.memory_id),
      recommended_classification: "blocked",
      rationale: asOptionalString(memory.content) ?? "prior capability gap remains blocked",
    })),
    ...succeededOutcomes.map((outcome) => ({
      source_memory_id: outcome.memory_id,
      recommended_classification: "session-bound",
      rationale: `Local task ${outcome.task_id} succeeded; keep as session-bound but informed by completed outcome evidence.`,
    })),
  ];

  const planSection = {
    objective,
    correlation_id: correlationId,
    generated_at: observedAt,
    cited_records: citedRecordIds,
    cited_bridged_knowledge: citedBridgeIds,
    seeded_workflow_awareness: {
      source_paths: seededWorkflowAwareness.source_paths,
      wf1_step_count: seededWorkflowAwareness.wf1_steps.length,
      order_intake_field_count: seededWorkflowAwareness.order_intake_fields.length,
      handoff_count: seededWorkflowAwareness.handoff_points.length,
      seeded_record_id: asOptionalString(seededWorkflowRecord?.memory_id),
    },
    inbound_intent_ids: consumedInboundIntents
      .map((intent) => asRecord(intent).intent_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    learning_influenced_changes: learningInfluencedChanges,
    prior_online_observations: priorOnlineObservationRecords.map((memory) => ({
      memory_id: asOptionalString(memory.memory_id),
      category: asOptionalString(memory.category),
      source: asOptionalString(asRecord(memory.metadata).source),
      summary: asOptionalString(memory.content),
    })),
    prior_online_capability_gaps: priorOnlineCapabilityGapRecords.map((memory) => ({
      memory_id: asOptionalString(memory.memory_id),
      capability: asOptionalString(asRecord(memory.metadata).capability),
      source: asOptionalString(asRecord(memory.metadata).source),
      blocker_status: asOptionalString(asRecord(memory.metadata).blocker_status) ?? "blocked",
      summary: asOptionalString(memory.content),
    })),
    local_task_feedback: {
      outcome_count: ingestedLocalTaskOutcomes.length,
      outcomes: ingestedLocalTaskOutcomes,
      succeeded_count: succeededOutcomes.length,
      failed_or_blocked_count: failedOutcomes.length,
      evidence_ids: localTaskOutcomeEvidenceIds,
    },
    capability_gap_inputs: capabilityGaps,
    online_step_recommendations: onlineStepRecommendations,
    unknown_signals: unknownSignals,
    actions: planActions,
    summary: recalledMemories.length > 0
      ? `Plan synthesized with ${recalledMemories.length} recalled memory records, ${recalledBridgeReferences.length} bridged references, ${ingestedLocalTaskOutcomes.length} local-task outcome(s), and ${learningInfluencedChanges.length} learning-driven adjustment(s). Seeded WF1/order-intake assets informed online workflow awareness.`
      : "Plan synthesized from current observations/objective and seeded WF1/order-intake workflow assets.",
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 4: PROPOSE — Risk-classify actions, block unsafe, create records
  // ════════════════════════════════════════════════════════════════

  const proposedActions = asArray(args.proposed_actions);
  const classifiedActions: Array<Record<string, unknown>> = [];
  const blockedActions: Array<Record<string, unknown>> = [];
  const approvalRequestRecords: Array<Record<string, unknown>> = [];
  const proposalRecordLinks: Array<Record<string, unknown>> = [];
  const signaledIntents: Array<Record<string, unknown>> = [];
  const queuedLocalTasks: Array<Record<string, unknown>> = [];
  const filedCapabilityRequests: Array<Record<string, unknown>> = [...unknownSignalCapabilityRequests];
  const onlineStepClassifications: Array<Record<string, unknown>> = [];
  const onlineSuccessEvidence: Array<Record<string, unknown>> = [];
  const onlineFailureBlockers: Array<Record<string, unknown>> = [];
  const onlineObservationRecords: Array<Record<string, unknown>> = [];
  const cycleBlockerRequestMap = new Map<string, string | null>();

  for (let i = 0; i < proposedActions.length; i++) {
    const action = asRecord(proposedActions[i]);
    const blockedSignalNames = unknownSignals
      .map((s) => asOptionalString(asRecord(s).signal))
      .filter((s): s is string => Boolean(s));
    const riskClassification = classifyActionRisk(action, blockedSignalNames);
    const onlineProfile = classifyOnlineWorkflowStep(action, riskClassification);
    const actionReference = asOptionalString(action.action ?? action.type ?? action.kind) ?? `proposed_action_${i}`;
    let onlineFailure = classifyOnlineFailureType(action, onlineProfile);
    const onlineEvidence = buildOnlineEvidenceRecord(action, onlineProfile, observedAt);
    if (onlineProfile.is_online_workflow && onlineEvidence.success_claim && !onlineEvidence.evidence_complete) {
      onlineFailure = {
        failure_type: "missing_evidence",
        blocker_type: "online_missing_evidence",
        provider: onlineEvidence.provider,
        message: `Online success claim for "${actionReference}" is missing required evidence fields: ${onlineEvidence.missing_fields.join(", ")}`,
        missing_prerequisites: [],
        auth_session_needs: [],
        requires_capability_request: false,
        requires_local_task: false,
      };
    }
    const effectiveMissingPrerequisites = uniqueStrings([
      ...onlineProfile.missing_prerequisites,
      ...(onlineFailure?.missing_prerequisites ?? []),
    ]);
    const effectiveAuthSessionNeeds = onlineFailure?.auth_session_needs.length
      ? onlineFailure.auth_session_needs
      : inferAuthSessionNeeds(onlineProfile.portal_surface ?? "portal_generic", effectiveMissingPrerequisites);
    const effectiveExecutionClassification: OnlineExecutionClassification = onlineFailure
      ? "blocked"
      : onlineProfile.execution_classification;
    let actionStatus = riskClassification.blocked ? "awaiting_approval" : (asOptionalString(action.status) ?? "ready");
    if (!riskClassification.blocked) {
      if (onlineFailure) {
        actionStatus = `blocked_${onlineFailure.failure_type}`;
      } else if (onlineProfile.blocked_missing_capability) {
        actionStatus = "blocked_missing_capability";
      } else if (effectiveExecutionClassification === "session-bound") {
        actionStatus = "queued_local_task";
      }
    }

    const proposalLink: Record<string, unknown> = {
      action_index: i,
      action_reference: actionReference,
      correlation_id: correlationId,
      run_id: runId,
      risk_level: riskClassification.risk_level,
      approval_required: riskClassification.approval_required,
      link_status: "classified",
    };

    const classifiedAction: Record<string, unknown> = {
      ...action,
      risk_level: riskClassification.risk_level,
      approval_required: riskClassification.approval_required,
      expected_outcome: asOptionalString(action.expected_outcome) ?? asOptionalString(action.description) ?? `Outcome of action: ${actionReference}`,
      status: actionStatus,
      execution_classification: effectiveExecutionClassification,
      portal_surface: onlineProfile.portal_surface,
      missing_prerequisites: effectiveMissingPrerequisites,
      auth_session_needs: effectiveAuthSessionNeeds,
      classification_reason: onlineProfile.classification_reason,
      blocker_type: onlineFailure?.blocker_type ?? null,
      failure_type: onlineFailure?.failure_type ?? null,
      failure_message: onlineFailure?.message ?? null,
      evidence: onlineEvidence,
      correlation_id: correlationId,
    };

    classifiedActions.push(classifiedAction);

    if (onlineProfile.is_online_workflow) {
      if (onlineEvidence.success_claim) {
        onlineSuccessEvidence.push({
          action_index: i,
          action_reference: actionReference,
          ...onlineEvidence,
          correlation_id: correlationId,
          run_id: runId,
        });
      }
      onlineStepClassifications.push({
        action_index: i,
        action_reference: actionReference,
        execution_classification: effectiveExecutionClassification,
        portal_surface: onlineProfile.portal_surface,
        classification_reason: onlineFailure?.message ?? onlineProfile.classification_reason,
        missing_prerequisites: effectiveMissingPrerequisites,
        blocker_type: onlineFailure?.blocker_type ?? null,
        failure_type: onlineFailure?.failure_type ?? null,
        provider: onlineFailure?.provider ?? onlineEvidence.provider,
        success_claim: onlineEvidence.success_claim,
        evidence_complete: onlineEvidence.evidence_complete,
        correlation_id: correlationId,
      });
    }

    const isBlocked = riskClassification.blocked || onlineProfile.blocked_missing_capability || Boolean(onlineFailure);
    if (isBlocked) {
      const blockedRecord = {
        action_reference: actionReference,
        risk_level: riskClassification.risk_level,
        blocker_type: onlineFailure?.blocker_type ?? (onlineProfile.blocked_missing_capability ? "online_missing_capability" : "approval_required"),
        failure_type: onlineFailure?.failure_type ?? null,
        provider: onlineFailure?.provider ?? onlineEvidence.provider,
        portal_surface: onlineProfile.portal_surface,
        blocked_reason: onlineProfile.blocked_missing_capability
          ? `Missing online workflow prerequisites: ${effectiveMissingPrerequisites.join(", ")}`
          : (onlineFailure?.message ?? riskClassification.blocked_reason ?? "Action requires approval"),
        missing_prerequisites: effectiveMissingPrerequisites,
        auth_session_needs: effectiveAuthSessionNeeds,
        original_action: action,
        correlation_id: correlationId,
      };
      blockedActions.push(blockedRecord);
      if (onlineProfile.is_online_workflow) {
        onlineFailureBlockers.push(blockedRecord);
      }
    }

    if (riskClassification.blocked) {
      // Persist an approval request in memory
      const approvalMemory = storeTypedMemoryRecord({
        category: "approval_request",
        content: `Approval required for ${riskClassification.risk_level} action: ${actionReference}. ${riskClassification.blocked_reason ?? ""}`,
        metadata: {
          proposed_action_index: i,
          action_reference: actionReference,
          risk_level: riskClassification.risk_level,
          blocked_reason: riskClassification.blocked_reason,
          objective,
        },
        trace: {
          source: "business_pm_loop_propose",
          correlationId,
          runId,
          timestamp: observedAt,
          confidence: "high",
        },
      });
      approvalRequestRecords.push({
        memory_id: approvalMemory.id,
        category: approvalMemory.category,
        action_index: i,
        action_reference: actionReference,
        risk_level: riskClassification.risk_level,
      });
      proposalLink.approval_request_memory_id = approvalMemory.id;
      proposalLink.link_status = "approval_requested";

      // Create a capability request for the blocked action if it needs a specific capability
      if (riskClassification.risk_level === "dangerous-global-mutation"
        && FLEET_CONTROL_PLANE.isConfigured()
        && !onlineProfile.is_online_workflow) {
        try {
          if (!shouldSimulateOperationFailure(simulateFailures, "request_capability", "propose")) {
            const capabilityResult = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
              capability: `approval_for_${riskClassification.risk_level}_action`,
              justification: `[${correlationId}] Action "${actionReference}" is classified as ${riskClassification.risk_level} and requires explicit human approval: ${riskClassification.blocked_reason ?? "policy requires approval"}`,
              requested_by: FLEET_AGENT_NAME,
            }));
            const capabilityRequestId = asIdentifier(capabilityResult.id) ?? asIdentifier(capabilityResult.request_id);
            filedCapabilityRequests.push({
              capability: `approval_for_${riskClassification.risk_level}_action`,
              request_id: capabilityRequestId,
              status: capabilityResult.status ?? "pending",
              requested_by: FLEET_AGENT_NAME,
              source: "blocked_proposal",
              action_reference: actionReference,
            });
            proposalLink.capability_request_id = capabilityRequestId;
          }
        } catch (error) {
          cycleErrors.push(`request_capability for blocked action ${i} failed`);
          queueFleetRetry("request_capability", correlationId, runId, error);
        }
      }
    }

    const shouldFileOnlineCapabilityRequest = onlineProfile.is_online_workflow
      && Boolean(onlineProfile.portal_surface)
      && (effectiveMissingPrerequisites.length > 0 || Boolean(onlineFailure?.requires_capability_request));
    if (shouldFileOnlineCapabilityRequest && onlineProfile.portal_surface) {
      const blockerDescriptor = effectiveMissingPrerequisites.length > 0
        ? effectiveMissingPrerequisites.join("|")
        : (onlineFailure?.failure_type ?? actionReference);
      const blockerKey = normalizeHandle(`${onlineProfile.portal_surface}:${blockerDescriptor}`);
      const existingFromCycle = cycleBlockerRequestMap.get(blockerKey);
      const existingFromMemory = capabilityGapByBlockerKey(blockerKey);
      const knownRequestId = existingFromCycle ?? existingFromMemory?.request_id ?? null;
      let capabilityRequestId: string | null = knownRequestId;
      let capabilityRequestStatus = knownRequestId ? "reused_existing" : "pending";
      const primaryCapability = effectiveMissingPrerequisites[0]
        ?? ONLINE_SURFACE_DEFAULT_CAPABILITY[onlineProfile.portal_surface]
        ?? "portal_authenticated_session";

      if (!knownRequestId && FLEET_CONTROL_PLANE.isConfigured()) {
        try {
          if (!shouldSimulateOperationFailure(simulateFailures, "request_capability", "online_workflow")) {
            const capabilityResult = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
              capability: primaryCapability,
              justification: `[${correlationId}] ${onlineProfile.portal_surface} workflow step "${actionReference}" is blocked by ${
                onlineFailure ? `${onlineFailure.failure_type}: ${onlineFailure.message}` : `missing prerequisite(s): ${effectiveMissingPrerequisites.join(", ")}`
              }.`,
              requested_by: FLEET_AGENT_NAME,
            }));
            capabilityRequestId = asIdentifier(capabilityResult.id) ?? asIdentifier(capabilityResult.request_id);
            capabilityRequestStatus = asOptionalString(capabilityResult.status) ?? "pending";
            cycleBlockerRequestMap.set(blockerKey, capabilityRequestId ?? null);
          }
        } catch (error) {
          cycleErrors.push(`request_capability for online blocker ${i} failed`);
          queueFleetRetry("request_capability", correlationId, runId, error);
        }
      } else {
        cycleBlockerRequestMap.set(blockerKey, capabilityRequestId ?? null);
      }

      filedCapabilityRequests.push({
        capability: primaryCapability,
        request_id: capabilityRequestId,
        status: capabilityRequestStatus,
        requested_by: FLEET_AGENT_NAME,
        source: capabilityRequestStatus === "reused_existing" ? "online_portal_prerequisite_reused" : "online_portal_prerequisite",
        portal_surface: onlineProfile.portal_surface,
        blocker_key: blockerKey,
        blocker_type: onlineFailure?.blocker_type ?? "online_missing_capability",
        failure_type: onlineFailure?.failure_type ?? null,
        provider: onlineFailure?.provider ?? onlineEvidence.provider,
        prerequisites: effectiveMissingPrerequisites,
        auth_session_needs: effectiveAuthSessionNeeds,
        action_reference: actionReference,
      });

      const gapMemory = storeTypedMemoryRecord({
        category: "capability_gap",
        content: `[${correlationId}] Online workflow blocker for ${onlineProfile.portal_surface}: ${
          onlineFailure
            ? `${onlineFailure.failure_type} (${onlineFailure.message})`
            : effectiveMissingPrerequisites.join(", ")
        }.`,
        metadata: {
          source: "online_workflow_blocker",
          blocker_key: blockerKey,
          blocker_type: onlineFailure?.blocker_type ?? "online_missing_capability",
          failure_type: onlineFailure?.failure_type ?? null,
          provider: onlineFailure?.provider ?? onlineEvidence.provider,
          failure_message: onlineFailure?.message ?? null,
          capability: primaryCapability,
          capability_request_id: capabilityRequestId,
          portal_surface: onlineProfile.portal_surface,
          prerequisite_types: effectiveMissingPrerequisites,
          auth_session_needs: effectiveAuthSessionNeeds,
          evidence: onlineEvidence,
          action_reference: actionReference,
          blocker_status: effectiveExecutionClassification === "blocked" ? "blocked" : "session-bound",
        },
        trace: {
          source: "online_workflow_blocker",
          correlationId,
          runId,
          timestamp: observedAt,
          confidence: "high",
        },
      });

      proposalLink.capability_request_id = capabilityRequestId;
      proposalLink.capability_gap_memory_id = gapMemory.id;
      proposalLink.blocker_key = blockerKey;
      if (proposalLink.link_status === "classified") {
        proposalLink.link_status = capabilityRequestStatus === "reused_existing"
          ? "capability_reused"
          : "capability_requested";
      }
    }

    const shouldQueueOnlineLocalTask = onlineProfile.requires_local_task || Boolean(onlineFailure?.requires_local_task);
    if (shouldQueueOnlineLocalTask && FLEET_CONTROL_PLANE.isConfigured() && !proposalLink.local_task_id) {
      const portal = onlineProfile.portal_surface ?? "portal_generic";
      const blockerKey = normalizeHandle(`${portal}:${effectiveMissingPrerequisites.join("|") || onlineFailure?.failure_type || actionReference}`);
      try {
        if (!shouldSimulateOperationFailure(simulateFailures, "queue_local_task", "propose")) {
          const queued = asRecord(await FLEET_CONTROL_PLANE.queueLocalTask({
            kind: "browser",
            payload: {
              action_reference: actionReference,
              action_index: i,
              portal_surface: portal,
              execution_classification: effectiveExecutionClassification,
              auth_session_needs: effectiveAuthSessionNeeds,
              missing_prerequisites: effectiveMissingPrerequisites,
              online_failure_type: onlineFailure?.failure_type ?? null,
              online_blocker_type: onlineFailure?.blocker_type ?? null,
              online_failure_message: onlineFailure?.message ?? null,
              online_evidence: onlineEvidence,
              correlation_id: correlationId,
              run_id: runId,
              objective,
              queued_at: observedAt,
              created_by: FLEET_AGENT_NAME,
            },
            description: `Session-bound online step for ${portal}: ${actionReference}`,
            source: FLEET_AGENT_NAME,
            dedup_key: `${correlationId}:online:${i}:${blockerKey}`,
            ttl_seconds: 600,
          }));
          const localTaskId = asOptionalString(queued.task_id) ?? asOptionalString(queued.id) ?? asOptionalString(queued.local_task_id);
          queuedLocalTasks.push({
            task_id: localTaskId,
            kind: "browser",
            source: FLEET_AGENT_NAME,
            status: queued.status ?? queued.state ?? null,
            reason: effectiveExecutionClassification === "blocked" ? "blocked_online_step" : "session_bound_online_step",
            portal_surface: portal,
            action_reference: actionReference,
            auth_session_needs: effectiveAuthSessionNeeds,
          });
          proposalLink.local_task_id = localTaskId;
          if (proposalLink.link_status === "classified") {
            proposalLink.link_status = "local_task_queued";
          }
        }
      } catch (error) {
        cycleErrors.push(`queue_local_task for online action ${i} failed`);
        queueFleetRetry("queue_local_task", correlationId, runId, error);
      }
    }

    if (onlineProfile.is_online_workflow) {
      const onlineRecordCategory: TypedMemoryCategory = effectiveExecutionClassification === "blocked"
        ? "capability_gap"
        : (effectiveExecutionClassification === "session-bound" ? "workflow" : "learning");
      const storedOnlineRecord = storeTypedMemoryRecord({
        category: onlineRecordCategory,
        content: `[${correlationId}] Online workflow observation for ${actionReference}: ${effectiveExecutionClassification}.`,
        metadata: {
          source: "online_workflow_observation",
          action_reference: actionReference,
          portal_surface: onlineProfile.portal_surface,
          execution_classification: effectiveExecutionClassification,
          classification_reason: onlineFailure?.message ?? onlineProfile.classification_reason,
          missing_prerequisites: effectiveMissingPrerequisites,
          auth_session_needs: effectiveAuthSessionNeeds,
          blocker_type: onlineFailure?.blocker_type ?? null,
          failure_type: onlineFailure?.failure_type ?? null,
          provider: onlineFailure?.provider ?? onlineEvidence.provider,
          failure_message: onlineFailure?.message ?? null,
          evidence: onlineEvidence,
          objective,
        },
        trace: {
          source: "online_workflow_observation",
          correlationId,
          runId,
          timestamp: observedAt,
          confidence: effectiveExecutionClassification === "headless-safe" ? "medium" : "high",
        },
      });
      onlineObservationRecords.push({
        memory_id: storedOnlineRecord.id,
        category: storedOnlineRecord.category,
        action_reference: actionReference,
        portal_surface: onlineProfile.portal_surface,
        execution_classification: effectiveExecutionClassification,
        blocker_type: onlineFailure?.blocker_type ?? null,
        failure_type: onlineFailure?.failure_type ?? null,
        evidence_complete: onlineEvidence.evidence_complete,
      });
    }
    proposalRecordLinks.push(proposalLink);
  }

  // Signal coordination intents
  const coordinationIntentRequests = asArray(args.coordination_intents);
  for (let index = 0; index < coordinationIntentRequests.length; index += 1) {
    const intentReq = asRecord(coordinationIntentRequests[index]);
    const targetAgent = typeof intentReq.target_agent === "string" ? intentReq.target_agent.trim() : "";
    const kind = typeof intentReq.kind === "string" ? intentReq.kind.trim() : "";
    if (!targetAgent || !kind) {
      cycleErrors.push(`coordination_intents[${index}] missing target_agent or kind`);
      continue;
    }
    const sourceAgent = typeof intentReq.source_agent === "string" && intentReq.source_agent.trim().length > 0
      ? intentReq.source_agent.trim()
      : FLEET_AGENT_NAME;
    const payload = redactMetadata({
      ...asRecord(intentReq.payload),
      correlation_id: correlationId,
      run_id: runId,
      objective,
      requested_at: observedAt,
    }) as Record<string, unknown>;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "signal_intent", "propose")) {
        throw new Error("Simulated signal_intent failure");
      }
      const result = asRecord(await FLEET_CONTROL_PLANE.signalIntent({
        target_agent: targetAgent,
        kind,
        payload,
        source_agent: sourceAgent,
      }));
      signaledIntents.push({
        intent_id: result.intent_id ?? null,
        target_agent: targetAgent,
        kind,
        source_agent: sourceAgent,
      });
    } catch (error) {
      cycleErrors.push(`signal_intent failed for coordination_intents[${index}]`);
      queueFleetRetry("signal_intent", correlationId, runId, error);
    }
  }

  // Queue local tasks
  const localTaskRequests = asArray(args.local_tasks);
  for (let index = 0; index < localTaskRequests.length; index += 1) {
    const taskReq = asRecord(localTaskRequests[index]);
    const kind = typeof taskReq.kind === "string" ? taskReq.kind.trim() : "";
    if (!kind) {
      cycleErrors.push(`local_tasks[${index}] missing kind`);
      continue;
    }
    const payload = redactMetadata({
      ...asRecord(taskReq.payload),
      correlation_id: correlationId,
      run_id: runId,
      objective,
      queued_at: observedAt,
      created_by: FLEET_AGENT_NAME,
    }) as Record<string, unknown>;
    const source = typeof taskReq.source === "string" && taskReq.source.trim().length > 0
      ? taskReq.source.trim()
      : FLEET_AGENT_NAME;
    const description = typeof taskReq.description === "string" && taskReq.description.trim().length > 0
      ? taskReq.description
      : `Local/browser task for ${objective} [${correlationId}]`;
    const dedupKey = typeof taskReq.dedup_key === "string" && taskReq.dedup_key.trim().length > 0
      ? taskReq.dedup_key
      : `${correlationId}:local:${index}:${kind}`;
    const ttlSeconds = Math.max(60, asNonNegativeInt(taskReq.ttl_seconds, 600));
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "queue_local_task", "propose")) {
        throw new Error("Simulated queue_local_task failure");
      }
      const queued = asRecord(await FLEET_CONTROL_PLANE.queueLocalTask({
        kind,
        payload,
        description,
        source,
        dedup_key: dedupKey,
        ttl_seconds: ttlSeconds,
      }));
      queuedLocalTasks.push({
        task_id: queued.task_id ?? queued.id ?? queued.local_task_id ?? null,
        kind,
        source,
        status: queued.status ?? queued.state ?? null,
      });
    } catch (error) {
      cycleErrors.push(`queue_local_task failed for local_tasks[${index}]`);
      queueFleetRetry("queue_local_task", correlationId, runId, error);
    }
  }

  // File capability requests derived from workflow traces
  for (let index = 0; index < workflowDerivedCapabilityGaps.length; index += 1) {
    const gap = asRecord(workflowDerivedCapabilityGaps[index]);
    const capability = asOptionalString(gap.capability);
    if (!capability) continue;
    try {
      if (!shouldSimulateOperationFailure(simulateFailures, "request_capability", "workflow_trace")) {
        const result = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
          capability,
          justification: `[${correlationId}] Workflow trace blocker requires capability "${capability}" (${asOptionalString(gap.reason) ?? "workflow blocker"}).`,
          requested_by: FLEET_AGENT_NAME,
        }));
        filedCapabilityRequests.push({
          capability,
          request_id: result.id ?? result.request_id ?? null,
          status: result.status ?? "pending",
          requested_by: FLEET_AGENT_NAME,
          source: "workflow_trace",
          trace_id: asOptionalString(gap.trace_id),
        });
      }
    } catch (error) {
      cycleErrors.push(`request_capability for workflow trace gap ${index} failed`);
      queueFleetRetry("request_capability", correlationId, runId, error);
    }
  }

  // File capability requests
  const capabilityRequests = asArray(args.capability_requests);
  for (let index = 0; index < capabilityRequests.length; index += 1) {
    const req = asRecord(capabilityRequests[index]);
    const capability = typeof req.capability === "string" ? req.capability.trim() : "";
    const justificationRaw = typeof req.justification === "string" ? req.justification.trim() : "";
    if (!capability || !justificationRaw) {
      cycleErrors.push(`capability_requests[${index}] missing capability or justification`);
      continue;
    }
    const requestedBy = typeof req.requested_by === "string" && req.requested_by.trim().length > 0
      ? req.requested_by.trim()
      : FLEET_AGENT_NAME;
    const justification = redactSecrets(justificationRaw.includes(correlationId)
      ? justificationRaw
      : `[${correlationId}] ${justificationRaw}`);
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "request_capability", "capability_requests")) {
        throw new Error("Simulated request_capability failure");
      }
      const result = asRecord(await FLEET_CONTROL_PLANE.requestCapability({
        capability,
        justification,
        requested_by: requestedBy,
      }));
      filedCapabilityRequests.push({
        capability,
        request_id: result.id ?? result.request_id ?? null,
        status: result.status ?? "pending",
        requested_by: requestedBy,
      });
    } catch (error) {
      cycleErrors.push(`request_capability failed for capability_requests[${index}]`);
      queueFleetRetry("request_capability", correlationId, runId, error);
    }
  }

  const proposeSection = {
    actions: classifiedActions,
    blocked_actions: blockedActions,
    online_step_classification: onlineStepClassifications,
    online_success_evidence: onlineSuccessEvidence,
    online_failure_blockers: onlineFailureBlockers,
    online_observation_records: onlineObservationRecords,
    approval_requests: approvalRequestRecords,
    proposal_records: proposalRecordLinks,
    coordination_intents: signaledIntents,
    local_tasks: queuedLocalTasks,
    capability_requests: filedCapabilityRequests,
    unknown_signals: unknownSignals,
    workflow_capability_gaps: workflowDerivedCapabilityGaps,
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 5: LEARN — Persist learning and decision records
  // ════════════════════════════════════════════════════════════════

  const normalizedLearnings = normalizeLearningEntries(
    asArray(args.learnings),
    correlationId,
    runId,
    observedAt,
  );

  const learningMemoryRecords: Array<Record<string, unknown>> = [];
  const decisionMemoryRecords: Array<Record<string, unknown>> = [];
  const mottoSkillsBridges: BridgeResult[] = [];

  // Persist learning records
  for (const learning of normalizedLearnings) {
    const learningMemory = storeTypedMemoryRecord({
      category: learning.category,
      content: learning.content,
      metadata: {
        ...learning.metadata,
        repeated: learning.repeated,
        material: learning.material,
      },
      trace: {
        source: asOptionalString(learning.metadata.source) ?? "business_pm_loop_learning",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: learning.metadata.confidence,
      },
    });
    learningMemoryRecords.push({
      memory_id: learningMemory.id,
      category: learningMemory.category,
      repeated: learning.repeated,
      material: learning.material,
      content_preview: learning.content.slice(0, 200),
    });

    // Bridge material/repeated learnings to motto-skills
    if (learning.repeated || learning.material) {
      try {
        const bridge = bridgeLearningToMottoSkills(learning, correlationId, runId, learningMemory.id);
        const bridgeMemory = storeTypedMemoryRecord({
          category: learning.category,
          content: `Bridged learning to ${bridge.store_type} (${bridge.record_id})`,
          metadata: {
            ...learning.metadata,
            bridge_status: "bridged",
            bridge_store_type: bridge.store_type,
            bridge_record_id: bridge.record_id,
            bridge_store_path: bridge.store_path,
            bridge_action: bridge.action,
            bridged_from_memory_id: learningMemory.id,
          },
          trace: {
            source: "motto_skills_bridge",
            correlationId,
            runId,
            timestamp: observedAt,
            confidence: "high",
          },
        });
        mottoSkillsBridges.push({ ...bridge, memory_id: bridgeMemory.id });
      } catch (error) {
        cycleErrors.push(`motto_skills_bridge failed for learning[${learning.index}]`);
        queueKnowledgeRetry("motto_skills_bridge", correlationId, runId, error);
      }
    }
  }

  // Always persist a decision record from the cycle outcome
  const cycleDecisionContent = `Business PM loop decision for objective: ${objective}. ${normalizedLearnings.length > 0 ? `Based on ${normalizedLearnings.length} learning(s).` : "No explicit learnings provided; cycle completed observation and planning phases."}`;
  const cycleDecision = storeTypedMemoryRecord({
    category: "decision",
    content: cycleDecisionContent,
    metadata: {
      decision_class: "business_pm_loop_outcome",
      objective,
      learning_count: normalizedLearnings.length,
      recalled_memory_count: recalledMemories.length,
      recalled_bridge_count: recalledBridgeReferences.length,
      blocked_action_count: blockedActions.length,
      approved_action_count: classifiedActions.filter((a) => a.status !== "awaiting_approval").length,
      plan_action_count: planActions.length,
    },
    trace: {
      source: "business_pm_loop_learn",
      correlationId,
      runId,
      timestamp: observedAt,
      confidence: normalizedLearnings.length > 0 ? "high" : "medium",
    },
  });
  decisionMemoryRecords.push({
    memory_id: cycleDecision.id,
    category: cycleDecision.category,
    content_preview: cycleDecisionContent.slice(0, 200),
  });

  // Persist a learning record even if no explicit learnings were provided
  if (normalizedLearnings.length === 0) {
    const implicitLearningContent = `Implicit learning from business PM loop: Objective "${objective}" was processed with ${recalledMemories.length} recalled memories, ${observations.length} observations, and ${proposedActions.length} proposed actions. ${blockedActions.length > 0 ? `${blockedActions.length} action(s) were blocked pending approval.` : "No actions were blocked."}`;
    const implicitLearning = storeTypedMemoryRecord({
      category: "learning",
      content: implicitLearningContent,
      metadata: {
        learning_type: "implicit_cycle_learning",
        objective,
        recalled_memory_count: recalledMemories.length,
        observation_count: observations.length,
        proposed_action_count: proposedActions.length,
        blocked_action_count: blockedActions.length,
      },
      trace: {
        source: "business_pm_loop_learn",
        correlationId,
        runId,
        timestamp: observedAt,
        confidence: "medium",
      },
    });
    learningMemoryRecords.push({
      memory_id: implicitLearning.id,
      category: implicitLearning.category,
      repeated: false,
      material: false,
      content_preview: implicitLearningContent.slice(0, 200),
    });
  }

  const learnSection = {
    learning_records: learningMemoryRecords,
    decision_records: decisionMemoryRecords,
    motto_skills_bridges: mottoSkillsBridges,
    local_task_outcomes_ingested: ingestedLocalTaskOutcomes,
    validation_evidence: validationEvidenceEntries(args.validation_evidence),
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // ── Emit fleet events/artifacts for each section ──

  const pmLoopSections = [
    { section: "perceive", data: perceiveSection },
    { section: "recall", data: recallSection },
    { section: "plan", data: planSection },
    { section: "propose", data: proposeSection },
    { section: "learn", data: learnSection },
  ];

  const emittedSections: Array<Record<string, unknown>> = [];

  for (const section of pmLoopSections) {
    const safeData = redactMetadata(section.data);

    let eventId: number | null = null;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "record_event", section.section)) {
        throw new Error(`Simulated record_event failure for ${section.section}`);
      }
      const eventRes = await FLEET_CONTROL_PLANE.recordEvent({
        agent_name: FLEET_AGENT_NAME,
        kind: `pm_loop.${section.section}`,
        payload: {
          correlation_id: correlationId,
          objective,
          section: section.section,
          generated_at: observedAt,
          run_id: runId,
          data: safeData,
        },
        run_id: runId,
        level: section.section === "propose" && blockedActions.length > 0 ? "warn" : "info",
      });
      const rawEventId = asRecord(eventRes).event_id;
      eventId = typeof rawEventId === "number" ? rawEventId : null;
    } catch (error) {
      cycleErrors.push(`record_event(${section.section}) failed`);
      queueFleetRetry(`record_event(${section.section})`, correlationId, runId, error);
    }

    let artifactId: number | null = null;
    try {
      if (shouldSimulateOperationFailure(simulateFailures, "record_artifact_content", section.section)) {
        throw new Error(`Simulated record_artifact_content failure for ${section.section}`);
      }
      const artifactRes = await FLEET_CONTROL_PLANE.recordArtifactContent({
        agent_name: FLEET_AGENT_NAME,
        kind: `business_pm_loop_${section.section}`,
        name: `${correlationId}-pm-loop-${section.section}.json`,
        body: JSON.stringify(safeData, null, 2),
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
      cycleErrors.push(`record_artifact_content(${section.section}) failed`);
      queueFleetRetry(`record_artifact_content(${section.section})`, correlationId, runId, error);
    }

    emittedSections.push({
      section: section.section,
      event_id: eventId,
      artifact_id: artifactId,
      body_format: "json",
    });
  }

  // ── Persist cycle knowledge record ──
  let knowledgeRecordId: string | null = null;
  const knowledgeWrite = persistCycleKnowledgeRecord({
    correlationId,
    runId,
    objective,
    observedAt,
    status: cycleErrors.length === 0 ? "ok" : "degraded",
    consumedInboundIntents,
    signaledIntents,
    queuedLocalTasks,
    ingestedLocalTaskOutcomes,
    capabilityRequests: filedCapabilityRequests,
    learningMemoryRecords,
    mottoSkillsBridges,
    errors: cycleErrors,
    emittedSections,
    simulateFailures,
  });
  if (knowledgeWrite.ok && knowledgeWrite.memoryId) {
    knowledgeRecordId = knowledgeWrite.memoryId;
  } else {
    cycleErrors.push("knowledge_store_write failed");
    queueKnowledgeRetry("cycle_knowledge_write", correlationId, runId, knowledgeWrite.error ?? "unknown knowledge-store failure");
  }

  // ════════════════════════════════════════════════════════════════
  // BUSINESS STATUS REPORT (VAL-LOOP-006)
  // ════════════════════════════════════════════════════════════════

  const statusReport = {
    current_focus: objective,
    observed_signals: observations.map((obs) => ({
      source: asOptionalString(asRecord(obs).source) ?? "unknown",
      type: asOptionalString(asRecord(obs).type) ?? "observation",
      summary: asOptionalString(asRecord(obs).summary ?? asRecord(obs).content) ?? "signal observed",
      fact_vs_assumption: asOptionalString(asRecord(obs).fact_vs_assumption) ?? "assumption",
    })),
    unknown_signals: unknownSignals,
    active_projects: recalledMemories
      .filter((m) => m.category === "project")
      .map((m) => ({
        memory_id: m.memory_id,
        summary: asOptionalString(m.content) ?? "active project",
      })),
    active_workflows: recalledMemories
      .filter((m) => m.category === "workflow")
      .map((m) => ({
        memory_id: m.memory_id,
        summary: asOptionalString(m.content) ?? "active workflow",
      }))
      .concat(workflowCandidateRecords.map((candidate) => ({
        memory_id: asOptionalString(candidate.memory_id) ?? null,
        summary: `Workflow candidate: ${asOptionalString(candidate.workflow_name) ?? "workflow"}`,
      }))),
    pending_approvals: blockedActions.length + fleetLifecycleState.pendingApprovals,
    blocked_capabilities: currentBlockedCapabilities(
      unknownSignals
        .map((signal) => asOptionalString(asRecord(signal).signal))
        .filter((signal): signal is string => Boolean(signal))
        .concat(
          capabilityGaps
            .map((gap) => asOptionalString(asRecord(gap).capability))
            .filter((capability): capability is string => Boolean(capability)),
        ),
    ),
    risks: blockedActions.map((ba) => ({
      action: asOptionalString(asRecord(ba).action_reference) ?? "unknown",
      risk_level: asOptionalString(asRecord(ba).risk_level) ?? "unknown",
      reason: asOptionalString(asRecord(ba).blocked_reason) ?? "requires approval",
    })).concat(
      unknownSignals.map((signal) => ({
        action: asOptionalString(asRecord(signal).signal) ?? "unknown_signal",
        risk_level: "blocked-input",
        reason: asOptionalString(asRecord(signal).reason) ?? "required signal unavailable",
      })),
    ),
    online_learning: {
      classifications: {
        headless_safe: onlineStepClassifications.filter((step) => asOptionalString(step.execution_classification) === "headless-safe").length,
        session_bound: onlineStepClassifications.filter((step) => asOptionalString(step.execution_classification) === "session-bound").length,
        blocked: onlineStepClassifications.filter((step) => asOptionalString(step.execution_classification) === "blocked").length,
      },
      continue_safe_learning_when_blocked:
        onlineStepClassifications.some((step) => asOptionalString(step.execution_classification) === "blocked")
        ? (
          onlineStepClassifications.some((step) => asOptionalString(step.execution_classification) === "headless-safe")
          || seededWorkflowAwareness.wf1_steps.length > 0
        )
        : true,
      blocked_portal_surfaces: uniqueStrings(
        onlineStepClassifications
          .filter((step) => asOptionalString(step.execution_classification) === "blocked")
          .map((step) => asOptionalString(step.portal_surface) ?? "portal_generic"),
      ),
    },
    perplexity_awareness: {
      shadow_observations_count: perplexityShadowObservations.length,
      recent_queries: perplexityShadowObservations
        .filter((obs) => obs.query)
        .slice(0, 10)
        .map((obs) => ({
          query: asOptionalString(asRecord(obs).query)?.slice(0, 200) ?? null,
          thread_id: asOptionalString(asRecord(obs).thread_id) ?? null,
          ingested_at: asOptionalString(asRecord(obs).ingested_at) ?? null,
          has_findings: Boolean(asOptionalString(asRecord(obs).findings_snippet)),
        })),
      derived_awareness: perplexityShadowObservations.length > 0
        ? `Hermes is aware of ${perplexityShadowObservations.length} recent Perplexity research observations, ` +
          `including ${perplexityShadowObservations.filter((obs) => asOptionalString(asRecord(obs).findings_snippet)).length} with findings.`
        : "No Perplexity shadow observations available. Use perplexity_ingest to push Perplexity research context.",
    },
    next_steps: planActions.map((pa) => ({
      step: pa.step,
      priority: pa.priority,
      status: pa.status,
    })),
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // Emit status report as fleet event/artifact
  try {
    if (!shouldSimulateOperationFailure(simulateFailures, "record_artifact_content", "status_report")) {
      await FLEET_CONTROL_PLANE.recordArtifactContent({
        agent_name: FLEET_AGENT_NAME,
        kind: "business_status_report",
        name: `${correlationId}-status-report.json`,
        body: JSON.stringify(redactMetadata(statusReport), null, 2),
        run_id: runId,
        intent: objective,
        repo: BUILD_INFO.repository,
        meta: { correlation_id: correlationId, run_id: runId, section: "status_report", structured: true, generated_at: observedAt },
      });
    }
  } catch (error) {
    cycleErrors.push("record_artifact_content(status_report) failed");
    queueFleetRetry("record_artifact_content(status_report)", correlationId, runId, error);
  }

  // ── End fleet run ──
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
        pending_knowledge_retry_count: fleetLifecycleState.pendingKnowledgeRetries
          .filter((retry) => retry.correlation_id === correlationId).length,
        knowledge_record_id: knowledgeRecordId,
        learning_count: learningMemoryRecords.length,
        decision_count: decisionMemoryRecords.length,
        blocked_action_count: blockedActions.length,
      },
    });
  } catch (error) {
    queueFleetRetry("record_run_end", correlationId, runId, error);
  }

  fleetLifecycleState.lastLearnCycle = observedAt;
  try {
    await sendFleetHeartbeat(finalStatus === "success" ? "idle" : "degraded", objective);
  } catch (error) {
    queueFleetRetry("heartbeat_pm_loop_end", correlationId, runId, error);
  }

  // ── Build final structured output ──
  const loopResult = {
    perceive: perceiveSection,
    recall: recallSection,
    plan: planSection,
    propose: proposeSection,
    learn: learnSection,
    status_report: statusReport,
    metadata: {
      correlation_id: correlationId,
      run_id: runId,
      status: finalStatus === "success" ? "ok" : "degraded",
      errors: cycleErrors,
      emitted_sections: emittedSections,
      knowledge_record_id: knowledgeRecordId,
      pending_retries: fleetLifecycleState.pendingRetries.filter((retry) => retry.correlation_id === correlationId),
      pending_knowledge_retries: fleetLifecycleState.pendingKnowledgeRetries.filter((retry) => retry.correlation_id === correlationId),
      heartbeat: buildHeartbeatStatus(finalStatus === "success" ? "idle" : "degraded", objective),
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(redactMetadata(loopResult), null, 2) }],
    isError: finalStatus !== "success",
  };
}

// ─── Perplexity Shadow handlers ────────────────────────────────────

async function handlePerplexityIngest(args: {
  thread_id?: string;
  query: string;
  findings?: string;
  context?: string;
  source_url?: string;
  correlation_id?: string;
  tags?: string[];
}) {
  const query = redactSecrets((args.query ?? "").trim());
  if (!query) {
    return { content: [{ type: "text", text: "Error: query is required" }], isError: true };
  }

  const correlationId = normalizeCorrelationId(args.correlation_id);
  const observedAt = nowIso();
  const threadId = asOptionalString(args.thread_id);
  const findings = asOptionalString(args.findings);
  const context = asOptionalString(args.context);
  const sourceUrl = asOptionalString(args.source_url);
  const tags = asStringArray(args.tags);

  const contentParts: string[] = [];
  contentParts.push(`Perplexity Query: ${query}`);
  if (threadId) contentParts.push(`Thread: ${threadId}`);
  if (findings) contentParts.push(`Findings: ${findings}`);
  if (context) contentParts.push(`Context: ${context}`);
  if (tags.length > 0) contentParts.push(`Tags: ${tags.join(", ")}`);

  const record = storeTypedMemoryRecord({
    category: "observation",
    content: contentParts.join(" | "),
    metadata: {
      source: "perplexity",
      source_type: "perplexity_research",
      query,
      thread_id: threadId ?? null,
      findings: findings ?? null,
      context: context ?? null,
      source_url: sourceUrl ?? null,
      tags,
      ingested_at: observedAt,
    },
    trace: {
      source: "perplexity",
      correlationId,
      timestamp: observedAt,
      confidence: findings ? "high" : "medium",
    },
  });

  console.error(
    "[perplexity_shadow] Ingested query into memory_id=" + record.id +
    " correlation_id=" + correlationId +
    " query_len=" + String(query.length),
  );

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "ingested",
        memory_id: record.id,
        category: record.category,
        query,
        thread_id: threadId,
        correlation_id: correlationId,
        ingested_at: observedAt,
      }, null, 2),
    }],
  };
}

async function handlePerplexityShadowStatus(args: {
  limit?: number;
  correlation_id?: string;
}) {
  const limit = Math.max(1, Math.min(100, asNonNegativeInt(args.limit, 20)));
  const correlationId = normalizeCorrelationId(args.correlation_id);
  const observedAt = nowIso();

  const perplexityRecords: Array<Record<string, unknown>> = [];
  try {
    const stmt = db.prepare(
      "SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'observation' AND metadata LIKE '%perplexity%' ORDER BY created_at DESC LIMIT ?",
    );
    stmt.bind([limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const meta = parseMetadata(row.metadata);
      perplexityRecords.push({
        memory_id: row.id,
        query: asOptionalString(meta.query) ?? "unknown",
        thread_id: asOptionalString(meta.thread_id) ?? null,
        findings_snippet: asOptionalString(meta.findings)?.slice(0, 300) ?? null,
        context: asOptionalString(meta.context) ?? null,
        source_url: asOptionalString(meta.source_url) ?? null,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        ingested_at: row.created_at,
        content: asOptionalString(row.content)?.slice(0, 500) ?? null,
      });
    }
    stmt.free();
  } catch {
    // Best-effort
  }

  const summary = perplexityRecords.length > 0
    ? `${perplexityRecords.length} Perplexity shadow observations available (${perplexityRecords.filter((r) => r.findings_snippet).length} with findings).`
    : "No Perplexity shadow observations found yet. Use perplexity_ingest to push Perplexity research context.";

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        summary,
        observation_count: perplexityRecords.length,
        observations: perplexityRecords,
        correlation_id: correlationId,
        generated_at: observedAt,
      }, null, 2),
    }],
  };
}

// ─── Factory API handlers ──────────────────────────────────────────

async function handleFactoryListSessions(args: Record<string, unknown>) {
  const limit = typeof args.limit === "number" ? args.limit : 10;
  const sessions = await listSessions(Math.min(limit, 50));
  return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
}

async function handleFactoryGetSession(args: Record<string, unknown>) {
  const sessionId = typeof args.session_id === "string" ? args.session_id : "";
  if (!sessionId) throw new Error("session_id is required");
  const includeMessages = args.include_messages === true;
  const messageLimit = typeof args.message_limit === "number" ? args.message_limit : 50;
  const session = await getSession(sessionId);
  let messages: unknown[] | undefined;
  if (includeMessages) {
    messages = await getSessionMessages(sessionId, Math.min(messageLimit, 100));
  }
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ ...session, messages: messages ?? undefined }, null, 2),
    }],
  };
}

async function handleFactoryCreateMission(args: Record<string, unknown>) {
  const title = typeof args.title === "string" ? args.title : "";
  const description = typeof args.description === "string" ? args.description : "";
  if (!title) throw new Error("title is required");
  if (!description) throw new Error("description is required");
  const mission = await createMission({
    title,
    description,
    repository: typeof args.repository === "string" ? args.repository : undefined,
    branch: typeof args.branch === "string" ? args.branch : undefined,
  });
  storeTypedMemoryRecord({
    category: "mission",
    content: `Created Factory mission: ${title}`,
    metadata: { mission_id: mission?.id },
    trace: { source: "factory_api", confidence: "high" },
  });
  return { content: [{ type: "text", text: JSON.stringify(mission, null, 2) }] };
}

// ─── Business Status Report handler ────────────────────────────────

async function handleBusinessStatusReport(args: { focus?: string; correlation_id?: string }) {
  const focus = redactSecrets((args.focus ?? "").trim());
  const correlationId = normalizeCorrelationId(args.correlation_id);

  // Recall project and workflow records
  const projects: Array<Record<string, unknown>> = [];
  const workflows: Array<Record<string, unknown>> = [];
  try {
    const projStmt = db.prepare("SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'project' ORDER BY created_at DESC LIMIT 10");
    while (projStmt.step()) {
      const row = projStmt.getAsObject() as Record<string, unknown>;
      projects.push({ memory_id: row.id, content: row.content, metadata: parseMetadata(row.metadata), created_at: row.created_at });
    }
    projStmt.free();

    const wfStmt = db.prepare("SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'workflow' ORDER BY created_at DESC LIMIT 10");
    while (wfStmt.step()) {
      const row = wfStmt.getAsObject() as Record<string, unknown>;
      workflows.push({ memory_id: row.id, content: row.content, metadata: parseMetadata(row.metadata), created_at: row.created_at });
    }
    wfStmt.free();
  } catch {
    // Read is best-effort
  }

  // Recall recent observations
  const recentObservations: Array<Record<string, unknown>> = [];
  try {
    const obsStmt = db.prepare("SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'observation' ORDER BY created_at DESC LIMIT 10");
    while (obsStmt.step()) {
      const row = obsStmt.getAsObject() as Record<string, unknown>;
      recentObservations.push({ memory_id: row.id, content: row.content, metadata: parseMetadata(row.metadata), created_at: row.created_at });
    }
    obsStmt.free();
  } catch {
    // Read is best-effort
  }

  // Recall pending approvals
  const pendingApprovals: Array<Record<string, unknown>> = [];
  try {
    const appStmt = db.prepare("SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'approval_request' ORDER BY created_at DESC LIMIT 10");
    while (appStmt.step()) {
      const row = appStmt.getAsObject() as Record<string, unknown>;
      pendingApprovals.push({ memory_id: row.id, content: row.content, metadata: parseMetadata(row.metadata), created_at: row.created_at });
    }
    appStmt.free();
  } catch {
    // Read is best-effort
  }

  const statusReport = {
    current_focus: focus
      ? focus
      : fleetLifecycleState.lastLearnCycle
        ? `Business operations (last learn: ${fleetLifecycleState.lastLearnCycle})`
        : "No active focus",
    observed_signals: recentObservations.map((obs) => ({
      memory_id: obs.memory_id,
      source: asOptionalString(asRecord(obs.metadata).source) ?? "hermes_memory",
      summary: asOptionalString(obs.content) ?? "observation recorded",
      timestamp: obs.created_at,
    })),
    active_projects: projects.map((p) => ({
      memory_id: p.memory_id,
      summary: asOptionalString(p.content) ?? "active project",
      status: asOptionalString(asRecord(p.metadata).status) ?? "unknown",
    })),
    active_workflows: workflows.map((w) => ({
      memory_id: w.memory_id,
      summary: asOptionalString(w.content) ?? "active workflow",
    })),
    pending_approvals: pendingApprovals.length + fleetLifecycleState.pendingApprovals,
    approval_details: pendingApprovals.map((a) => ({
      memory_id: a.memory_id,
      risk_level: asOptionalString(asRecord(a.metadata).risk_level) ?? "unknown",
      summary: asOptionalString(a.content) ?? "approval pending",
    })),
    blocked_capabilities: currentBlockedCapabilities(),
    perplexity_awareness: (() => {
      const perpRecords: Array<Record<string, unknown>> = [];
      try {
        const perpStmt = db.prepare(
          "SELECT id, category, content, metadata, created_at FROM memories WHERE category = 'observation' AND metadata LIKE '%perplexity%' ORDER BY created_at DESC LIMIT 5",
        );
        while (perpStmt.step()) {
          const row = perpStmt.getAsObject() as Record<string, unknown>;
          const meta = parseMetadata(row.metadata);
          perpRecords.push({
            memory_id: row.id,
            query: asOptionalString(meta.query) ?? "unknown",
            thread_id: asOptionalString(meta.thread_id) ?? null,
            ingested_at: row.created_at,
            has_findings: Boolean(asOptionalString(meta.findings)),
          });
        }
        perpStmt.free();
      } catch { /* best-effort */ }
      return {
        observation_count: perpRecords.length,
        recent_queries: perpRecords,
        summary: perpRecords.length > 0
          ? `${perpRecords.length} recent Perplexity shadow observation(s) available.`
          : "No Perplexity shadow observations. Use perplexity_ingest to push research context.",
      };
    })(),
    risks: pendingApprovals.map((a) => ({
      risk_level: asOptionalString(asRecord(a.metadata).risk_level) ?? "unknown",
      description: asOptionalString(a.content) ?? "risk identified",
    })),
    next_steps: [
      { step: "Review pending approvals", priority: "high", status: pendingApprovals.length > 0 ? "ready" : "none" },
      { step: "Address blocked capabilities", priority: "high", status: currentBlockedCapabilities().length > 0 ? "blocked" : "none" },
      { step: "Continue active project progress", priority: "medium", status: projects.length > 0 ? "ready" : "none" },
      { step: "Refine workflow patterns", priority: "medium", status: workflows.length > 0 ? "ready" : "none" },
    ],
    correlation_id: correlationId,
    generated_at: nowIso(),
    heartbeat: buildHeartbeatStatus("reporting", focus || "status_report"),
  };

  return { content: [{ type: "text", text: JSON.stringify(redactMetadata(statusReport), null, 2) }] };
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
  business_pm_loop: handleBusinessPmLoop,
  business_status_report: handleBusinessStatusReport,
  perplexity_ingest: handlePerplexityIngest,
  perplexity_shadow_status: handlePerplexityShadowStatus,
  factory_list_sessions: handleFactoryListSessions,
  factory_get_session: handleFactoryGetSession,
  factory_create_mission: handleFactoryCreateMission,
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
    storeTypedMemoryRecord({
      category: "decision",
      content: `Authorized ${level} action via ${name}`,
      metadata: { ...meta, decision_class: "mutation_audit" },
      trace: {
        source: "policy_audit",
        confidence: "high",
        correlationId: asOptionalString(args.validation_id) ?? undefined,
      },
    });
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

// ─── Telegram integration handlers ────────────────────────────────

async function handleTelegramStatus(): Promise<string> {
  try {
    const report = await handleBusinessStatusReport({ correlation_id: `telegram-status-${Date.now()}` });
    const data = typeof report === "string" ? JSON.parse(report) : report;
    const body = data?.content?.[0]?.text
      ? JSON.parse(data.content[0].text)
      : data;

    const lines: string[] = [];
    lines.push("*Hermes Status Report*");
    lines.push("");

    if (body.status_report) {
      const sr = body.status_report;
      if (sr.current_focus) lines.push(`🎯 *Focus:* ${sr.current_focus}`);
      if (typeof sr.pending_approvals === "number") lines.push(`⏳ *Pending Approvals:* ${sr.pending_approvals}`);
      if (Array.isArray(sr.blocked_capabilities) && sr.blocked_capabilities.length > 0) {
        lines.push(`🚫 *Blocked Capabilities:* ${sr.blocked_capabilities.join(", ")}`);
      } else {
        lines.push("🚫 *Blocked Capabilities:* none");
      }
      if (Array.isArray(sr.active_projects) && sr.active_projects.length > 0) {
        lines.push(`📂 *Active Projects:* ${sr.active_projects.join(", ")}`);
      } else if (Array.isArray(sr.projects) && sr.projects.length > 0) {
        lines.push(`📂 *Projects:* ${sr.projects.join(", ")}`);
      }
      if (sr.risks) {
        if (Array.isArray(sr.risks) && sr.risks.length > 0) {
          lines.push(`⚠️ *Risks:* ${sr.risks.join(", ")}`);
        } else if (typeof sr.risks === "string") {
          lines.push(`⚠️ *Risks:* ${sr.risks}`);
        }
      }
      if (Array.isArray(sr.next_steps) && sr.next_steps.length > 0) {
        lines.push(`📋 *Next Steps:* ${sr.next_steps.slice(0, 5).join("; ")}`);
      }
      if (sr.perplexity_awareness && typeof sr.perplexity_awareness.summary === "string") {
        lines.push(`🔍 *Perplexity:* ${sr.perplexity_awareness.summary}`);
      }
    } else if (body.focus || body.current_focus) {
      lines.push(`🎯 *Focus:* ${body.focus || body.current_focus}`);
      if (body.pending_approvals != null) lines.push(`⏳ *Pending Approvals:* ${body.pending_approvals}`);
      if (body.blocked_capabilities) lines.push(`🚫 *Blocked Capabilities:* ${Array.isArray(body.blocked_capabilities) ? body.blocked_capabilities.join(", ") : body.blocked_capabilities}`);
    } else {
      lines.push(JSON.stringify(body, null, 2).slice(0, 3000));
    }

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? redactSecrets(err.message) : String(err);
    return `⚠️ Error generating status: ${msg}`;
  }
}

async function handleTelegramCycle(): Promise<string> {
  try {
    const result = await handleBusinessPmLoop({
      objective: "Telegram-triggered business review cycle",
      correlation_id: `telegram-cycle-${Date.now()}`,
      recall_categories: ["decision", "workflow", "fact", "project", "observation", "learning", "capability_gap"],
      recall_limit: 15,
    });
    const data = typeof result === "string" ? JSON.parse(result) : result;
    const body = data?.content?.[0]?.text
      ? JSON.parse(data.content[0].text)
      : data;

    const lines: string[] = [];
    lines.push("*Business PM Cycle Complete*");
    lines.push("");

    if (body.status_report) {
      const sr = body.status_report;
      lines.push(`🎯 *Focus:* ${sr.current_focus || "N/A"}`);
      if (typeof sr.pending_approvals === "number") lines.push(`⏳ *Pending Approvals:* ${sr.pending_approvals}`);
      if (Array.isArray(sr.blocked_capabilities) && sr.blocked_capabilities.length > 0) {
        lines.push(`🚫 *Blocked:* ${sr.blocked_capabilities.join(", ")}`);
      }
      if (Array.isArray(sr.next_steps) && sr.next_steps.length > 0) {
        lines.push(`📋 *Next Steps:* ${sr.next_steps.slice(0, 5).join("; ")}`);
      }
      // Surface Perplexity awareness from status report
      if (sr.perplexity_awareness && typeof sr.perplexity_awareness.summary === "string") {
        lines.push(`🔍 *Perplexity:* ${sr.perplexity_awareness.summary}`);
      }
    }

    if (body.plan && !body.status_report) {
      if (typeof body.plan.focus === "string") lines.push(`🎯 *Focus:* ${body.plan.focus}`);
      if (Array.isArray(body.plan.actions) && body.plan.actions.length > 0) {
        const actionSummary = body.plan.actions.slice(0, 5)
          .map((a: Record<string, unknown>) => `• ${a.action || a.description || "unnamed"} [${a.status || "pending"}]`)
          .join("\n");
        lines.push(`📋 *Actions:*\n${actionSummary}`);
      }
    }

    if (body.propose) {
      const proposals = Array.isArray(body.propose) ? body.propose : (body.propose.actions || []);
      if (proposals.length > 0) {
        const risky = proposals.filter((p: Record<string, unknown>) =>
          p.status === "blocked" || p.approval_required === true
        );
        if (risky.length > 0) {
          lines.push(`⚠️ *${risky.length} action(s) require approval*`);
        }
      }
    }

    if (lines.length <= 3) {
      lines.push(JSON.stringify(body, null, 2).slice(0, 3000));
    }

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? redactSecrets(err.message) : String(err);
    return `⚠️ Error running cycle: ${msg}`;
  }
}

async function handleTelegramPerplexityPush(chatId: number, userId: number, text: string): Promise<string> {
  // Remove the command prefix
  const content = text.replace(/^\/perplexity\s*/i, "").trim();
  if (!content) {
    return "ℹ️ Usage: /perplexity <query> | <findings>\n\nPush Perplexity research context to Hermes for shadow learning. Separate query and findings with | (pipe).\n\nExample:\n/perplexity What are appraisal trends in Texas? | Texas appraisal values rising 5-10% YoY in major metros";
  }

  // Parse query and findings (separated by |)
  const parts = content.split("|").map((p) => p.trim());
  const query = parts[0] || content;
  const findings = parts.length > 1 ? parts.slice(1).join(" | ") : null;

  // Create a correlation ID
  const correlationId = `telegram-perplexity-${Date.now()}-${chatId}`;
  const observedAt = nowIso();

  const contentParts: string[] = [];
  contentParts.push(`Perplexity Query (via Telegram): ${query}`);
  if (findings) contentParts.push(`Findings: ${findings}`);
  contentParts.push(`Source: telegram_chat_${chatId}`);

  const record = storeTypedMemoryRecord({
    category: "observation",
    content: contentParts.join(" | "),
    metadata: {
      source: "perplexity",
      source_type: "perplexity_research",
      source_channel: "telegram",
      chat_id: chatId,
      user_id: userId,
      query,
      findings: findings ?? null,
      ingested_at: observedAt,
    },
    trace: {
      source: "perplexity",
      correlationId,
      timestamp: observedAt,
      confidence: findings ? "high" : "medium",
    },
  });

  console.error(
    "[perplexity_shadow] Ingested via Telegram into memory_id=" + record.id +
    " chat_id=" + String(chatId) +
    " query_len=" + String(query.length),
  );

  return findings
    ? `✅ Research context ingested.\n\n📋 *Query:* ${query.slice(0, 300)}\n📝 *Findings:* ${findings.slice(0, 300)}\n🆔 *ID:* ${record.id}\n\nI'll factor this into my next business PM cycle.`
    : `✅ Research query recorded.\n\n📋 *Query:* ${query.slice(0, 300)}\n🆔 *ID:* ${record.id}\n\nI'll factor this into my next business PM cycle. Add findings with: /perplexity ${query.slice(0, 100)} | <your findings>`;
}

async function handleTelegramText(chatId: number, userId: number, text: string): Promise<void> {
  storeTypedMemoryRecord({
    category: "observation",
    content: text,
    metadata: {
      source: "telegram",
      chat_id: chatId,
      user_id: userId,
    },
    trace: {
      source: "telegram",
      confidence: "medium",
      correlationId: `telegram-obs-${Date.now()}`,
    },
  });
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
  restoreLearningStateFromMemory();
  await ensureFleetStartupLifecycle();

  // ─── Telegram bot startup ──────────────────────────────────
  let telegramBot: TelegramBot | null = null;
  if (TELEGRAM_BOT_TOKEN) {
    const callbacks: TelegramBotCallbacks = {
      handleStatus: handleTelegramStatus,
      handleCycle: handleTelegramCycle,
      handlePerplexityPush: handleTelegramPerplexityPush,
      handleText: handleTelegramText,
    };
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, callbacks);
    telegramBot.start();
  } else {
    console.error("[telegram] HERMES_TELE_BOT_TOKEN not set (and no TELEGRAM_BOT_TOKEN fallback) — bot disabled");
  }

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
        if (HERMES_MCP_AUTH_TOKEN) {
          const auth = req.headers.authorization ?? "";
          const bearer = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
          if (bearer !== HERMES_MCP_AUTH_TOKEN) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
            return;
          }
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString();
          const rpc = JSON.parse(raw);

          const result = await handleRpc(rpc);

          if (result === null) {
            // Notification — no response body per MCP spec.
            res.writeHead(202, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            });
            res.end();
            return;
          }

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

type RpcRequest = { jsonrpc: string; id?: number | string | null; method: string; params?: Record<string, unknown> };

function isNotification(rpc: RpcRequest): boolean {
  return rpc.id === undefined || rpc.id === null;
}

async function handleRpc(rpc: RpcRequest): Promise<Record<string, unknown> | null> {
  // Notifications get no response per MCP spec.
  if (isNotification(rpc) && rpc.method !== "notifications/initialized") {
    return null;
  }

  switch (rpc.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
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
      // Notification — no response body, but acknowledge with empty SSE for spec compliance.
      return null;
    default:
      // If no id, it's an unrecognized notification — silently ignore.
      if (isNotification(rpc)) return null;
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
