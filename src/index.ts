#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import initSqlJs from "sql.js";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Config ────────────────────────────────────────────────────────

const HOSTINGER_TOKEN = process.env.HOSTINGER_API_TOKEN ?? "";
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY ?? "";
const VPS_ID = parseInt(process.env.HERMES_VPS_ID ?? "1511806", 10);
const DB_PATH = process.env.HERMES_DB_PATH ?? "./hermes.db";

// ─── SQLite via sql.js (pure JS, no native deps) ───────────────────

interface HermesDb {
  run(sql: string, params?: unknown[]): HermesDb;
  prepare(sql: string): { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean };
  export(): Uint8Array;
}

let db: HermesDb;

async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    const buf = readFileSync(DB_PATH);
    db = new SQL.Database(buf);
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

function saveDb() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = db.export();
  const buf = Buffer.from(data);
  writeFileSync(DB_PATH, buf);
}

// ─── HTTP helpers ──────────────────────────────────────────────────

async function hostingerGet(path: string) {
  const res = await fetch(`https://developers.hostinger.com${path}`, {
    headers: { Authorization: `Bearer ${HOSTINGER_TOKEN}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Hostinger ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hostingerPost(path: string, body?: unknown) {
  const res = await fetch(`https://developers.hostinger.com${path}`, {
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
];

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
  const p = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}/projects`);
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
}

async function handleVpsProjectLogs(args: { project: string }) {
  const l = await hostingerGet(`/api/vps/v1/virtual-machines/${VPS_ID}/projects/${args.project}/logs`);
  return { content: [{ type: "text", text: JSON.stringify(l, null, 2) }] };
}

async function handleVpsRestartProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/projects/${args.project}/restart`);
  return { content: [{ type: "text", text: `Project "${args.project}" restart initiated.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsStopProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/projects/${args.project}/stop`);
  return { content: [{ type: "text", text: `Project "${args.project}" stopped.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsStartProject(args: { project: string }) {
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/projects/${args.project}/start`);
  return { content: [{ type: "text", text: `Project "${args.project}" started.\n${JSON.stringify(r, null, 2)}` }] };
}

async function handleVpsDeploy(args: { name: string; compose_content: string; environment?: string }) {
  const body: Record<string, unknown> = { project_name: args.name, content: args.compose_content };
  if (args.environment) body.environment = args.environment;
  const r = await hostingerPost(`/api/vps/v1/virtual-machines/${VPS_ID}/projects`, body);
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
  db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
    [id, args.category, args.content, JSON.stringify(args.metadata ?? {})]);
  saveDb();
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
  db.run("INSERT INTO memories (id, category, content, metadata) VALUES (?, ?, ?, ?)",
    [id, "plan", planText, JSON.stringify({ goal: args.goal, context: args.context ?? "" })]);
  saveDb();

  return { content: [{ type: "text", text: `## Plan: ${args.goal}\n\n${planText}\n\n---\nStored [${id}]` }] };
}

// ─── Server ────────────────────────────────────────────────────────

const server = new Server(
  { name: "hermes-supervisor", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const handlers: Record<string, (a: any) => Promise<{ content: { type: string; text: string }[] }>> = {
      research: handleResearch, vps_info: handleVpsInfo, vps_metrics: handleVpsMetrics,
      vps_projects: handleVpsProjects, vps_project_logs: handleVpsProjectLogs,
      vps_restart_project: handleVpsRestartProject, vps_stop_project: handleVpsStopProject,
      vps_start_project: handleVpsStartProject, vps_deploy: handleVpsDeploy,
      vps_snapshot: handleVpsSnapshot, vps_restart: handleVpsRestart,
      memory_store: handleMemoryStore, memory_recall: handleMemoryRecall, plan: handlePlan,
    };
    if (name in handlers) return await handlers[name](args);
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});

// ─── Entrypoint ────────────────────────────────────────────────────

async function main() {
  await initDb();

  const argv = process.argv.slice(2);
  const useHttp = argv.includes("--http");
  const host = argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : "0.0.0.0";
  const port = argv.includes("--port") ? parseInt(argv[argv.indexOf("--port") + 1], 10) : 8150;

  if (useHttp) {
    console.error(`Hermes MCP starting on http://${host}:${port}`);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const { createServer } = await import("node:http");
    const httpServer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", name: "hermes-supervisor", version: "1.0.0" }));
        return;
      }
      await transport.handleRequest(req, res);
    });
    httpServer.listen(port, host);
    console.error(`Hermes MCP ready on ${host}:${port}`);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Hermes MCP running (stdio)");
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
