#!/usr/bin/env node

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
const VALIDATION_PREFIX = "VALIDATION-ONLINE-EVIDENCE";

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

async function testValOnline008_SuccessClaimsNeedEvidence() {
  console.log("\n=== VAL-ONLINE-008 success claims require evidence ===");
  const cid = correlationId("evidence");
  const result = await callTool("business_pm_loop", {
    objective: `Validate online success evidence requirements [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "perplexity_research_step_success",
        type: "research",
        status: "succeeded",
        source: "perplexity_api",
        tool: "research",
        task_id: `${cid}-task-research`,
        result_excerpt: "Research returned current appraisal workflow automation insights.",
        evidence_id: `${cid}-evidence-research`,
        observed_fields: { citation_count: 3, topic: "appraisal automation" },
      },
      {
        action: "portal_read_without_evidence",
        type: "taxnetusa portal read",
        status: "succeeded",
      },
    ],
  });

  const actions = result.propose?.actions || [];
  const successful = actions.find((action) => action.action === "perplexity_research_step_success");
  assert(successful, "Expected success action in propose.actions");
  assert(successful.evidence?.success_claim === true, "Success action should be marked as success claim");
  assert(successful.evidence?.evidence_complete === true, "Success action should include complete evidence");
  assert(typeof successful.evidence?.source === "string" && successful.evidence.source.length > 0, "Success evidence should include source");
  assert(
    (typeof successful.evidence?.tool === "string" && successful.evidence.tool.length > 0)
    || (typeof successful.evidence?.task_id === "string" && successful.evidence.task_id.length > 0),
    "Success evidence should include tool or task_id",
  );

  const missingEvidence = actions.find((action) => action.action === "portal_read_without_evidence");
  assert(missingEvidence, "Expected missing-evidence action in propose.actions");
  assert(missingEvidence.status === "blocked_missing_evidence", "Missing evidence success claim should be blocked");

  const blocked = result.propose?.blocked_actions || [];
  assert(blocked.some((entry) => entry.blocker_type === "online_missing_evidence"), "Blocked actions should include typed missing-evidence blocker");
  console.log("  PASS: online success claims are evidence-backed or blocked as missing evidence");
}

async function testValOnline009_TypedProviderFailures() {
  console.log("\n=== VAL-ONLINE-009 provider/auth failures become typed blockers ===");
  const cid = correlationId("failures");
  const result = await callTool("business_pm_loop", {
    objective: `Validate typed online failure handling [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "research_market_signal",
        type: "research",
        status: "failed",
        provider: "perplexity",
        error: "429 rate limit exceeded",
      },
      {
        action: "open_matrix_record",
        type: "matrix mls browser session",
        status: "failed",
        error: "401 unauthorized: login required",
      },
      {
        action: "lookup_taxnet_with_mfa",
        type: "taxnetusa portal browser",
        status: "failed",
        blocker: "MFA challenge and CAPTCHA required",
      },
    ],
  });

  const blockers = result.propose?.online_failure_blockers || [];
  const failureTypes = new Set(blockers.map((entry) => entry.failure_type));
  assert(failureTypes.has("rate_limit"), "Expected typed rate_limit blocker");
  assert(failureTypes.has("auth_failure"), "Expected typed auth_failure blocker");
  assert(failureTypes.has("mfa_captcha"), "Expected typed mfa_captcha blocker");

  const capabilities = result.propose?.capability_requests || [];
  assert(
    capabilities.some((entry) => typeof entry.capability === "string" && entry.capability.includes("authenticated_session")),
    "Auth/session failures should produce capability requests when applicable",
  );
  console.log("  PASS: provider/auth/rate-limit/MFA failures are surfaced as typed blockers");
}

