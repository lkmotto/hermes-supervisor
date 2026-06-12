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
const MOTTO_SKILLS_TOOLS_DIR = process.env.MOTTO_SKILLS_TOOLS_DIR?.trim() || "/root/motto-skills/tools";
const MOTTO_KNOWLEDGE_DIR = process.env.MOTTO_KNOWLEDGE_DIR?.trim() || join(homedir(), ".factory", "knowledge");
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
}

interface KnowledgeFailureRecord {
  operation: string;
  correlation_id: string;
  run_id: string | null;
  error: string;
  queued_at: string;
  status: "pending_retry";
}

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
  fleet_operations?: unknown[];
  fleet_sections?: unknown[];
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
  pendingKnowledgeRetries: [] as KnowledgeFailureRecord[],
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

type BridgeStoreType = "workflow-library" | "decision-log" | "knowledge-distiller";

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
    default:
      return `${MOTTO_KNOWLEDGE_DIR}/facts.json#${recordId}`;
  }
}

function executeMottoSkillsTool(scriptName: string, command: string, payload: Record<string, unknown>): Record<string, unknown> {
  const scriptPath = join(MOTTO_SKILLS_TOOLS_DIR, scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`motto-skills tool missing: ${scriptPath}`);
  }
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
  stmt.bind([`%\"local_task_id\":\"${taskId}\"%`]);
  const found = stmt.step();
  stmt.free();
  return found;
}

function recentBridgeReferences(limit: number): Array<Record<string, unknown>> {
  const stmt = db.prepare(
    "SELECT id, category, metadata, created_at FROM memories WHERE metadata LIKE ? ORDER BY created_at DESC LIMIT ?",
  );
  stmt.bind(["%\"bridge_store_type\"%", Math.max(1, Math.trunc(limit))]);
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
  try {
    const stmt = db.prepare(
      "SELECT category, metadata, created_at FROM memories ORDER BY created_at DESC LIMIT 50",
    );
    const blocked = new Set<string>(fleetLifecycleState.blockedCapabilities);
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const metadata = parseMetadata(row.metadata);
      if (!fleetLifecycleState.lastLearnCycle) {
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
  };
  fleetLifecycleState.pendingRetries.push(record);
  if (fleetLifecycleState.pendingRetries.length > 25) {
    fleetLifecycleState.pendingRetries.shift();
  }
  fleetLifecycleState.lastError = record.error;
  persistFleetRetry(record);
}

function persistKnowledgeRetry(record: KnowledgeFailureRecord) {
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
  const record: KnowledgeFailureRecord = {
    operation,
    correlation_id: correlationId,
    run_id: runId,
    error: redactSecrets(error instanceof Error ? error.message : String(error)),
    queued_at: nowIso(),
    status: "pending_retry",
  };
  fleetLifecycleState.pendingKnowledgeRetries.push(record);
  if (fleetLifecycleState.pendingKnowledgeRetries.length > 25) {
    fleetLifecycleState.pendingKnowledgeRetries.shift();
  }
  fleetLifecycleState.lastError = record.error;
  persistKnowledgeRetry(record);
}

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
        proposed_actions: { type: "array", items: { type: "object" }, description: "Proposed business actions for risk classification and approval gating." },
        capability_gaps: { type: "array", items: { type: "object" }, description: "Known capability blockers and missing prerequisites." },
        learnings: { type: "array", items: { type: "object" }, description: "Learnings captured from the cycle to persist as learning and decision records." },
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
          description: "Memory categories to recall for the recall phase. Default: decision, workflow, fact, project.",
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

function classifyActionRisk(action: Record<string, unknown>): {
  risk_level: ActionRiskLevel;
  approval_required: boolean;
  blocked: boolean;
  blocked_reason?: string;
} {
  const toolName = asOptionalString(action.tool ?? action.tool_name);
  const actionType = asOptionalString(action.type ?? action.action ?? action.kind) ?? "";
  const actionTypeLower = actionType.toLowerCase();

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
  if (/restart\s+(full\s+)?vps|vps\s+restart/i.test(actionType)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "VPS restart is a dangerous/global action requiring explicit approval." };
  }
  if (/snapshot/i.test(actionType)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "VPS snapshot is a dangerous/global action requiring explicit approval." };
  }
  if (/stop\s+(project|service)/i.test(actionType) && !/hermes/i.test(actionType)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Stopping a non-Hermes project is a dangerous/global action requiring explicit approval." };
  }
  if (/deploy|restart\s+project|start\s+project/i.test(actionType) && !/hermes/i.test(actionType)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Non-Hermes project deployment/control is a dangerous/global action requiring explicit approval." };
  }
  if (/restart\s+hermes|redeploy\s+hermes|deploy\s+hermes|start\s+hermes/i.test(actionType)) {
    return { risk_level: "hermes-scoped-mutation", approval_required: true, blocked: true, blocked_reason: "Hermes-scoped mutation requires validation evidence and approval." };
  }
  if (/submit|send\s+email|purchase|order|credential\s+change|portal\s+mutation/i.test(actionType)) {
    return { risk_level: "dangerous-global-mutation", approval_required: true, blocked: true, blocked_reason: "Business-impacting online mutation requires explicit approval." };
  }
  if (/research|read|query|list|info|metrics|logs|recall|status|report/i.test(actionType)) {
    return { risk_level: "read-only", approval_required: false, blocked: false };
  }
  if (/store\s+memory|plan|write\s+memory|record|emit|log\s+decision/i.test(actionType)) {
    return { risk_level: "low-impact-write", approval_required: false, blocked: false };
  }

  // Default: if the action mentions mutating keywords, classify as hermes-scoped
  if (/restart|deploy|stop|start|create|delete|update|modify|change/i.test(actionType)) {
    return { risk_level: "hermes-scoped-mutation", approval_required: true, blocked: true, blocked_reason: "Potential mutating action requires approval before execution." };
  }

  // Default to low-impact-write for unspecified actions
  return { risk_level: "low-impact-write", approval_required: false, blocked: false };
}

