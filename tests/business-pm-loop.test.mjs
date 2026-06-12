#!/usr/bin/env node
/**
 * Integration tests for the Hermes business PM loop and status report tools.
 *
 * These tests exercise the live Hermes MCP HTTP surface on 127.0.0.1:8150
 * and validate the behavior specified in VAL-LOOP-001 through VAL-LOOP-006.
 *
 * Run with: node tests/business-pm-loop.test.mjs
 *
 * Requirements:
 *   - Hermes must be running on http://127.0.0.1:8150
 *   - Fleet MCP must be configured (MOTTO_MCP_URL, MOTTO_MCP_AUTH_TOKEN)
 *   - No secret values should appear in any response
 */

const HERMES_URL = "http://127.0.0.1:8150";
const VALIDATION_PREFIX = "VALIDATION-LOOP";

// ─── Helpers ────────────────────────────────────────────────────────

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
  // Parse SSE format
  const dataLine = raw.split("\n").find(l => l.startsWith("data:"));
  if (!dataLine) throw new Error("No data line in SSE response");
  const envelope = JSON.parse(dataLine.slice(5).trim());
  if (envelope.error) throw new Error(`MCP error: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function callTool(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const content = result.content?.[0]?.text;
  if (!content) throw new Error(`No content in tool result for ${name}`);
  return JSON.parse(content);
}

function generateCorrelationId() {
  return `${VALIDATION_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertHasField(obj, field, context) {
  assert(obj && typeof obj === "object" && field in obj, `${context}: missing field "${field}"`);
}

// ─── Secret pattern check ────────────────────────────────────────

const SECRET_PATTERNS = [
  /[a-f0-9]{32,}/i,  // long hex strings (but be careful not to flag UUIDs)
  /sk-[a-zA-Z0-9]{20,}/,  // API key patterns
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,
  /password\s*[=:]\s*\S+/i,
  /api[_-]?key\s*[=:]\s*\S+/i,
  /token\s*[=:]\s*[a-f0-9]{16,}/i,
];

function checkNoSecrets(obj, path = "") {
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  // Skip UUID-like hex strings (8-4-4-4-12 format)
  const cleaned = str.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, "UUID");
  for (const pattern of SECRET_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      // Allow short hex in correlation IDs
      const matched = match[0];
      if (matched.length < 40 && /VALIDATION|correlation/i.test(path)) continue;
      // Flag potential secrets
      console.warn(`  WARN: Potential secret pattern at ${path}: ${matched.slice(0, 10)}...`);
    }
  }
}

// ─── Test Cases ────────────────────────────────────────────────────

async function testToolsList() {
  console.log("\n=== Test: business_pm_loop and business_status_report in tools/list ===");
  const result = await mcpCall("tools/list");
  const toolNames = result.tools.map(t => t.name);

  assert(toolNames.includes("business_pm_loop"), "business_pm_loop should be in tools/list");
  assert(toolNames.includes("business_status_report"), "business_status_report should be in tools/list");

  // Check risk metadata for new tools
  const pmLoop = result.tools.find(t => t.name === "business_pm_loop");
  assertHasField(pmLoop, "risk", "business_pm_loop");
  assert(pmLoop.risk.level === "low-impact-write", "business_pm_loop should be low-impact-write");
  assert(pmLoop.risk.mutating === false, "business_pm_loop should not be mutating");

  const statusReport = result.tools.find(t => t.name === "business_status_report");
  assertHasField(statusReport, "risk", "business_status_report");
  assert(statusReport.risk.level === "read-only", "business_status_report should be read-only");

  console.log("  PASS: Both tools present with correct risk metadata");
}

