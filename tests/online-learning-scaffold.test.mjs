#!/usr/bin/env node

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
const VALIDATION_PREFIX = "VALIDATION-ONLINE";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function correlationId(suffix = "case") {
  return `${VALIDATION_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function mcpCall(method, params = {}) {
  const res = await fetch(HERMES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const raw = await res.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error("No SSE data line found");
  const envelope = JSON.parse(dataLine.slice(5).trim());
  if (envelope.error) throw new Error(`MCP error: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function callTool(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`No text response from tool ${name}`);
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function callToolRaw(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  return result.content?.[0]?.text || "";
}

async function testValOnline001() {
  console.log("\n=== VAL-ONLINE-001 research remains available ===");
  const tools = await mcpCall("tools/list");
  const names = tools.tools.map((tool) => tool.name);
  assert(names.includes("research"), "tools/list should include research");

  const text = await callToolRaw("research", {
    query: "Give one short factual sentence about residential appraisal workflow automation trends in 2026.",
  });
  assert(text.length > 40, "research response should be substantive");
  assert(!/mock|stub|placeholder/i.test(text), "research response should not look mocked");
  console.log("  PASS: research tool is available and returns live response text");
}

async function testValOnline004SeededAwareness() {
  console.log("\n=== VAL-ONLINE-004 WF1/order-intake asset seeding ===");
  const cid = correlationId("seed");
  const result = await callTool("business_pm_loop", {
    objective: `Seed online workflow awareness for appraisal ops [${cid}]`,
    correlation_id: cid,
  });

  const seeded = result.perceive?.workflow_summary?.seeded_asset_awareness || {};
  const sourcePaths = seeded.source_paths || [];
  assert(sourcePaths.some((p) => String(p).includes("/root/missions/neon-wf1")), "seeded source paths should include neon-wf1");
  assert(sourcePaths.some((p) => String(p).includes("/opt/motto-skills")), "seeded source paths should include motto-skills");
  assert((seeded.wf1_steps || []).length > 0, "seeded wf1 steps should be extracted");
  assert((seeded.order_intake_fields || []).length > 0, "order-intake fields should be extracted");
  console.log("  PASS: workflow awareness seeded from WF1 and order-intake assets");
}

async function testValOnline002003013() {
  console.log("\n=== VAL-ONLINE-002/003/013 missing prerequisites -> capability + local task (no secrets) ===");
  const cid = correlationId("prereq");
  const result = await callTool("business_pm_loop", {
    objective: `Handle blocked TaxNet workflow without portal session [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "collect_taxnetusa_parcel_data",
        type: "TaxNetUSA browser session workflow",
        description: "TaxNetUSA lookup is blocked: login required and session unavailable",
        missing_prerequisites: ["taxnetusa_authenticated_session", "taxnetusa_mfa_access"],
      },
    ],
  });

  const capabilityRequests = result.propose?.capability_requests || [];
  assert(capabilityRequests.length > 0, "missing portal prerequisites should create capability requests");
  const onlineReq = capabilityRequests.find((req) => String(req.source || "").includes("online_portal_prerequisite"));
  assert(onlineReq, "should include online portal prerequisite capability request");
  assert(String(onlineReq.portal_surface || "") === "taxnetusa", "portal surface should be taxnetusa");

  const localTasks = result.propose?.local_tasks || [];
  assert(localTasks.length > 0, "session-bound workflow should queue a local task");
  const browserTask = localTasks.find((task) => task.kind === "browser");
  assert(browserTask, "queued local task should be browser kind");

  const authNeeds = onlineReq.auth_session_needs || [];
  assert(authNeeds.length > 0, "auth/session needs should be represented");
  for (const need of authNeeds) {
    assert(typeof need.type === "string" && need.type.length > 0, "auth need must include type");
    assert(typeof need.handle === "string" && need.handle.length > 0, "auth need must include handle");
    assert(!/[=:\s]/.test(need.handle), "auth handle should be normalized and non-secret-like");
  }
  console.log("  PASS: blocked portal step became capability + local task with sanitized auth/session requirements");
}

async function testValOnline005Persistence() {
  console.log("\n=== VAL-ONLINE-005 online observations persist as learning/workflow/capability_gap ===");
  const cid = correlationId("persist");
  await callTool("business_pm_loop", {
    objective: `Persist online workflow observations [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "review_matrix_listing",
        type: "Matrix MLS browser session workflow",
        description: "Matrix lookup blocked because session is missing",
        missing_prerequisites: ["matrix_mls_authenticated_session"],
      },
      {
        action: "research_market_context",
        type: "research",
        description: "Headless-safe market context research",
      },
    ],
  });

  const capabilityRows = await callTool("memory_recall", { category: "capability_gap", query: cid, limit: 20 });
  const workflowRows = await callTool("memory_recall", { category: "workflow", query: cid, limit: 20 });
  const learningRows = await callTool("memory_recall", { category: "learning", query: cid, limit: 20 });

  const total = (Array.isArray(capabilityRows) ? capabilityRows.length : 0)
    + (Array.isArray(workflowRows) ? workflowRows.length : 0)
    + (Array.isArray(learningRows) ? learningRows.length : 0);
  assert(total > 0, "online observation should be persisted in typed memory");
  console.log("  PASS: online observations were persisted with typed categories");
}

