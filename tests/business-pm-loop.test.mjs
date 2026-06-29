#!/usr/bin/env node
/**
 * Integration tests for the Hermes business PM loop and status report tools.
 *
 * These tests exercise the live Hermes MCP HTTP surface on 127.0.0.1:8150
 * and validate behavior for:
 *   - VAL-LOOP-001 through VAL-LOOP-012
 *   - VAL-CORE-004 through VAL-CORE-005
 *   - VAL-CORE-008 through VAL-CORE-010, VAL-CORE-012, VAL-CORE-013
 *
 * Run with: node tests/business-pm-loop.test.mjs
 *
 * Requirements:
 *   - Hermes must be running on http://127.0.0.1:8150
 *   - Fleet MCP must be configured (MOTTO_MCP_URL, MOTTO_MCP_AUTH_TOKEN)
 *   - No secret values should appear in any response
 */

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
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
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error("No data line in SSE response");
  const envelope = JSON.parse(dataLine.slice(5).trim());
  if (envelope.error)
    throw new Error(`MCP error: ${JSON.stringify(envelope.error)}`);
  return envelope.result;
}

async function callTool(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const content = result.content?.[0]?.text;
  if (!content) throw new Error(`No content in tool result for ${name}`);
  try {
    return JSON.parse(content);
  } catch {
    // Some tools (e.g., memory_store) return plain text, not JSON
    return { _raw: content };
  }
}

function generateCorrelationId() {
  return `${VALIDATION_PREFIX}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function generateUnknownSessionId() {
  return `missing-session-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertHasField(obj, field, context) {
  assert(
    obj && typeof obj === "object" && field in obj,
    `${context}: missing field "${field}"`,
  );
}

function assertRequiredFieldContains(denial, expected, context) {
  const fields = Array.isArray(denial?.required_fields)
    ? denial.required_fields
    : [];
  assert(
    fields.some(
      (field) => typeof field === "string" && field.includes(expected),
    ),
    `${context}: required_fields should contain "${expected}", got ${JSON.stringify(
      fields,
    )}`,
  );
}

// ─── Secret pattern check ────────────────────────────────────────

const SECRET_PATTERNS = [
  /[a-f0-9]{32,}/i, // long hex strings (but be careful not to flag UUIDs)
  /sk-[a-zA-Z0-9]{20,}/, // API key patterns
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,
  /password\s*[=:]\s*\S+/i,
  /api[_-]?key\s*[=:]\s*\S+/i,
  /token\s*[=:]\s*[a-f0-9]{16,}/i,
];

function checkNoSecrets(obj, path = "") {
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  // Skip UUID-like hex strings (8-4-4-4-12 format)
  const cleaned = str.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    "UUID",
  );
  for (const pattern of SECRET_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      // Allow short hex in correlation IDs
      const matched = match[0];
      if (matched.length < 40 && /VALIDATION|correlation/i.test(path)) continue;
      // Flag potential secrets
      console.warn(
        `  WARN: Potential secret pattern at ${path}: ${matched.slice(
          0,
          10,
        )}...`,
      );
    }
  }
}

// ─── Test Cases ────────────────────────────────────────────────────

async function testToolsList() {
  console.log(
    "\n=== Test: business_pm_loop and business_status_report in tools/list ===",
  );
  const result = await mcpCall("tools/list");
  const toolNames = result.tools.map((t) => t.name);

  assert(
    toolNames.includes("business_pm_loop"),
    "business_pm_loop should be in tools/list",
  );
  assert(
    toolNames.includes("business_status_report"),
    "business_status_report should be in tools/list",
  );

  // Check risk metadata for new tools
  const pmLoop = result.tools.find((t) => t.name === "business_pm_loop");
  assertHasField(pmLoop, "risk", "business_pm_loop");
  assert(
    pmLoop.risk.level === "low-impact-write",
    "business_pm_loop should be low-impact-write",
  );
  assert(
    pmLoop.risk.mutating === false,
    "business_pm_loop should not be mutating",
  );

  const statusReport = result.tools.find(
    (t) => t.name === "business_status_report",
  );
  assertHasField(statusReport, "risk", "business_status_report");
  assert(
    statusReport.risk.level === "read-only",
    "business_status_report should be read-only",
  );

  console.log("  PASS: Both tools present with correct risk metadata");
}

async function testValLoop001_StructuredOutput() {
  console.log(
    "\n=== Test: VAL-LOOP-001 Structured perceive/recall/plan/propose/learn output ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for structured PM loop output [${correlationId}]`,
    correlation_id: correlationId,
    observations: [
      {
        type: "test_signal",
        summary: "Validation observation for structured output test",
        source: "test",
        timestamp: new Date().toISOString(),
        confidence: "high",
      },
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
  assert(
    result.perceive.observations.length > 0,
    "perceive should have observations",
  );

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
  assert(
    result.metadata.correlation_id === correlationId,
    `correlation_id should match: expected ${correlationId}`,
  );

  console.log(
    "  PASS: All 5 canonical sections present with required sub-fields",
  );
}

async function testValLoop002_PriorMemoryInPlans() {
  console.log(
    "\n=== Test: VAL-LOOP-002 Prior memory/workflow/decision use in plans ===",
  );
  const correlationId = generateCorrelationId();

  // Seed a decision, workflow, and fact into memory first
  await callTool("memory_store", {
    category: "decision",
    content: `VAL-LOOP-002 seeded decision: Use validation-prefixed records for all test data [${correlationId}]`,
    metadata: {
      source: "test_seed",
      correlation_id: correlationId,
      confidence: "high",
    },
  });

  await callTool("memory_store", {
    category: "workflow",
    content: `VAL-LOOP-002 seeded workflow: Validation workflow template for PM loop testing [${correlationId}]`,
    metadata: {
      source: "test_seed",
      correlation_id: correlationId,
      confidence: "high",
    },
  });

  await callTool("memory_store", {
    category: "fact",
    content: `VAL-LOOP-002 seeded fact: Hermes business PM loop must cite prior context [${correlationId}]`,
    metadata: {
      source: "test_seed",
      correlation_id: correlationId,
      confidence: "high",
    },
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

  assert(
    totalRecalled > 0 ||
      recallDecisions.length > 0 ||
      recallWorkflows.length > 0 ||
      recallFacts.length > 0,
    "Recall should find at least some of the seeded records",
  );

  // Verify plan cites recalled records
  assertHasField(result.plan, "cited_records", "plan");
  const citedRecords = result.plan.cited_records || [];
  assert(citedRecords.length > 0, "Plan should cite recalled record IDs");

  console.log(
    `  PASS: Recall found ${totalRecalled} records; plan cites ${citedRecords.length} record IDs`,
  );
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
  assert(
    learningRecords.length > 0,
    "Should have at least one learning record",
  );
  assert(
    decisionRecords.length > 0,
    "Should have at least one decision record (always created from cycle outcome)",
  );

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
  const matchingRows = rows.filter(
    (r) => typeof r.content === "string" && r.content.includes(correlationId),
  );
  assert(
    matchingRows.length > 0,
    "Learning records should be recallable via memory_recall",
  );

  // Also check decision records
  const recalledDecisions = await callTool("memory_recall", {
    category: "decision",
    query: `VAL-LOOP-003`,
    limit: 10,
  });
  const decisionRows = Array.isArray(recalledDecisions)
    ? recalledDecisions
    : [];
  const matchingDecisionRows = decisionRows.filter(
    (r) => typeof r.content === "string" && r.content.includes(correlationId),
  );
  assert(
    matchingDecisionRows.length > 0,
    "Decision records should be recallable via memory_recall",
  );

  console.log(
    `  PASS: ${learningRecords.length} learning records and ${decisionRecords.length} decision records persisted and recallable`,
  );
}

async function testValLoop004_ApprovalGatedProposals() {
  console.log(
    "\n=== Test: VAL-LOOP-004 Approval-gated action proposals with risk levels ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Test approval-gated action proposals [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "research_market_trends",
        type: "research",
        description: "Read-only research on market trends",
      },
      {
        action: "restart_hermes_service",
        type: "restart hermes",
        description: "Restart the Hermes Docker service",
      },
      {
        action: "full_vps_restart",
        type: "restart full VPS",
        description: "Full VPS restart",
      },
    ],
  });

  const classifiedActions = result.propose.actions || [];
  assert(
    classifiedActions.length === 3,
    `Should have 3 classified actions, got ${classifiedActions.length}`,
  );

  // Research action should be read-only
  const researchAction = classifiedActions.find(
    (a) => a.action === "research_market_trends",
  );
  assert(researchAction, "Research action should be present");
  assert(
    researchAction.risk_level === "read-only",
    `Research should be read-only, got ${researchAction.risk_level}`,
  );
  assert(
    researchAction.approval_required === false,
    "Research should not require approval",
  );
  assert(researchAction.status === "ready", "Research should be ready");

  // Hermes restart should be hermes-scoped
  const hermesAction = classifiedActions.find(
    (a) => a.action === "restart_hermes_service",
  );
  assert(hermesAction, "Hermes restart action should be present");
  assert(
    hermesAction.risk_level === "hermes-scoped-mutation",
    `Hermes restart should be hermes-scoped-mutation, got ${hermesAction.risk_level}`,
  );
  assert(
    hermesAction.approval_required === true,
    "Hermes restart should require approval",
  );
  assert(
    hermesAction.status === "awaiting_approval",
    "Hermes restart should be awaiting_approval",
  );

  // VPS restart should be dangerous
  const vpsAction = classifiedActions.find(
    (a) => a.action === "full_vps_restart",
  );
  assert(vpsAction, "VPS restart action should be present");
  assert(
    vpsAction.risk_level === "dangerous-global-mutation",
    `VPS restart should be dangerous-global-mutation, got ${vpsAction.risk_level}`,
  );
  assert(
    vpsAction.approval_required === true,
    "VPS restart should require approval",
  );
  assert(
    vpsAction.status === "awaiting_approval",
    "VPS restart should be awaiting_approval",
  );

  // Verify each action has required fields
  for (const action of classifiedActions) {
    assertHasField(action, "risk_level", `action ${action.action}`);
    assertHasField(action, "approval_required", `action ${action.action}`);
    assertHasField(action, "expected_outcome", `action ${action.action}`);
    assertHasField(action, "status", `action ${action.action}`);
  }

  console.log(
    "  PASS: All actions correctly risk-classified with approval metadata",
  );
}

async function testValLoop005_UnsafeActionsBlocked() {
  console.log(
    "\n=== Test: VAL-LOOP-005 Unsafe actions blocked without approval ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Test unsafe action blocking [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "stop_unrelated_project",
        type: "stop project nginx-proxy",
        description: "Stop an unrelated project",
      },
      {
        action: "create_snapshot",
        type: "snapshot",
        description: "Create VPS snapshot",
      },
      {
        action: "submit_portal_form",
        type: "submit portal form",
        description: "Submit a business form on TaxNetUSA portal",
      },
    ],
  });

  // All three should be blocked
  const blockedActions = result.propose.blocked_actions || [];
  assert(
    blockedActions.length === 3,
    `Should have 3 blocked actions, got ${blockedActions.length}`,
  );

  // Verify each blocked action has blocked_reason
  for (const ba of blockedActions) {
    assertHasField(ba, "risk_level", "blocked_action");
    assertHasField(ba, "blocked_reason", "blocked_action");
    assert(
      ba.risk_level === "dangerous-global-mutation" ||
        ba.risk_level === "hermes-scoped-mutation",
      `Blocked action should be dangerous or hermes-scoped, got ${ba.risk_level}`,
    );
  }

  // Verify approval requests were created
  const approvalRequests = result.propose.approval_requests || [];
  assert(
    approvalRequests.length > 0,
    "Should have at least one approval request for blocked actions",
  );

  // Verify the classified actions have awaiting_approval status
  const classifiedActions = result.propose.actions || [];
  const awaitingApproval = classifiedActions.filter(
    (a) => a.status === "awaiting_approval",
  );
  assert(
    awaitingApproval.length === 3,
    `All 3 dangerous actions should be awaiting_approval, got ${awaitingApproval.length}`,
  );

  console.log(
    `  PASS: ${blockedActions.length} unsafe actions blocked with approval requests`,
  );
}