async function testValLoop001_StructuredOutput() {
  console.log("\n=== Test: VAL-LOOP-001 Structured perceive/recall/plan/propose/learn output ===");
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for structured PM loop output [${correlationId}]`,
    correlation_id: correlationId,
    observations: [
      { type: "test_signal", summary: "Validation observation for structured output test", source: "test", timestamp: new Date().toISOString(), confidence: "high" },
    ],
  });

  // Check top-level sections exist
  assertHasField(result, "perceive", "Loop result");
  assertHasField(result, "recall", "Loop result");
  assertHasField(result, "plan", "Loop result");
  assertHasField(result, "propose", "Loop result");
  assertHasField(result, "learn", "Loop result");
  assertHasField(result, "status_report", "Loop result");
  assertHasField(result, "metadata", "Loop result");

  // Verify perceive section has observations
  assertHasField(result.perceive, "observations", "perceive");
  assertHasField(result.perceive, "signals", "perceive");
  assert(result.perceive.observations.length > 0, "perceive should have observations");

  // Verify recall section has memory fields
  assertHasField(result.recall, "prior_decisions", "recall");
  assertHasField(result.recall, "prior_workflows", "recall");
  assertHasField(result.recall, "prior_facts", "recall");
  assertHasField(result.recall, "prior_projects", "recall");

  // Verify plan section has objective and actions
  assertHasField(result.plan, "objective", "plan");
  assertHasField(result.plan, "actions", "plan");
  assert(result.plan.actions.length > 0, "plan should have actions");

  // Verify propose section has classified actions
  assertHasField(result.propose, "actions", "propose");
  assertHasField(result.propose, "blocked_actions", "propose");

  // Verify learn section has records
  assertHasField(result.learn, "learning_records", "learn");
  assertHasField(result.learn, "decision_records", "learn");

  // Verify correlation_id is in metadata
  assert(result.metadata.correlation_id === correlationId, `correlation_id should match: expected ${correlationId}`);

  console.log("  PASS: All 5 canonical sections present with required sub-fields");
}

async function testValLoop002_PriorMemoryInPlans() {
  console.log("\n=== Test: VAL-LOOP-002 Prior memory/workflow/decision use in plans ===");
  const correlationId = generateCorrelationId();

  // Seed a decision, workflow, and fact into memory first
  await callTool("memory_store", {
    category: "decision",
    content: `VAL-LOOP-002 seeded decision: Use validation-prefixed records for all test data [${correlationId}]`,
    metadata: { source: "test_seed", correlation_id: correlationId, confidence: "high" },
  });

  await callTool("memory_store", {
    category: "workflow",
    content: `VAL-LOOP-002 seeded workflow: Validation workflow template for PM loop testing [${correlationId}]`,
    metadata: { source: "test_seed", correlation_id: correlationId, confidence: "high" },
  });

  await callTool("memory_store", {
    category: "fact",
    content: `VAL-LOOP-002 seeded fact: Hermes business PM loop must cite prior context [${correlationId}]`,
    metadata: { source: "test_seed", correlation_id: correlationId, confidence: "high" },
  });

  // Now run the PM loop with a related objective
  const result = await callTool("business_pm_loop", {
    objective: `Test that prior seeded context is cited in plans [${correlationId}]`,
    correlation_id: correlationId,
    recall_query: `VAL-LOOP-002`,
  });

  // Verify recall section found the seeded records
  const recallDecisions = result.recall.prior_decisions || [];
  const recallWorkflows = result.recall.prior_workflows || [];
  const recallFacts = result.recall.prior_facts || [];
  const totalRecalled = result.recall.total_recalled || 0;

  assert(totalRecalled > 0 || recallDecisions.length > 0 || recallWorkflows.length > 0 || recallFacts.length > 0,
    "Recall should find at least some of the seeded records");

  // Verify plan cites recalled records
  assertHasField(result.plan, "cited_records", "plan");
  const citedRecords = result.plan.cited_records || [];
  assert(citedRecords.length > 0, "Plan should cite recalled record IDs");

  console.log(`  PASS: Recall found ${totalRecalled} records; plan cites ${citedRecords.length} record IDs`);
}

async function testValLoop003_LearningDecisionPersistence() {
  console.log("\n=== Test: VAL-LOOP-003 Learning and decision persistence ===");
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Test learning and decision persistence [${correlationId}]`,
    correlation_id: correlationId,
    learnings: [
      {
        category: "learning",
        content: `VAL-LOOP-003 explicit learning: PM loop produces structured output [${correlationId}]`,
        source: "test",
        confidence: "high",
      },
      {
        category: "decision",
        content: `VAL-LOOP-003 explicit decision: Always persist outcomes with typed metadata [${correlationId}]`,
        source: "test",
        confidence: "high",
        material: true,
      },
    ],
  });

  // Verify learn section has learning and decision records
  const learningRecords = result.learn.learning_records || [];
  const decisionRecords = result.learn.decision_records || [];
  assert(learningRecords.length > 0, "Should have at least one learning record");
  assert(decisionRecords.length > 0, "Should have at least one decision record (always created from cycle outcome)");

  // Verify each record has memory_id and category
  for (const lr of learningRecords) {
    assertHasField(lr, "memory_id", "learning_record");
    assertHasField(lr, "category", "learning_record");
  }
  for (const dr of decisionRecords) {
    assertHasField(dr, "memory_id", "decision_record");
    assertHasField(dr, "category", "decision_record");
  }

  // Now verify the records are recallable via memory_recall
  const recalled = await callTool("memory_recall", {
    category: "learning",
    query: `VAL-LOOP-003`,
    limit: 10,
  });

  // memory_recall returns array of rows
  const rows = Array.isArray(recalled) ? recalled : [];
  const matchingRows = rows.filter(r =>
    typeof r.content === "string" && r.content.includes(correlationId)
  );
  assert(matchingRows.length > 0, "Learning records should be recallable via memory_recall");

  // Also check decision records
  const recalledDecisions = await callTool("memory_recall", {
    category: "decision",
    query: `VAL-LOOP-003`,
    limit: 10,
  });
  const decisionRows = Array.isArray(recalledDecisions) ? recalledDecisions : [];
  const matchingDecisionRows = decisionRows.filter(r =>
    typeof r.content === "string" && r.content.includes(correlationId)
  );
  assert(matchingDecisionRows.length > 0, "Decision records should be recallable via memory_recall");

  console.log(`  PASS: ${learningRecords.length} learning records and ${decisionRecords.length} decision records persisted and recallable`);
}