async function testValOnline006007() {
  console.log("\n=== VAL-ONLINE-006/007 mixed classification and safe learning continuation ===");
  const cid = correlationId("mixed");
  const result = await callTool("business_pm_loop", {
    objective: `Classify mixed online steps and continue safe learning [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      { action: "research_appraisal_regulations", type: "research", description: "Headless-safe research step" },
      { action: "open_gmail_order_thread", type: "gmail browser session review", description: "Session-bound Gmail review step" },
      {
        action: "lookup_taxnet_record",
        type: "taxnetusa portal browser login",
        description: "Blocked because credentials/session are missing",
        missing_prerequisites: ["taxnetusa_authenticated_session"],
      },
    ],
  });

  const classes = result.propose?.online_step_classification || [];
  const classSet = new Set(classes.map((entry) => entry.execution_classification));
  assert(classSet.has("headless-safe"), "should classify at least one step as headless-safe");
  assert(classSet.has("session-bound"), "should classify at least one step as session-bound");
  assert(classSet.has("blocked"), "should classify at least one step as blocked");

  const continuation = result.status_report?.online_learning?.continue_safe_learning_when_blocked;
  assert(continuation === true, "safe online learning should continue when portal steps are blocked");
  console.log("  PASS: mixed steps are classified and blocked portal work does not halt safe learning");
}

async function testValOnline014DedupCorrelation() {
  console.log("\n=== VAL-ONLINE-014 duplicate blockers are correlated ===");
  const firstId = correlationId("dup1");
  const secondId = correlationId("dup2");
  const actionPayload = {
    action: "collect_taxnetusa_parcel_data",
    type: "TaxNetUSA browser session workflow",
    description: "TaxNet session unavailable, login required",
    missing_prerequisites: ["taxnetusa_authenticated_session"],
  };

  const first = await callTool("business_pm_loop", {
    objective: `Record first blocker encounter [${firstId}]`,
    correlation_id: firstId,
    proposed_actions: [actionPayload],
  });
  const firstReq = (first.propose?.capability_requests || []).find((req) =>
    String(req.source || "").includes("online_portal_prerequisite"));
  assert(firstReq, "first run should create online portal prerequisite request");

  const second = await callTool("business_pm_loop", {
    objective: `Record repeated blocker encounter [${secondId}]`,
    correlation_id: secondId,
    proposed_actions: [actionPayload],
  });
  const secondReq = (second.propose?.capability_requests || []).find((req) =>
    String(req.source || "").includes("online_portal_prerequisite"));
  assert(secondReq, "second run should include online portal prerequisite record");

  const reused = String(secondReq.source || "").includes("reused")
    || (firstReq.request_id && secondReq.request_id && firstReq.request_id === secondReq.request_id);
  assert(reused, "repeated blocker should reuse/reference existing capability request");
  assert(firstReq.blocker_key && secondReq.blocker_key && firstReq.blocker_key === secondReq.blocker_key,
    "repeated blocker should carry the same blocker correlation key");
  console.log("  PASS: repeated blocker reused correlated request instead of creating uncorrelated spam");
}

async function main() {
  console.log("Hermes Progressive Online Learning Scaffold Tests");
  console.log("=================================================");

  const health = await fetch(`${HERMES_URL}/health`);
  assert(health.ok, `Hermes health must be OK (got ${health.status})`);

  const tests = [
    testValOnline001,
    testValOnline004SeededAwareness,
    testValOnline002003013,
    testValOnline005Persistence,
    testValOnline006007,
    testValOnline014DedupCorrelation,
  ];

  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (error) {
      failed += 1;
      console.error(`  FAIL: ${error.message}`);
    }
  }

  console.log("\n=================================================");
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Fatal test error:", error);
  process.exit(1);
});