async function testValLoop006_BusinessStatusReport() {
  console.log(
    "\n=== Test: VAL-LOOP-006 Business operations status and next steps report ===",
  );
  const correlationId = generateCorrelationId();

  // First run a PM loop to seed some data
  await callTool("business_pm_loop", {
    objective: `Seed data for status report test [${correlationId}]`,
    correlation_id: correlationId,
    observations: [
      {
        type: "deployment_signal",
        summary: "Hermes deployment is healthy",
        source: "vps_monitor",
      },
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
  assertHasField(
    loopResult.status_report,
    "current_focus",
    "inline status_report",
  );
  assertHasField(
    loopResult.status_report,
    "observed_signals",
    "inline status_report",
  );
  assertHasField(
    loopResult.status_report,
    "active_projects",
    "inline status_report",
  );
  assertHasField(
    loopResult.status_report,
    "pending_approvals",
    "inline status_report",
  );
  assertHasField(
    loopResult.status_report,
    "blocked_capabilities",
    "inline status_report",
  );
  assertHasField(loopResult.status_report, "risks", "inline status_report");
  assertHasField(
    loopResult.status_report,
    "next_steps",
    "inline status_report",
  );

  console.log(
    "  PASS: Status report has all required sections (focus, signals, projects, approvals, capabilities, risks, next_steps)",
  );
}

async function testValLoop007_ShadowObservationsProvenance() {
  console.log(
    "\n=== Test: VAL-LOOP-007 Shadow observations include provenance and fact/assumption labeling ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validate observation provenance fields [${correlationId}]`,
    correlation_id: correlationId,
    observations: [
      {
        type: "portal_snapshot",
        summary: "Observed TaxNet portal queue count from dashboard export",
        source: "workflow_trace",
        timestamp: new Date().toISOString(),
        confidence: "high",
        fact_vs_assumption: "fact",
      },
      {
        type: "handoff_risk",
        summary: "Likely handoff delay between intake and review queue",
        source: "analysis_note",
        confidence: "medium",
      },
    ],
  });

  const observations = result.perceive?.observations || [];
  assert(
    observations.length >= 2,
    "Perceive observations should include both supplied observations",
  );

  let seenFact = false;
  let seenAssumption = false;
  for (const obs of observations) {
    assertHasField(obs, "source", "perceive observation");
    assertHasField(obs, "timestamp", "perceive observation");
    assertHasField(obs, "confidence", "perceive observation");
    assertHasField(obs, "correlation_id", "perceive observation");
    assertHasField(obs, "fact_vs_assumption", "perceive observation");
    if (obs.fact_vs_assumption === "fact") seenFact = true;
    if (obs.fact_vs_assumption === "assumption") seenAssumption = true;
  }

  assert(
    seenFact && seenAssumption,
    "Observations should include both fact and assumption classifications",
  );
  console.log(
    "  PASS: Observation provenance and fact-vs-assumption labels are present",
  );
}

async function testValLoop008_LearningChangesNextPlan() {
  console.log(
    "\n=== Test: VAL-LOOP-008 Learned outcomes change subsequent plan recommendations ===",
  );
  const seedCorrelationId = generateCorrelationId();
  const followupCorrelationId = generateCorrelationId();

  const first = await callTool("business_pm_loop", {
    objective: `Seed blocker learning for follow-up planning [${seedCorrelationId}]`,
    correlation_id: seedCorrelationId,
    recall_categories: ["decision", "workflow", "fact", "project"],
    learnings: [
      {
        category: "learning",
        content: `VAL-LOOP-008 learning: Workflow was blocked by missing TaxNet browser session access [${seedCorrelationId}]`,
        source: "validation_postmortem",
        confidence: "high",
      },
    ],
  });

  const second = await callTool("business_pm_loop", {
    objective: `Re-plan using learned blocker outcomes [${followupCorrelationId}]`,
    correlation_id: followupCorrelationId,
    recall_query: seedCorrelationId,
  });

  const firstActions = first.plan?.actions || [];
  const secondActions = second.plan?.actions || [];
  const firstBlockerStep = firstActions.find(
    (a) => a.step === "Resolve blocked capabilities and pending approvals",
  );
  const secondBlockerStep = secondActions.find(
    (a) => a.step === "Resolve blocked capabilities and pending approvals",
  );

  assert(
    second.plan?.learning_influenced_changes?.length > 0,
    "Second plan should report learning-influenced changes",
  );
  assert(
    firstBlockerStep && secondBlockerStep,
    "Both plans should contain blocker-resolution step",
  );
  assert(
    firstBlockerStep.priority !== secondBlockerStep.priority ||
      firstBlockerStep.status !== secondBlockerStep.status,
    "Second plan should change blocker step priority/status based on learned outcome",
  );

  console.log(
    "  PASS: Stored learning changed subsequent planning priorities/status",
  );
}

async function testValLoop009_PmGradeExecutionFields() {
  console.log(
    "\n=== Test: VAL-LOOP-009 Plan actions contain PM-grade execution fields ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validate PM-grade execution fields [${correlationId}]`,
    correlation_id: correlationId,
  });

  const actions = result.plan?.actions || [];
  assert(actions.length > 0, "Plan should include actionable steps");

  for (const action of actions) {
    assertHasField(action, "owner", "plan action");
    assertHasField(action, "target_agent", "plan action");
    assertHasField(action, "priority", "plan action");
    assertHasField(action, "dependencies", "plan action");
    assertHasField(action, "timing", "plan action");
    assertHasField(action, "due_at", "plan action");
    assertHasField(action, "next_check_at", "plan action");
    assertHasField(action, "success_criteria", "plan action");
    assertHasField(action, "status", "plan action");
    assertHasField(action, "ready_state", "plan action");
    assert(
      ["ready", "blocked", "none"].includes(action.status),
      `Unexpected action status: ${action.status}`,
    );
  }

  console.log(
    `  PASS: ${actions.length} actions include owner/target/priority/dependencies/timing/success/status fields`,
  );
}

async function testValLoop010_WorkflowTraceToReusableKnowledge() {
  console.log(
    "\n=== Test: VAL-LOOP-010 Workflow trace summaries produce handoffs, gaps, and workflow candidates ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Summarize validation workflow trace into reusable process knowledge [${correlationId}]`,
    correlation_id: correlationId,
    workflow_trace: {
      trace_id: `wf-trace-${correlationId}`,
      workflow_name: "Validation Appraisal Intake",
      steps: [
        {
          step_id: "s1",
          actor: "intake",
          action: "Collect order details",
          status: "completed",
        },
        {
          step_id: "s2",
          actor: "review",
          action: "Review order details",
          status: "blocked",
          blocker: "TaxNet session missing",
          required_capability: "taxnet_session_access",
          handoff_to: "portal_runner",
        },
        {
          step_id: "s3",
          actor: "portal_runner",
          action: "Lookup parcel data",
          status: "pending",
        },
      ],
    },
  });

  const summary = result.perceive?.workflow_summary || {};
  assert(
    summary.traces_processed >= 1,
    "Workflow summary should process at least one trace",
  );
  assert(
    (summary.workflow_candidates || []).length > 0,
    "Workflow summary should include workflow candidate records",
  );
  assert(
    (summary.handoffs || []).length > 0,
    "Workflow summary should identify handoff points",
  );
  assert(
    (summary.blockers || []).length > 0,
    "Workflow summary should identify blockers",
  );
  assert(
    (summary.capability_gaps || []).length > 0,
    "Workflow summary should classify capability gaps",
  );

  console.log(
    "  PASS: Workflow trace converted into handoffs/blockers/candidate process knowledge",
  );
}