async function testValOnline010_MutatingActionsApprovalGated() {
  console.log("\n=== VAL-ONLINE-010 mutating online actions are approval-gated ===");
  const cid = correlationId("approval");
  const result = await callTool("business_pm_loop", {
    objective: `Validate approval gating for mutating online actions [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "send_client_email_update",
        type: "send email to client with appraisal update",
        description: "Business-impacting outbound communication",
      },
      {
        action: "submit_taxnet_portal_update",
        type: "submit portal form browser session",
        description: "Mutating portal submission",
      },
      {
        action: "download_official_paid_record",
        type: "paid search download official record",
        description: "Paid legal-impacting online data action",
      },
    ],
  });

  const actions = result.propose?.actions || [];
  assert(actions.length >= 3, "Expected three classified mutating actions");
  for (const action of actions) {
    assert(action.approval_required === true, `Action ${action.action} should require approval`);
    assert(action.status === "awaiting_approval", `Action ${action.action} should be awaiting_approval`);
    assert(action.risk_level === "dangerous-global-mutation", `Action ${action.action} should be classified as dangerous-global-mutation`);
  }
  const approvals = result.propose?.approval_requests || [];
  assert(approvals.length >= 3, "Blocked mutating actions should create approval request records");
  console.log("  PASS: business-impacting online mutations are proposal-only and approval-gated");
}

async function testValOnline011AndCross010_LocalTaskOutcomesFeedPlanning() {
  console.log("\n=== VAL-ONLINE-011 / VAL-CROSS-010 local/browser outcomes return to planning ===");
  const seedCid = correlationId("localtask-seed");
  const followCid = correlationId("localtask-follow");

  const seeded = await callTool("business_pm_loop", {
    objective: `Ingest simulated local/browser completion outcome [${seedCid}]`,
    correlation_id: seedCid,
    simulated_local_task_outcomes: [
      {
        task_id: `${seedCid}-browser-task-1`,
        kind: "browser",
        status: "succeeded",
        result: {
          portal_surface: "taxnetusa",
          observed_fields: { parcel_lookup: "completed", comparable_count: 5 },
        },
      },
    ],
  });

  const ingestedNow = seeded.recall?.local_task_outcomes || [];
  assert(ingestedNow.length > 0, "Cycle should ingest simulated local task outcomes");
  assert((seeded.learn?.local_task_outcomes_ingested || []).length > 0, "Learn section should expose ingested local task outcomes");

  const follow = await callTool("business_pm_loop", {
    objective: `Re-plan using completed local/browser outcome [${followCid}]`,
    correlation_id: followCid,
    recall_query: seedCid,
  });

  const priorOnlineObs = follow.plan?.prior_online_observations || [];
  assert(
    priorOnlineObs.some((entry) => String(entry.source || "").includes("local_task_completion")),
    "Follow-up plan should reference prior local_task_completion observations",
  );
  const integrationStep = (follow.plan?.actions || []).find((entry) => entry.step === "Integrate recalled decisions and workflows into current plan");
  assert(integrationStep, "Follow-up plan should include integration step");
  assert((integrationStep.evidence_ids || []).length > 0, "Integration step should include outcome-linked evidence IDs");
  console.log("  PASS: local/browser task completion is ingested and fed into subsequent planning");
}

async function testValOnline012AndCross004_PriorOnlineSignalsRefinePlan() {
  console.log("\n=== VAL-ONLINE-012 / VAL-CROSS-004 prior online observations and gaps refine next plan ===");
  const seedCid = correlationId("gap-seed");
  const followCid = correlationId("gap-follow");

  const first = await callTool("business_pm_loop", {
    objective: `Seed online blocker and capability gap [${seedCid}]`,
    correlation_id: seedCid,
    proposed_actions: [
      {
        action: "taxnet_portal_lookup_blocked",
        type: "taxnetusa portal browser login",
        description: "Blocked because session is unavailable",
        missing_prerequisites: ["taxnetusa_authenticated_session"],
      },
    ],
  });
  assert((first.propose?.capability_requests || []).length > 0, "Seed cycle should create capability request(s)");

  const second = await callTool("business_pm_loop", {
    objective: `Build next cycle plan from prior online observations [${followCid}]`,
    correlation_id: followCid,
    recall_query: seedCid,
  });

  const priorGaps = second.plan?.prior_online_capability_gaps || [];
  assert(priorGaps.length > 0, "Follow-up plan should include prior online capability gaps");
  const gapInputs = second.plan?.capability_gap_inputs || [];
  assert(gapInputs.length > 0, "Follow-up plan should carry capability gaps as explicit inputs");

  const blockerStep = (second.plan?.actions || []).find((entry) => entry.step === "Resolve blocked capabilities and pending approvals");
  assert(blockerStep, "Plan should contain blocker-resolution step");
  assert((blockerStep.evidence_ids || []).length > 0, "Blocker step should include gap-linked evidence IDs");

  const recommendations = second.plan?.online_step_recommendations || [];
  assert(recommendations.length > 0, "Follow-up plan should provide refined online step recommendations");
  assert(
    (second.plan?.learning_influenced_changes || []).some((entry) => String(entry).toLowerCase().includes("prior online")),
    "Plan should report that prior online observations influenced planning",
  );
  console.log("  PASS: prior online observations and capability gaps refine the next plan");
}

async function main() {
  console.log("Hermes Online Evidence + Feedback Tests");
  console.log("=======================================");

  const health = await fetch(`${HERMES_URL}/health`);
  assert(health.ok, `Hermes health must be OK (got ${health.status})`);

  const tests = [
    testValOnline008_SuccessClaimsNeedEvidence,
    testValOnline009_TypedProviderFailures,
    testValOnline010_MutatingActionsApprovalGated,
    testValOnline011AndCross010_LocalTaskOutcomesFeedPlanning,
    testValOnline012AndCross004_PriorOnlineSignalsRefinePlan,
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

  console.log("\n=======================================");
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Fatal test error:", error);
  process.exit(1);
});