async function testValLoop004_ApprovalGatedProposals() {
  console.log("\n=== Test: VAL-LOOP-004 Approval-gated action proposals with risk levels ===");
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Test approval-gated action proposals [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      { action: "research_market_trends", type: "research", description: "Read-only research on market trends" },
      { action: "restart_hermes_service", type: "restart hermes", description: "Restart the Hermes Docker service" },
      { action: "full_vps_restart", type: "restart full VPS", description: "Full VPS restart" },
    ],
  });

  const classifiedActions = result.propose.actions || [];
  assert(classifiedActions.length === 3, `Should have 3 classified actions, got ${classifiedActions.length}`);

  // Research action should be read-only
  const researchAction = classifiedActions.find(a => a.action === "research_market_trends");
  assert(researchAction, "Research action should be present");
  assert(researchAction.risk_level === "read-only", `Research should be read-only, got ${researchAction.risk_level}`);
  assert(researchAction.approval_required === false, "Research should not require approval");
  assert(researchAction.status === "ready", "Research should be ready");

  // Hermes restart should be hermes-scoped
  const hermesAction = classifiedActions.find(a => a.action === "restart_hermes_service");
  assert(hermesAction, "Hermes restart action should be present");
  assert(hermesAction.risk_level === "hermes-scoped-mutation", `Hermes restart should be hermes-scoped-mutation, got ${hermesAction.risk_level}`);
  assert(hermesAction.approval_required === true, "Hermes restart should require approval");
  assert(hermesAction.status === "awaiting_approval", "Hermes restart should be awaiting_approval");

  // VPS restart should be dangerous
  const vpsAction = classifiedActions.find(a => a.action === "full_vps_restart");
  assert(vpsAction, "VPS restart action should be present");
  assert(vpsAction.risk_level === "dangerous-global-mutation", `VPS restart should be dangerous-global-mutation, got ${vpsAction.risk_level}`);
  assert(vpsAction.approval_required === true, "VPS restart should require approval");
  assert(vpsAction.status === "awaiting_approval", "VPS restart should be awaiting_approval");

  // Verify each action has required fields
  for (const action of classifiedActions) {
    assertHasField(action, "risk_level", `action ${action.action}`);
    assertHasField(action, "approval_required", `action ${action.action}`);
    assertHasField(action, "expected_outcome", `action ${action.action}`);
    assertHasField(action, "status", `action ${action.action}`);
  }

  console.log("  PASS: All actions correctly risk-classified with approval metadata");
}