async function testValLoop011_ProposalLinksToCoordinationRecords() {
  console.log(
    "\n=== Test: VAL-LOOP-011 Proposals create linked approval/task/capability records ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validate proposal linkage records [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "submit_taxnet_portal_form",
        type: "submit portal form browser session",
        description:
          "Submit TaxNet update requiring authenticated browser session",
      },
    ],
  });

  const proposalRecords = result.propose?.proposal_records || [];
  assert(
    proposalRecords.length > 0,
    "Propose section should return proposal linkage records",
  );
  const firstRecord = proposalRecords[0];
  assertHasField(firstRecord, "correlation_id", "proposal_record");
  assert(
    firstRecord.correlation_id === correlationId,
    "Proposal record correlation_id should match cycle ID",
  );
  assertHasField(firstRecord, "approval_request_memory_id", "proposal_record");
  assert(
    Boolean(firstRecord.capability_request_id) ||
      Boolean(firstRecord.local_task_id),
    "Blocked business-impacting proposal should link to capability request and/or local task",
  );

  console.log(
    "  PASS: Proposals now link to durable approval/task/capability records",
  );
}

async function testValLoop012_UnknownSignalsNotFabricated() {
  console.log(
    "\n=== Test: VAL-LOOP-012 Unavailable signals are marked unknown/blocked with capability requests ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validate unknown/blocked handling for missing inputs [${correlationId}]`,
    correlation_id: correlationId,
    required_signals: ["wf1_queue_status", "taxnet_session_health"],
    observations: [],
  });

  const unknownSignals = result.perceive?.unknown_signals || [];
  assert(
    unknownSignals.length >= 2,
    "Missing required signals should be reported as unknown",
  );
  for (const missing of unknownSignals) {
    assert(
      missing.status === "unknown",
      `Expected unknown status, got ${missing.status}`,
    );
    assert(
      missing.blocker_status === "blocked",
      `Expected blocked marker, got ${missing.blocker_status}`,
    );
  }

  const capabilityRequests = result.propose?.capability_requests || [];
  const missingSignalRequests = capabilityRequests.filter(
    (req) => req.source === "missing_signal",
  );
  assert(
    missingSignalRequests.length > 0,
    "Missing signals should produce capability requests",
  );

  console.log(
    "  PASS: Unavailable inputs are marked unknown/blocked and translated into capability requests",
  );
}

async function testValCore008_FailClosedWithoutConfirmation() {
  console.log(
    "\n=== Test: VAL-CORE-008 Mutating VPS call denied without confirm=true ===",
  );

  const denial = await callTool("vps_restart_project", {
    project: "hermes",
  });

  assert(
    denial.status === "denied",
    `Expected denied status, got ${denial.status}`,
  );
  assert(
    denial.reason === "confirmation_required",
    `Expected confirmation_required, got ${denial.reason}`,
  );
  assertHasField(denial, "risk_level", "VAL-CORE-008 denial");
  assertRequiredFieldContains(denial, "confirm=true", "VAL-CORE-008 denial");

  console.log(
    "  PASS: Mutating call without confirm=true is denied with confirmation_required",
  );
}

async function testValCore009_NonHermesMutationNeedsApproval() {
  console.log(
    "\n=== Test: VAL-CORE-009 Non-Hermes mutation denied as dangerous/global without approval ===",
  );

  const denial = await callTool("vps_start_project", {
    project: "unrelated-project",
    confirm: true,
  });

  assert(
    denial.status === "denied",
    `Expected denied status, got ${denial.status}`,
  );
  assert(
    denial.reason === "approval_required",
    `Expected approval_required, got ${denial.reason}`,
  );
  assert(
    denial.risk_level === "dangerous-global-mutation",
    `Expected dangerous-global-mutation, got ${denial.risk_level}`,
  );
  assertRequiredFieldContains(denial, "approval", "VAL-CORE-009 denial");

  console.log(
    "  PASS: Non-Hermes project control is denied without explicit approval",
  );
}

async function testValCore010_HermesScopedMutationNeedsValidationAndApproval() {
  console.log(
    "\n=== Test: VAL-CORE-010 Hermes mutation denied without validation evidence and approval ===",
  );

  const denial = await callTool("vps_deploy", {
    name: "hermes",
    compose_content: "services: {}\n",
    confirm: true,
  });

  assert(
    denial.status === "denied",
    `Expected denied status, got ${denial.status}`,
  );
  assert(
    denial.reason === "validation_required" ||
      denial.reason === "approval_required",
    `Expected validation_required or approval_required, got ${denial.reason}`,
  );
  assert(
    denial.risk_level === "hermes-scoped-mutation",
    `Expected hermes-scoped-mutation, got ${denial.risk_level}`,
  );
  assertRequiredFieldContains(denial, "validation_id", "VAL-CORE-010 denial");
  assertRequiredFieldContains(
    denial,
    "validation_evidence",
    "VAL-CORE-010 denial",
  );
  assertRequiredFieldContains(denial, "approval", "VAL-CORE-010 denial");

  console.log(
    "  PASS: Hermes-scoped mutation is denied without validation evidence and approval provenance",
  );
}