// ─── Business PM Loop handler ─────────────────────────────────────

interface BusinessPmLoopArgs {
  objective: string;
  correlation_id?: string;
  observations?: unknown[];
  proposed_actions?: unknown[];
  capability_gaps?: unknown[];
  learnings?: unknown[];
  coordination_intents?: unknown[];
  local_tasks?: unknown[];
  capability_requests?: unknown[];
  consume_intents_limit?: number;
  recall_categories?: unknown[];
  recall_query?: string;
  recall_limit?: number;
  ingest_completed_local_tasks?: boolean;
  local_task_ingest_limit?: number;
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
    return {
      ...r,
      source: asOptionalString(r.source) ?? "user_input",
      timestamp: asOptionalString(r.timestamp) ?? observedAt,
      confidence: asOptionalString(r.confidence) ?? "medium",
      correlation_id: correlationId,
    };
  });

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

  const perceiveSection = {
    observations,
    signals: perceivedSignals,
    consumed_intents_count: consumedInboundIntents.length,
    correlation_id: correlationId,
    generated_at: observedAt,
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 2: RECALL — Retrieve prior decisions, workflows, memories
  // ════════════════════════════════════════════════════════════════

  const defaultRecallCategories = ["decision", "workflow", "fact", "project"];
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

  const recallSection = {
    prior_decisions: recalledMemories.filter((m) => m.category === "decision"),
    prior_workflows: recalledMemories.filter((m) => m.category === "workflow"),
    prior_facts: recalledMemories.filter((m) => m.category === "fact"),
    prior_projects: recalledMemories.filter((m) => m.category === "project"),
    other_memories: recalledMemories.filter(
      (m) => !["decision", "workflow", "fact", "project"].includes(m.category as string),
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

  const planActions = [
    {
      step: "Review and triage observations",
      owner: "hermes",
      priority: "high",
      dependencies: [],
      timing: "immediate",
      success_criteria: "All observations categorized and prioritized",
      status: "ready",
      evidence_ids: [],
    },
    {
      step: "Integrate recalled decisions and workflows into current plan",
      owner: "hermes",
      priority: "high",
      dependencies: [],
      timing: "immediate",
      success_criteria: "Prior context properly referenced and applied",
      status: citedRecordIds.length > 0 ? "ready" : "none",
      evidence_ids: citedRecordIds,
    },
    {
      step: "Execute safe proposed actions",
      owner: "hermes",
      priority: "high",
      dependencies: ["Review and triage observations"],
      timing: "next_cycle",
      success_criteria: "All safe actions completed or queued",
      status: "ready",
      evidence_ids: [],
    },
    {
      step: "Resolve blocked capabilities and pending approvals",
      owner: "hermes",
      priority: "medium",
      dependencies: ["Execute safe proposed actions"],
      timing: "next_cycle",
      success_criteria: "Blockers resolved or escalated",
      status: "blocked",
      evidence_ids: [],
    },
    {
      step: "Capture and persist learning outcomes",
      owner: "hermes",
      priority: "medium",
      dependencies: ["Execute safe proposed actions"],
      timing: "end_of_cycle",
      success_criteria: "All learnings and decisions persisted with metadata",
      status: "ready",
      evidence_ids: [],
    },
  ];

  const planSection = {
    objective,
    correlation_id: correlationId,
    generated_at: observedAt,
    cited_records: citedRecordIds,
    cited_bridged_knowledge: citedBridgeIds,
    inbound_intent_ids: consumedInboundIntents
      .map((intent) => asRecord(intent).intent_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    actions: planActions,
    summary: recalledMemories.length > 0
      ? `Plan synthesized with ${recalledMemories.length} recalled memory records and ${recalledBridgeReferences.length} bridged knowledge references.`
      : "Plan synthesized from current observations and objective without prior context.",
  };

  // ════════════════════════════════════════════════════════════════
  // PHASE 4: PROPOSE — Risk-classify actions, block unsafe, create records
  // ════════════════════════════════════════════════════════════════

  const proposedActions = asArray(args.proposed_actions);
  const classifiedActions: Array<Record<string, unknown>> = [];
  const blockedActions: Array<Record<string, unknown>> = [];
  const approvalRequestRecords: Array<Record<string, unknown>> = [];

  for (let i = 0; i < proposedActions.length; i++) {
    const action = asRecord(proposedActions[i]);
    const riskClassification = classifyActionRisk(action);

    const classifiedAction: Record<string, unknown> = {
      ...action,
      risk_level: riskClassification.risk_level,
      approval_required: riskClassification.approval_required,
      expected_outcome: asOptionalString(action.expected_outcome) ?? asOptionalString(action.description) ?? `Outcome of action: ${asOptionalString(action.action ?? action.type ?? action.kind) ?? `action-${i + 1}`}`,
      status: riskClassification.blocked ? "awaiting_approval" : (asOptionalString(action.status) ?? "ready"),
      correlation_id: correlationId,
    };

    classifiedActions.push(classifiedAction);

    if (riskClassification.blocked) {
      blockedActions.push({
        action_reference: asOptionalString(action.action ?? action.type ?? action.kind) ?? `proposed_action_${i}`,
        risk_level: riskClassification.risk_level,
        blocked_reason: riskClassification.blocked_reason ?? "Action requires approval",
        original_action: action,
        correlation_id: correlationId,
      });

      // Persist an approval request in memory
      const approvalMemory = storeTypedMemoryRecord({
        category: "approval_request",
        content: `Approval required for ${riskClassification.risk_level} action: ${asOptionalString(action.action ?? action.type ?? action.kind) ?? `action-${i + 1}`}. ${riskClassification.blocked_reason ?? ""}`,
        metadata: {
          proposed_action_index: i,
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
        risk_level: riskClassification.risk_level,
      });

      // Create a capability request for the blocked action if it needs a specific capability
      if (riskClassification.risk_level === "dangerous-global-mutation" && FLEET_CONTROL_PLANE.isConfigured()) {
        try {
          if (!shouldSimulateOperationFailure(simulateFailures, "request_capability", "propose")) {
            await FLEET_CONTROL_PLANE.requestCapability({
              capability: `approval_for_${riskClassification.risk_level}_action`,
              justification: `[${correlationId}] Action "${asOptionalString(action.action ?? action.type ?? action.kind) ?? `action-${i + 1}`}" is classified as ${riskClassification.risk_level} and requires explicit human approval: ${riskClassification.blocked_reason ?? "policy requires approval"}`,
              requested_by: FLEET_AGENT_NAME,
            });
          }
        } catch (error) {
          cycleErrors.push(`request_capability for blocked action ${i} failed`);
          queueFleetRetry("request_capability", correlationId, runId, error);
        }
      }

      // Queue a local task for browser/session-bound actions
      if (riskClassification.risk_level === "dangerous-global-mutation" && FLEET_CONTROL_PLANE.isConfigured()) {
        const actionTypeLower = (asOptionalString(action.type ?? action.action ?? action.kind) ?? "").toLowerCase();
        if (/browser|portal|session|gmail|taxnet|matrix|mls|cad|comet/i.test(actionTypeLower)) {
          try {
            if (!shouldSimulateOperationFailure(simulateFailures, "queue_local_task", "propose")) {
              await FLEET_CONTROL_PLANE.queueLocalTask({
                kind: "browser",
                payload: {
                  ...action,
                  correlation_id: correlationId,
                  run_id: runId,
                  objective,
                  risk_level: riskClassification.risk_level,
                  queued_at: observedAt,
                  created_by: FLEET_AGENT_NAME,
                },
                description: `Browser/session-bound task for ${objective}: ${asOptionalString(action.action ?? action.type ?? action.kind) ?? `action-${i + 1}`}`,
                source: FLEET_AGENT_NAME,
                dedup_key: `${correlationId}:blocked:${i}:${actionTypeLower}`,
                ttl_seconds: 600,
              });
            }
          } catch (error) {
            cycleErrors.push(`queue_local_task for blocked action ${i} failed`);
            queueFleetRetry("queue_local_task", correlationId, runId, error);
          }
        }
      }
    }
  }

  // Signal coordination intents
  const signaledIntents: Array<Record<string, unknown>> = [];
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
  const queuedLocalTasks: Array<Record<string, unknown>> = [];
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

  // File capability requests
  const filedCapabilityRequests: Array<Record<string, unknown>> = [];
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
    approval_requests: approvalRequestRecords,
    coordination_intents: signaledIntents,
    local_tasks: queuedLocalTasks,
    capability_requests: filedCapabilityRequests,
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
    validation_evidence: validationEvidenceEntries(args as unknown as Record<string, unknown>),
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
    })),
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
      })),
    pending_approvals: blockedActions.length + fleetLifecycleState.pendingApprovals,
    blocked_capabilities: currentBlockedCapabilities(),
    risks: blockedActions.map((ba) => ({
      action: asOptionalString(asRecord(ba).action_reference) ?? "unknown",
      risk_level: asOptionalString(asRecord(ba).risk_level) ?? "unknown",
      reason: asOptionalString(asRecord(ba).blocked_reason) ?? "requires approval",
    })),
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
    current_focus: focus || fleetLifecycleState.lastLearnCycle
      ? `Business operations (last learn: ${fleetLifecycleState.lastLearnCycle ?? "never"})`
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