async function testValLoop005_UnsafeActionsBlocked() {
  console.log("\n=== Test: VAL-LOOP-005 Unsafe actions blocked without approval ===");
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Test unsafe action blocking [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      { action: "stop_unrelated_project", type: "stop project nginx-proxy", description: "Stop an unrelated project" },
      { action: "create_snapshot", type: "snapshot", description: "Create VPS snapshot" },
      { action: "submit_portal_form", type: "submit portal form", description: "Submit a business form on TaxNetUSA portal" },
    ],
  });

  // All three should be blocked
  const blockedActions = result.propose.blocked_actions || [];
  assert(blockedActions.length === 3, `Should have 3 blocked actions, got ${blockedActions.length}`);

  // Verify each blocked action has blocked_reason
  for (const ba of blockedActions) {
    assertHasField(ba, "risk_level", "blocked_action");
    assertHasField(ba, "blocked_reason", "blocked_action");
    assert(ba.risk_level === "dangerous-global-mutation" || ba.risk_level === "hermes-scoped-mutation",
      `Blocked action should be dangerous or hermes-scoped, got ${ba.risk_level}`);
  }

  // Verify approval requests were created
  const approvalRequests = result.propose.approval_requests || [];
  assert(approvalRequests.length > 0, "Should have at least one approval request for blocked actions");

  // Verify the classified actions have awaiting_approval status
  const classifiedActions = result.propose.actions || [];
  const awaitingApproval = classifiedActions.filter(a => a.status === "awaiting_approval");
  assert(awaitingApproval.length === 3, `All 3 dangerous actions should be awaiting_approval, got ${awaitingApproval.length}`);

  console.log(`  PASS: ${blockedActions.length} unsafe actions blocked with approval requests`);
}

async function testValLoop006_BusinessStatusReport() {
  console.log("\n=== Test: VAL-LOOP-006 Business operations status and next steps report ===");
  const correlationId = generateCorrelationId();

  // First run a PM loop to seed some data
  await callTool("business_pm_loop", {
    objective: `Seed data for status report test [${correlationId}]`,
    correlation_id: correlationId,
    observations: [
      { type: "deployment_signal", summary: "Hermes deployment is healthy", source: "vps_monitor" },
    ],
  });

  // Now get the status report
  const report = await callTool("business_status_report", {
    focus: `Validation status report test [${correlationId}]`,
    correlation_id: correlationId,
  });

  // Verify status report sections
  assertHasField(report, "current_focus", "status_report");
  assertHasField(report, "observed_signals", "status_report");
  assertHasField(report, "active_projects", "status_report");
  assertHasField(report, "pending_approvals", "status_report");
  assertHasField(report, "blocked_capabilities", "status_report");
  assertHasField(report, "risks", "status_report");
  assertHasField(report, "next_steps", "status_report");

  // Verify next_steps has content
  assert(report.next_steps.length > 0, "Status report should have next steps");

  // Also verify the PM loop's inline status_report
  const loopResult = await callTool("business_pm_loop", {
    objective: `Test inline status report [${correlationId}]`,
    correlation_id: correlationId,
  });

  assertHasField(loopResult, "status_report", "PM loop result");
  assertHasField(loopResult.status_report, "current_focus", "inline status_report");
  assertHasField(loopResult.status_report, "observed_signals", "inline status_report");
  assertHasField(loopResult.status_report, "active_projects", "inline status_report");
  assertHasField(loopResult.status_report, "pending_approvals", "inline status_report");
  assertHasField(loopResult.status_report, "blocked_capabilities", "inline status_report");
  assertHasField(loopResult.status_report, "risks", "inline status_report");
  assertHasField(loopResult.status_report, "next_steps", "inline status_report");

  console.log("  PASS: Status report has all required sections (focus, signals, projects, approvals, capabilities, risks, next_steps)");
}

// ─── Run all tests ──────────────────────────────────────────────────

async function main() {
  console.log("Hermes Business PM Loop Integration Tests");
  console.log("========================================");

  // Health check first
  try {
    const res = await fetch(`${HERMES_URL}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    const health = await res.json();
    console.log(`Hermes health: ${health.status} v${health.version}`);
  } catch (err) {
    console.error(`FATAL: Hermes not reachable at ${HERMES_URL}: ${err.message}`);
    process.exit(1);
  }

  const tests = [
    testToolsList,
    testValLoop001_StructuredOutput,
    testValLoop002_PriorMemoryInPlans,
    testValLoop003_LearningDecisionPersistence,
    testValLoop004_ApprovalGatedProposals,
    testValLoop005_UnsafeActionsBlocked,
    testValLoop006_BusinessStatusReport,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (err) {
      console.error(`  FAIL: ${err.message}`);
      failed += 1;
    }
  }

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