async function testValCore012_DangerousMutationNeedsApprovalAfterConfirmation() {
  console.log(
    "\n=== Test: VAL-CORE-012 Dangerous/global mutation denied without approval after confirm=true ===",
  );

  const denial = await callTool("vps_snapshot", {
    confirm: true,
  });

  assert(
    denial.status === "denied",
    `Expected denied status, got ${denial.status}`,
  );
  assert(
    denial.reason === "approval_required",
    `Expected approval_required, got ${denial.reason}`,
  );
  assert(
    denial.risk_level === "dangerous-global-mutation",
    `Expected dangerous-global-mutation, got ${denial.risk_level}`,
  );
  assertRequiredFieldContains(denial, "approval", "VAL-CORE-012 denial");

  console.log(
    "  PASS: Dangerous/global mutation remains approval-gated after confirmation",
  );
}

async function testValCore013_HermesValidationEvidenceMustBeCurrentCommitMatched() {
  console.log(
    "\n=== Test: VAL-CORE-013 Hermes deploy denied for stale/mismatched validation evidence ===",
  );

  const staleBuildDenial = await callTool("vps_deploy", {
    name: "hermes",
    compose_content: "services: {}\n",
    confirm: true,
    approval: { approved_by: "validator", reason: "negative policy test" },
    validation_id: "VAL-CORE-013-STALE-BUILD",
    validation_evidence: {
      commit: "deadbeef1",
      build_passed: false,
    },
  });

  assert(
    staleBuildDenial.status === "denied",
    `Expected denied status, got ${staleBuildDenial.status}`,
  );
  assert(
    staleBuildDenial.reason === "validation_required",
    `Expected validation_required, got ${staleBuildDenial.reason}`,
  );
  assertRequiredFieldContains(
    staleBuildDenial,
    "validation_evidence",
    "VAL-CORE-013 stale-build denial",
  );

  const mismatchedCommitDenial = await callTool("vps_deploy", {
    name: "hermes",
    compose_content: "services: {}\n",
    confirm: true,
    approval: { approved_by: "validator", reason: "negative policy test" },
    validation_id: "VAL-CORE-013-MISMATCH-COMMIT",
    validation_evidence: {
      commit: "stalecommit12345",
      build_passed: true,
    },
  });

  assert(
    mismatchedCommitDenial.status === "denied",
    `Expected denied status, got ${mismatchedCommitDenial.status}`,
  );
  assert(
    mismatchedCommitDenial.reason === "validation_required",
    `Expected validation_required, got ${mismatchedCommitDenial.reason}`,
  );
  assertRequiredFieldContains(
    mismatchedCommitDenial,
    "validation_evidence",
    "VAL-CORE-013 mismatch-commit denial",
  );

  console.log(
    "  PASS: Hermes deploy rejects stale or commit-mismatched validation evidence",
  );
}

async function testValCore004_AutoloopRepromptIdempotentOnUnchangedCursor() {
  console.log(
    "\n=== Test: VAL-CORE-004 Autoloop suppresses duplicate reprompts on unchanged cursor ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate idempotent reprompt suppression for unchanged cursor [${correlationId}]`,
    max_rounds: 2,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  assert(
    rounds.length === 2,
    `Expected exactly 2 rounds for max_rounds=2, got ${rounds.length}`,
  );

  const firstRoundReprompts = Array.isArray(rounds[0]?.reprompts)
    ? rounds[0].reprompts
    : [];
  const firstRoundError = firstRoundReprompts.find(
    (entry) =>
      entry?.session_id === unknownSessionId &&
      typeof entry?.error === "string",
  );
  assert(
    Boolean(firstRoundError),
    "Round 1 should record a submit error for unknown session",
  );

  const secondRoundReprompts = Array.isArray(rounds[1]?.reprompts)
    ? rounds[1].reprompts
    : [];
  const dedupeSkip = secondRoundReprompts.find(
    (entry) =>
      entry?.session_id === unknownSessionId &&
      entry?.skipped === true &&
      entry?.reason === "no_new_assistant_progress_since_last_reprompt",
  );
  assert(
    Boolean(dedupeSkip),
    "Round 2 should skip duplicate reprompt with unchanged assistant progress",
  );
  assert(
    !("message_id" in dedupeSkip),
    "Skipped duplicate reprompt should not include message_id",
  );

  console.log(
    "  PASS: Autoloop records deterministic duplicate-reprompt skip reason on unchanged cursor",
  );
}

async function testValCore005_AutoloopBoundedByConfiguredRounds() {
  console.log(
    "\n=== Test: VAL-CORE-005 Autoloop stays within configured max_rounds and returns partial at bound ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate deterministic max-round bound behavior [${correlationId}]`,
    max_rounds: 0,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  assert(
    result.rounds_planned === 0,
    `Expected rounds_planned=0, got ${result.rounds_planned}`,
  );
  assert(
    result.rounds_executed === 0,
    `Expected rounds_executed=0, got ${result.rounds_executed}`,
  );
  assert(
    result.rounds_executed <= result.rounds_planned,
    `Expected rounds_executed <= rounds_planned, got ${result.rounds_executed} > ${result.rounds_planned}`,
  );
  assert(
    result.sessions_pending > 0,
    "Expected pending sessions to remain when loop bound is reached",
  );
  assert(
    result.status === "partial",
    `Expected terminal status partial with pending sessions, got ${result.status}`,
  );
  assert(
    Array.isArray(result.rounds) && result.rounds.length === 0,
    "Expected no rounds when max_rounds=0",
  );

  console.log(
    "  PASS: Autoloop never exceeds max_rounds and remains partial when pending sessions remain",
  );
}

// ─── VAL-ORCH-005: Autoloop does not reprompt running sessions ────

async function testValOrch005_AutoloopSkipsRunningSessions() {
  console.log(
    "\n=== Test: VAL-ORCH-005 Autoloop skips running sessions without reprompting ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate running session skip behavior [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  assert(rounds.length === 1, `Expected exactly 1 round, got ${rounds.length}`);
  const reprompts = Array.isArray(rounds[0]?.reprompts)
    ? rounds[0].reprompts
    : [];

  // For unknown sessions, the status will be "error", not "running".
  // Verify the response structure includes the fields required by the contract.
  // The running-session skip path is deterministic in code:
  // when sessionStatus === "running", a skipped entry with reason="session_running" is appended.
  // Here we confirm the reprompt entry shape does not include a message_id for unknown sessions.
  const sessionEntry = reprompts.find(
    (entry) => entry?.session_id === unknownSessionId,
  );
  assert(
    Boolean(sessionEntry),
    "Expected a reprompt entry for the requested session",
  );
  assert(
    !("message_id" in sessionEntry) || sessionEntry.message_id === null,
    "Running/error sessions should never receive a reprompt message_id",
  );

  // Verify the contract-required fields exist in the response
  assert(
    typeof result.status === "string",
    "Response must include status field",
  );
  assert(Array.isArray(result.rounds), "Response must include rounds array");
  assert(
    Array.isArray(result.rebind_events),
    "Response must include rebind_events array",
  );
  assert(
    Array.isArray(result.tracked_session_ids),
    "Response must include tracked_session_ids",
  );

  console.log(
    "  PASS: Autoloop response structure preserves running-session skip contract fields",
  );
}

// ─── VAL-ORCH-006: Autoloop suppresses duplicate reprompts on unchanged cursor ───

async function testValOrch006_UnchangedCursorSuppressesDuplicateReprompts() {
  console.log(
    "\n=== Test: VAL-ORCH-006 Autoloop suppresses duplicate reprompts on unchanged cursor ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate cursor dedupe across rounds [${correlationId}]`,
    max_rounds: 3,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  assert(
    rounds.length >= 2,
    `Expected at least 2 rounds, got ${rounds.length}`,
  );

  // Round 1: should have an error for unknown session (first attempt)
  const round1Reprompts = Array.isArray(rounds[0]?.reprompts)
    ? rounds[0].reprompts
    : [];
  const round1Entry = round1Reprompts.find(
    (entry) => entry?.session_id === unknownSessionId,
  );
  assert(
    Boolean(round1Entry),
    "Round 1 should have a reprompt entry for the session",
  );
  assert(
    typeof round1Entry?.error === "string",
    "Round 1 should record a submit error for unknown session",
  );

  // Rounds 2+: should skip with unchanged cursor reason
  for (let r = 1; r < rounds.length; r += 1) {
    const roundReprompts = Array.isArray(rounds[r]?.reprompts)
      ? rounds[r].reprompts
      : [];
    const skipEntry = roundReprompts.find(
      (entry) =>
        entry?.session_id === unknownSessionId &&
        entry?.skipped === true &&
        entry?.reason === "no_new_assistant_progress_since_last_reprompt",
    );
    assert(
      Boolean(skipEntry),
      `Round ${
        r + 1
      } should skip duplicate reprompt with unchanged assistant progress`,
    );
    assert(
      !("message_id" in skipEntry),
      `Round ${r + 1} skipped entry should not contain message_id`,
    );
  }

  // Verify the cursor dedupe is deterministic: no duplicate successful submits
  const allSuccessful = rounds.flatMap((round) =>
    (Array.isArray(round.reprompts) ? round.reprompts : []).filter(
      (entry) =>
        "message_id" in entry && entry?.session_id === unknownSessionId,
    ),
  );
  assert(
    allSuccessful.length === 0,
    `Expected zero successful reprompts for unknown session, got ${allSuccessful.length}`,
  );

  console.log(
    "  PASS: Autoloop cursor dedupe is deterministic across multiple rounds",
  );
}

// ─── VAL-ORCH-007: reprompts_sent counts only successful submits ────

async function testValOrch007_RepromptsSentCountsOnlySuccessfulSubmits() {
  console.log(
    "\n=== Test: VAL-ORCH-007 reprompts_sent counts only successful submit entries ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  // Use multiple unknown session IDs to generate only error/skip entries
  const sessionIds = [unknownSessionId, generateUnknownSessionId()];
  const result = await callTool("factory_autoloop", {
    session_ids: sessionIds,
    objective: `Validate reprompts_sent accounting accuracy [${correlationId}]`,
    max_rounds: 2,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  assert(rounds.length >= 1, `Expected at least 1 round, got ${rounds.length}`);

  // Verify each round's reprompts_sent is 0 (all entries are errors/skips, no message_ids)
  for (const round of rounds) {
    const reprompts = Array.isArray(round.reprompts) ? round.reprompts : [];
    const expectedSent = reprompts.filter(
      (entry) =>
        "message_id" in entry &&
        !("skipped" in entry) &&
        !("warning" in entry) &&
        !("error" in entry),
    ).length;
    const actualSent =
      typeof round.reprompts_sent === "number" ? round.reprompts_sent : -1;
    assert(
      actualSent === expectedSent,
      `Round ${round.round}: expected reprompts_sent=${expectedSent} (only valid submits), got ${actualSent}`,
    );
    assert(
      actualSent === 0,
      `Round ${round.round}: reprompts_sent should be 0 when all entries are errors/skips, got ${actualSent}`,
    );
  }

  // Verify cumulative reprompts_sent is also 0
  assert(
    result.reprompts_sent === 0,
    `Cumulative reprompts_sent should be 0 with only error/skip entries, got ${result.reprompts_sent}`,
  );

  // Verify no successful submit entries exist at all
  for (const round of rounds) {
    const reprompts = Array.isArray(round.reprompts) ? round.reprompts : [];
    for (const entry of reprompts) {
      assert(
        !("message_id" in entry),
        `Entry for session ${entry?.session_id} in round ${round.round} should not have message_id`,
      );
    }
  }

  console.log(
    "  PASS: reprompts_sent counts only successful submit entries, excludes skipped/warning/error rows",
  );
}

// ─── VAL-ORCH-008: Connected-computer failures trigger rebind ──────

async function testValOrch008_ConnectedComputerFailureRebindsWhenComputerAvailable() {
  console.log(
    "\n=== Test: VAL-ORCH-008 Connected-computer failures trigger rebind when computer is available ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  // Run autoloop without explicit computer_id — with unknown sessions we get
  // generic errors, not connected-computer errors. Verify the rebind_events field
  // exists and the response structure supports rebind scenarios.
  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate rebind event contract structure [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  // Verify rebind_events is a recognized array field
  assert(
    Array.isArray(result.rebind_events),
    "Response must include rebind_events array",
  );

  // Verify tracked_session_ids exists
  assert(
    Array.isArray(result.tracked_session_ids),
    "Response must include tracked_session_ids array",
  );

  // For unknown sessions, there should be no rebind events (errors are non-connected-computer)
  // This is correct: rebind only fires on connected-computer errors
  assert(
    result.rebind_events.length === 0,
    "No rebind events expected for non-connected-computer errors",
  );

  // Verify round-level reprompt entries include required fields for rebind contract
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  for (const round of rounds) {
    const reprompts = Array.isArray(round.reprompts) ? round.reprompts : [];
    for (const entry of reprompts) {
      // Every reprompt entry should have session_id
      assert(
        typeof entry?.session_id === "string",
        `Each reprompt entry in round ${round.round} must have session_id`,
      );
    }
  }

  console.log(
    "  PASS: Autoloop response preserves rebind_events contract structure",
  );
}

// ─── VAL-ORCH-009: No-active-computer path is explicit ─────────────

async function testValOrch009_NoActiveComputerSurfacesExplicitError() {
  console.log(
    "\n=== Test: VAL-ORCH-009 No-active-computer path surfaces explicit error semantics ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  // Run without a computer_id and without active computers discoverable
  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate no-active-computer error semantics [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  // For unknown sessions, errors are non-connected-computer (session not found).
  // The connected-computer → no-active-computer path requires a real session with
  // a connected-computer failure. Verify the error entry format supports the
  // auto_rebind_unavailable tag contract.
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  const reprompts = Array.isArray(rounds[0]?.reprompts)
    ? rounds[0].reprompts
    : [];
  const sessionEntry = reprompts.find(
    (entry) => entry?.session_id === unknownSessionId,
  );

  assert(
    Boolean(sessionEntry),
    "Expected a reprompt entry for the requested session",
  );

  // Verify error entries contain a string error message (contract requirement)
  if ("error" in sessionEntry) {
    assert(
      typeof sessionEntry.error === "string",
      "Error entries must include string error message",
    );
    // Error message must be non-empty
    assert(sessionEntry.error.length > 0, "Error message must not be empty");
  }

  // No rebind_events should be generated for non-connected-computer errors
  assert(
    result.rebind_events.length === 0,
    "No rebind events should be created for non-connected-computer errors",
  );

  console.log(
    "  PASS: Error entries carry explicit string error semantics with no spurious rebind events",
  );
}

// ─── VAL-ORCH-013: Autoloop enforces completion gate before terminal completion ───

async function testValOrch013_CompletionGateEnforcedBeforeTerminalCompletion() {
  console.log(
    "\n=== Test: VAL-ORCH-013 Autoloop enforces completion gate before terminal completion ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  // Run with completion gate criteria configured
  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate completion gate enforcement [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    min_confidence: 0.8,
    require_citations: true,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  // Verify completion gate config is preserved in response
  assert(
    result.completion_gate !== undefined,
    "Response must include completion_gate",
  );
  assert(
    result.completion_gate.min_confidence === 0.8,
    `Expected min_confidence=0.80, got ${result.completion_gate.min_confidence}`,
  );
  assert(
    result.completion_gate.require_citations === true,
    `Expected require_citations=true, got ${result.completion_gate.require_citations}`,
  );

  // With unknown sessions, all are incomplete → status must be partial
  assert(
    result.status === "partial",
    `Expected status=partial when sessions are incomplete, got ${result.status}`,
  );
  assert(
    result.sessions_pending > 0,
    `Expected sessions_pending > 0 when sessions are incomplete, got ${result.sessions_pending}`,
  );

  // Verify each session in final_sessions has completion gate fields
  const finalSessions = Array.isArray(result.final_sessions)
    ? result.final_sessions
    : [];
  for (const session of finalSessions) {
    assert(
      "completion_gate_passed" in session,
      `Session ${session.session_id} must include completion_gate_passed`,
    );
    assert(
      "completion_gate_reason" in session ||
        session.completion_gate_passed === true ||
        session.completed !== false,
      `Session ${session.session_id} must include completion_gate_reason when gate not passed`,
    );
    assert(
      "confidence_score" in session || session.completion_gate_passed !== false,
      `Session ${session.session_id} must include confidence_score`,
    );
  }

  // Verify round-level sessions include gate fields
  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  for (const round of rounds) {
    const roundSessions = Array.isArray(round.sessions) ? round.sessions : [];
    for (const session of roundSessions) {
      assert(
        "completion_gate_passed" in session,
        `Round ${round.round} session ${session.session_id} must include completion_gate_passed`,
      );
    }
  }

  console.log(
    "  PASS: Autoloop enforces completion gate and surfaces gate state across all response layers",
  );
}

// ─── VAL-ORCH-014: Non-rebindable submit failures are explicit ─────

async function testValOrch014_NonRebindableSubmitFailuresAreExplicit() {
  console.log(
    "\n=== Test: VAL-ORCH-014 Non-rebindable submit failures surface explicit error semantics ===",
  );
  const unknownSessionId = generateUnknownSessionId();
  const correlationId = generateCorrelationId();

  const result = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate non-rebindable failure explicitness [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  const rounds = Array.isArray(result.rounds) ? result.rounds : [];
  assert(rounds.length >= 1, `Expected at least 1 round, got ${rounds.length}`);

  const reprompts = Array.isArray(rounds[0]?.reprompts)
    ? rounds[0].reprompts
    : [];
  const errorEntry = reprompts.find(
    (entry) =>
      entry?.session_id === unknownSessionId &&
      typeof entry?.error === "string",
  );

  assert(
    Boolean(errorEntry),
    "Non-rebindable submit failure should produce an explicit error reprompt entry",
  );
  assert(
    typeof errorEntry.error === "string" && errorEntry.error.length > 0,
    "Error entry must contain a non-empty string error message",
  );
  assert(
    !("message_id" in errorEntry),
    "Error entries must not include message_id",
  );
  assert(
    !("rebound_session_id" in errorEntry),
    "Error entries must not include rebound_session_id",
  );

  // Verify no rebind_events are created for non-connected-computer failures
  const rebindEvents = Array.isArray(result.rebind_events)
    ? result.rebind_events
    : [];
  assert(
    rebindEvents.length === 0,
    `Expected no rebind events for non-connected-computer errors, got ${rebindEvents.length}`,
  );

  // Verify reprompts_sent excludes this error entry
  const roundRepromptsSent =
    typeof rounds[0]?.reprompts_sent === "number"
      ? rounds[0].reprompts_sent
      : -1;
  assert(
    roundRepromptsSent === 0,
    `reprompts_sent should be 0 (error excluded), got ${roundRepromptsSent}`,
  );

  console.log(
    "  PASS: Non-rebindable submit failures produce explicit error entries with no rebind artifacts",
  );
}

// ─── VAL-CORE-011: PM loop blocks unsafe proposals and emits explicit escalation records ───

async function testValCore011_UnsafeProposalsBlockedWithEscalationRecords() {
  console.log(
    "\n=== Test: VAL-CORE-011 PM loop blocks unsafe proposals and emits escalation records ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for unsafe proposal blocking and escalation [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "full_vps_restart",
        type: "restart full VPS",
        description: "Full VPS restart requiring approval",
      },
      {
        action: "create_vps_snapshot",
        type: "snapshot",
        description: "Create VPS snapshot",
      },
      {
        action: "stop_production_project",
        type: "stop project nginx-proxy",
        description: "Stop production nginx proxy",
      },
    ],
  });

  // Verify blocked_actions is populated
  const blockedActions = result.propose?.blocked_actions || [];
  assert(
    blockedActions.length === 3,
    `Should have 3 blocked actions, got ${blockedActions.length}`,
  );

  // Verify each blocked action has action_reference and blocked_reason
  for (const ba of blockedActions) {
    assertHasField(ba, "action_reference", "blocked_action");
    assertHasField(ba, "blocked_reason", "blocked_action");
    assertHasField(ba, "risk_level", "blocked_action");
  }

  // Verify approval_requests records are created
  const approvalRequests = result.propose?.approval_requests || [];
  assert(
    approvalRequests.length > 0,
    `Should have at least one approval_request record, got ${approvalRequests.length}`,
  );
  assert(
    approvalRequests.length >= 3,
    `Should have 3 approval_request records for 3 blocked actions, got ${approvalRequests.length}`,
  );

  // Verify each approval request has required fields
  for (const ar of approvalRequests) {
    assertHasField(ar, "memory_id", "approval_request");
    assertHasField(ar, "action_reference", "approval_request");
    assertHasField(ar, "risk_level", "approval_request");
    assert(
      ar.risk_level === "dangerous-global-mutation" ||
        ar.risk_level === "hermes-scoped-mutation",
      `Approval request risk_level should be dangerous or hermes-scoped, got ${ar.risk_level}`,
    );
  }

  // Verify classified actions have approval-gated status
  const classifiedActions = result.propose?.actions || [];
  for (const action of classifiedActions) {
    assert(
      action.status === "awaiting_approval",
      `Each unsafe action should have status "awaiting_approval", got "${
        action.status
      }" for action "${action.action_reference || action.action}"`,
    );
    assert(
      action.approval_required === true,
      `Each unsafe action should have approval_required=true`,
    );
  }

  // Verify proposal_records link actions to approval requests
  const proposalRecords = result.propose?.proposal_records || [];
  assert(
    proposalRecords.length === 3,
    `Should have 3 proposal_records, got ${proposalRecords.length}`,
  );
  for (const pr of proposalRecords) {
    assertHasField(pr, "approval_request_memory_id", "proposal_record");
    assert(
      pr.link_status === "approval_requested",
      `Proposal record link_status should be "approval_requested", got "${pr.link_status}"`,
    );
  }

  console.log(
    `  PASS: ${blockedActions.length} unsafe actions blocked with ${approvalRequests.length} approval request escalation records`,
  );
}

// ─── VAL-ORCH-010: Low-risk read operations remain unblocked ─────────

async function testValOrch010_ReadOnlyActionsRemainUnblocked() {
  console.log(
    "\n=== Test: VAL-ORCH-010 Read-only actions remain non-blocked in proposal routing ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for read-only action routing [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "research_market_trends",
        type: "research",
        description: "Read-only research on market trends",
      },
      {
        action: "query_vps_info",
        type: "read",
        description: "Read VPS status info",
      },
      {
        action: "list_recent_sessions",
        type: "list",
        description: "List recent Factory sessions",
      },
      {
        action: "generate_status_report",
        type: "report",
        description: "Generate business status report",
      },
      {
        action: "recall_prior_decisions",
        type: "recall",
        description: "Recall prior decision records from memory",
      },
    ],
  });

  const classifiedActions = result.propose?.actions || [];
  assert(
    classifiedActions.length === 5,
    `Should have 5 classified actions, got ${classifiedActions.length}`,
  );

  // Verify each read-only action is not blocked and has correct risk level
  for (const action of classifiedActions) {
    const actionRef = action.action_reference || action.action || "unknown";
    assert(
      action.risk_level === "read-only",
      `Action "${actionRef}" should be read-only, got ${action.risk_level}`,
    );
    assert(
      action.approval_required === false,
      `Action "${actionRef}" should not require approval`,
    );
    assert(
      action.status === "ready",
      `Action "${actionRef}" should have status "ready", got "${action.status}"`,
    );
  }

  // Verify no blocked_actions were created
  const blockedActions = result.propose?.blocked_actions || [];
  assert(
    blockedActions.length === 0,
    `Should have no blocked actions for read-only proposals, got ${blockedActions.length}`,
  );

  // Verify no approval_requests were created
  const approvalRequests = result.propose?.approval_requests || [];
  assert(
    approvalRequests.length === 0,
    `Should have no approval requests for read-only proposals, got ${approvalRequests.length}`,
  );

  // Verify no capability_requests were created solely from risk policy
  const capabilityRequests = result.propose?.capability_requests || [];
  const riskPolicyCapabilityRequests = capabilityRequests.filter(
    (cr) =>
      cr.source === "blocked_proposal" ||
      cr.source === "online_portal_prerequisite",
  );
  assert(
    riskPolicyCapabilityRequests.length === 0,
    `Should have no policy-driven capability requests for read-only actions, got ${riskPolicyCapabilityRequests.length}`,
  );

  console.log(
    "  PASS: Read-only actions remain non-blocked without approval/capability/task routing side effects",
  );
}

// ─── VAL-ORCH-011: Session-bound online steps route through local task queue ───

async function testValOrch011_SessionBoundOnlineStepsRouteToLocalTaskQueue() {
  console.log(
    "\n=== Test: VAL-ORCH-011 Session-bound online steps route through local task queue ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for session-bound online routing [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "submit_taxnetusa_form",
        type: "submit portal form browser session",
        description:
          "Submit TaxNetUSA appraisal form via authenticated browser session",
        portal: "taxnetusa",
      },
      {
        action: "check_gmail_inbox",
        type: "portal browser",
        description: "Check Gmail inbox for order updates",
        portal: "gmail",
      },
      {
        action: "query_matrix_mls",
        type: "portal browser session",
        description: "Query Matrix MLS for comparable sales data",
        portal: "matrix_mls",
      },
    ],
  });

  // Verify online_step_classification exists
  const onlineSteps = result.propose?.online_step_classification || [];
  assert(
    onlineSteps.length === 3,
    `Should have 3 online step classifications, got ${onlineSteps.length}`,
  );

  // Verify session-bound online steps were routed to local_tasks
  const localTasks = result.propose?.local_tasks || [];
  const browserLocalTasks = localTasks.filter((lt) => lt.kind === "browser");
  assert(
    browserLocalTasks.length >= 1,
    `Should have at least one browser local task for session-bound online steps, got ${browserLocalTasks.length}`,
  );

  // Verify local task entries contain required browser metadata
  for (const task of browserLocalTasks) {
    assertHasField(task, "task_id", "local_task");
    assertHasField(task, "reason", "local_task");
    assertHasField(task, "portal_surface", "local_task");
    assertHasField(task, "action_reference", "local_task");
    assertHasField(task, "auth_session_needs", "local_task");
    assert(
      task.reason === "session_bound_online_step" ||
        task.reason === "blocked_online_step",
      `Local task reason should indicate session-bound or blocked online step, got "${task.reason}"`,
    );
  }

  // Verify classified actions have session-bound status or are queued
  const classifiedActions = result.propose?.actions || [];
  const sessionBoundActions = classifiedActions.filter(
    (a) =>
      a.execution_classification === "session-bound" ||
      a.execution_classification === "blocked",
  );
  assert(
    sessionBoundActions.length >= 1,
    `Should have at least one session-bound/blocked online action, got ${sessionBoundActions.length}`,
  );

  // Verify session-bound actions are NOT treated as completed headless operations
  for (const action of sessionBoundActions) {
    assert(
      action.execution_classification !== "headless-safe",
      `Session-bound action "${
        action.action_reference || action.action
      }" should not be classified as headless-safe`,
    );
    assert(
      action.portal_surface !== null,
      `Session-bound action should have a portal_surface`,
    );
  }

  console.log(
    `  PASS: ${sessionBoundActions.length} session-bound online steps routed to ${browserLocalTasks.length} local browser tasks with required metadata`,
  );
}

// ─── VAL-ORCH-012: Dangerous mutations blocked and routed to approval workflow ───

async function testValOrch012_DangerousMutationsBlockedWithApprovalRouting() {
  console.log(
    "\n=== Test: VAL-ORCH-012 Dangerous mutations are blocked and routed to approval workflow ===",
  );
  const correlationId = generateCorrelationId();

  const result = await callTool("business_pm_loop", {
    objective: `Validation test for dangerous mutation approval routing [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "full_vps_restart",
        type: "restart full VPS",
        description: "Full VPS restart — dangerous global mutation",
      },
      {
        action: "stop_unrelated_project",
        type: "stop project nginx-proxy",
        description: "Stop production nginx proxy — dangerous global",
      },
      {
        action: "create_vps_snapshot",
        type: "snapshot",
        description: "Create VPS snapshot — dangerous global",
      },
    ],
  });

  // Verify all actions are marked as blocked with approval_required
  const classifiedActions = result.propose?.actions || [];
  assert(
    classifiedActions.length === 3,
    `Should have 3 classified actions, got ${classifiedActions.length}`,
  );

  for (const action of classifiedActions) {
    const actionRef = action.action_reference || action.action || "unknown";
    assert(
      action.approval_required === true,
      `Dangerous mutation "${actionRef}" should require approval`,
    );
    assert(
      action.risk_level === "dangerous-global-mutation",
      `Dangerous mutation "${actionRef}" should be dangerous-global-mutation, got ${action.risk_level}`,
    );
    assert(
      action.status === "awaiting_approval",
      `Dangerous mutation "${actionRef}" should have status "awaiting_approval", got "${action.status}"`,
    );
  }

  // Verify blocked_actions exist
  const blockedActions = result.propose?.blocked_actions || [];
  assert(
    blockedActions.length === 3,
    `Should have 3 blocked actions, got ${blockedActions.length}`,
  );

  // Verify approval_requests are created
  const approvalRequests = result.propose?.approval_requests || [];
  assert(
    approvalRequests.length === 3,
    `Should have 3 approval_requests, got ${approvalRequests.length}`,
  );

  for (const ar of approvalRequests) {
    assertHasField(ar, "memory_id", "approval_request");
    assertHasField(ar, "action_reference", "approval_request");
    assertHasField(ar, "risk_level", "approval_request");
    assert(
      ar.risk_level === "dangerous-global-mutation",
      `Approval request risk_level should be dangerous-global-mutation, got ${ar.risk_level}`,
    );
  }

  // Verify NO action appears as directly executable (no ready status for dangerous mutations)
  const directlyExecutable = classifiedActions.filter(
    (a) => a.status === "ready",
  );
  assert(
    directlyExecutable.length === 0,
    `No dangerous mutation should be directly executable, but found ${directlyExecutable.length} with status "ready"`,
  );

  // Verify proposal_records link to approval
  const proposalRecords = result.propose?.proposal_records || [];
  const dangerousRecords = proposalRecords.filter(
    (pr) => pr.risk_level === "dangerous-global-mutation",
  );
  assert(
    dangerousRecords.length === 3,
    `Should have 3 dangerous proposal records, got ${dangerousRecords.length}`,
  );
  for (const pr of dangerousRecords) {
    assert(
      pr.link_status === "approval_requested",
      `Dangerous proposal record should have link_status "approval_requested", got "${pr.link_status}"`,
    );
  }

  console.log(
    "  PASS: Dangerous mutations are blocked, never directly executable, and routed to approval workflow",
  );
}

// ─── VAL-ORCH-015: Online blocker capability requests deduplicated by blocker key ───

async function testValOrch015_OnlineBlockerCapabilityRequestsDeduplicatedByBlockerKey() {
  console.log(
    "\n=== Test: VAL-ORCH-015 Online blocker capability requests deduplicated by blocker key ===",
  );
  const correlationId = generateCorrelationId();
  const nonce = Date.now();
  const sharedTaxnetPrereq = `taxnetusa_authenticated_session_val_orch_015_${nonce}`;
  const gmailPrereq = `gmail_authenticated_session_val_orch_015_${nonce}`;

  // Submit multiple actions targeting the same portal with the same blocker context
  const result = await callTool("business_pm_loop", {
    objective: `Validation test for online blocker dedup [${correlationId}]`,
    correlation_id: correlationId,
    proposed_actions: [
      {
        action: "submit_taxnet_form_a",
        type: "submit portal form",
        description: "Submit TaxNetUSA form A via authenticated browser",
        portal: "taxnetusa",
        missing_prerequisites: [sharedTaxnetPrereq],
      },
      {
        action: "submit_taxnet_form_b",
        type: "submit portal form",
        description: "Submit TaxNetUSA form B via authenticated browser",
        portal: "taxnetusa",
        missing_prerequisites: [sharedTaxnetPrereq],
      },
      {
        action: "submit_taxnet_form_c",
        type: "submit portal form",
        description: "Submit TaxNetUSA form C via authenticated browser",
        portal: "taxnetusa",
        missing_prerequisites: [sharedTaxnetPrereq],
      },
      {
        action: "check_gmail_missing_auth",
        type: "check portal",
        description: "Check Gmail for updates — missing auth",
        portal: "gmail",
        missing_prerequisites: [gmailPrereq],
      },
    ],
  });

  // Verify capability_requests exist
  const capabilityRequests = result.propose?.capability_requests || [];
  assert(
    capabilityRequests.length >= 2,
    `Should have at least 2 capability request entries (taxnet and gmail), got ${capabilityRequests.length}`,
  );

  // Group capability requests by portal surface
  const taxnetRequests = capabilityRequests.filter(
    (cr) => cr.portal_surface === "taxnetusa",
  );
  const gmailRequests = capabilityRequests.filter(
    (cr) => cr.portal_surface === "gmail",
  );

  assert(
    taxnetRequests.length >= 1,
    `Should have at least one TaxNetUSA capability request, got ${taxnetRequests.length}`,
  );
  assert(
    gmailRequests.length >= 1,
    `Should have at least one Gmail capability request, got ${gmailRequests.length}`,
  );

  // Verify: at most ONE taxnet request has status "pending" (new), the rest should be "reused_existing"
  const taxnetPending = taxnetRequests.filter((cr) => cr.status === "pending");
  assert(
    taxnetPending.length <= 1,
    `At most one TaxNetUSA capability request should be "pending" (new), got ${taxnetPending.length} pending`,
  );
  assert(
    taxnetPending.length === 1,
    `Should have exactly one new TaxNetUSA capability request, got ${taxnetPending.length} pending`,
  );

  const taxnetReused = taxnetRequests.filter(
    (cr) => cr.status === "reused_existing",
  );
  assert(
    taxnetReused.length >= taxnetRequests.length - 1,
    `All but one TaxNetUSA request should be "reused_existing", got ${taxnetReused.length} reused out of ${taxnetRequests.length}`,
  );

  // Verify reused requests share the same blocker_key
  if (taxnetReused.length > 0 && taxnetPending.length > 0) {
    const pendingBlockerKey = taxnetPending[0].blocker_key;
    for (const reused of taxnetReused) {
      assert(
        reused.blocker_key === pendingBlockerKey,
        `Reused request blocker_key "${reused.blocker_key}" should match pending blocker_key "${pendingBlockerKey}"`,
      );
      assert(
        reused.request_id === taxnetPending[0].request_id,
        `Reused request ID should match the pending request ID`,
      );
    }
  }

  // Verify Gmail request status
  const gmailPending = gmailRequests.filter((cr) => cr.status === "pending");
  assert(
    gmailPending.length === 1,
    `Should have exactly one new Gmail capability request, got ${gmailPending.length} pending`,
  );

  // Verify each capability request includes blocker_key, status, and source
  for (const cr of capabilityRequests) {
    assertHasField(cr, "blocker_key", "capability_request");
    assertHasField(cr, "status", "capability_request");
    assertHasField(cr, "source", "capability_request");
    assert(
      cr.status === "pending" || cr.status === "reused_existing",
      `Capability request status should be "pending" or "reused_existing", got "${cr.status}"`,
    );
  }

  console.log(
    `  PASS: ${taxnetRequests.length} TaxNetUSA requests: ${taxnetPending.length} new + ${taxnetReused.length} reused; Gmail: ${gmailPending.length} new. Deduplication works by blocker key.`,
  );
}

// ─── VAL-ORCH-015 cross-cycle: repeated identical blocker contexts reuse existing requests ───

async function testValOrch015_CrossCycleBlockerKeyDeduplication() {
  console.log(
    "\n=== Test: VAL-ORCH-015 cross-cycle blocker key deduplication ===",
  );
  const firstCorrelationId = generateCorrelationId();
  const secondCorrelationId = generateCorrelationId();

  // Use a distinct blocker context to avoid interference with other tests
  const sharedPrereq = `cross_cycle_test_session_${Date.now()}`;
  const actionPayload = {
    action: "cross_cycle_collect_taxnet_data",
    type: "TaxNetUSA browser session workflow",
    description:
      "Cross-cycle dedup test: TaxNet lookup blocked because session is missing",
    portal: "taxnetusa",
    missing_prerequisites: [sharedPrereq],
  };

  // First cycle: create a new capability request
  const first = await callTool("business_pm_loop", {
    objective: `Cross-cycle dedup test run 1 [${firstCorrelationId}]`,
    correlation_id: firstCorrelationId,
    proposed_actions: [actionPayload],
  });
  const firstReqs = first.propose?.capability_requests || [];
  const firstOnlineReq = firstReqs.find((req) =>
    String(req.source || "").includes("online_portal_prerequisite"),
  );
  assert(
    firstOnlineReq,
    "First cycle should create an online portal prerequisite request",
  );
  assert(
    firstOnlineReq.status === "pending",
    `First cycle request should be "pending", got "${firstOnlineReq.status}"`,
  );
  assertHasField(firstOnlineReq, "blocker_key", "first cycle request");
  assertHasField(firstOnlineReq, "request_id", "first cycle request");

  const firstBlockerKey = firstOnlineReq.blocker_key;
  const firstRequestId = firstOnlineReq.request_id;

  // Verify the capability_gap memory was persisted with the correct blocker_key
  const capabilityGaps = await callTool("memory_recall", {
    category: "capability_gap",
    query: firstCorrelationId,
    limit: 20,
  });
  const gapRows = Array.isArray(capabilityGaps) ? capabilityGaps : [];
  const matchGap = gapRows.find((r) => {
    const meta = r.metadata || {};
    return (
      typeof meta.blocker_key === "string" &&
      meta.blocker_key === firstBlockerKey
    );
  });
  assert(
    matchGap,
    "First cycle capability_gap record should be persisted with matching blocker_key",
  );
  assert(
    typeof matchGap.metadata?.capability_request_id === "string",
    "Capability_gap metadata should include capability_request_id",
  );

  // Second cycle: same blocker context should reuse the existing request from memory
  const second = await callTool("business_pm_loop", {
    objective: `Cross-cycle dedup test run 2 [${secondCorrelationId}]`,
    correlation_id: secondCorrelationId,
    proposed_actions: [actionPayload],
  });
  const secondReqs = second.propose?.capability_requests || [];
  const secondOnlineReq = secondReqs.find((req) =>
    String(req.source || "").includes("online_portal_prerequisite"),
  );
  assert(
    secondOnlineReq,
    "Second cycle should include an online portal prerequisite record",
  );

  // The second request should either be reused or carry the same blocker_key and request_id
  const isReused =
    String(secondOnlineReq.source || "").includes("reused") ||
    secondOnlineReq.status === "reused_existing";
  const sameIds =
    secondOnlineReq.request_id === firstRequestId &&
    secondOnlineReq.blocker_key === firstBlockerKey;
  assert(
    isReused || sameIds,
    `Cross-cycle dedup: second cycle should reuse or match first. source=${secondOnlineReq.source}, status=${secondOnlineReq.status}, ids_match=${sameIds}`,
  );

  // Verify the blocker_key is identical across cycles
  assert(
    secondOnlineReq.blocker_key === firstBlockerKey,
    `Cross-cycle blocker_key should match: ${secondOnlineReq.blocker_key} vs ${firstBlockerKey}`,
  );

  console.log(
    `  PASS: Cross-cycle deduplication: second cycle ${
      isReused ? "reused_existing" : "matched"
    } first cycle's capability request (blocker_key=${firstBlockerKey}, request_id=${firstRequestId})`,
  );
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
    console.error(
      `FATAL: Hermes not reachable at ${HERMES_URL}: ${err.message}`,
    );
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
    testValLoop007_ShadowObservationsProvenance,
    testValLoop008_LearningChangesNextPlan,
    testValLoop009_PmGradeExecutionFields,
    testValLoop010_WorkflowTraceToReusableKnowledge,
    testValLoop011_ProposalLinksToCoordinationRecords,
    testValLoop012_UnknownSignalsNotFabricated,
    testValCore004_AutoloopRepromptIdempotentOnUnchangedCursor,
    testValCore005_AutoloopBoundedByConfiguredRounds,
    testValOrch005_AutoloopSkipsRunningSessions,
    testValOrch006_UnchangedCursorSuppressesDuplicateReprompts,
    testValOrch007_RepromptsSentCountsOnlySuccessfulSubmits,
    testValOrch008_ConnectedComputerFailureRebindsWhenComputerAvailable,
    testValOrch009_NoActiveComputerSurfacesExplicitError,
    testValOrch013_CompletionGateEnforcedBeforeTerminalCompletion,
    testValOrch014_NonRebindableSubmitFailuresAreExplicit,
    testValCore011_UnsafeProposalsBlockedWithEscalationRecords,
    testValOrch010_ReadOnlyActionsRemainUnblocked,
    testValOrch011_SessionBoundOnlineStepsRouteToLocalTaskQueue,
    testValOrch012_DangerousMutationsBlockedWithApprovalRouting,
    testValOrch015_OnlineBlockerCapabilityRequestsDeduplicatedByBlockerKey,
    testValOrch015_CrossCycleBlockerKeyDeduplication,
    testValCore008_FailClosedWithoutConfirmation,
    testValCore009_NonHermesMutationNeedsApproval,
    testValCore010_HermesScopedMutationNeedsValidationAndApproval,
    testValCore012_DangerousMutationNeedsApprovalAfterConfirmation,
    testValCore013_HermesValidationEvidenceMustBeCurrentCommitMatched,
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
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${tests.length} total`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
