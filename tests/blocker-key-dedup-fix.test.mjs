#!/usr/bin/env node
/**
 * Targeted tests for blocker_key LIKE escape fix and cross-cycle deduplication.
 * Run: node tests/blocker-key-dedup-fix.test.mjs
 */

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
const VALIDATION_PREFIX = "VALIDATION-BLOCKERKEY-FIX";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function correlationId(suffix = "case") {
  return `${VALIDATION_PREFIX}-${suffix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
  if (envelope.error)
    throw new Error(`MCP error: ${JSON.stringify(envelope.error)}`);
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

// ─── Test 1: Cross-cycle deduplication via persisted blocker_key ───

async function testCrossCycleBlockerKeyDedup() {
  console.log(
    "\n=== Test 1: Cross-cycle blocker_key dedup (persistence lookup fix) ===",
  );
  const firstCid = correlationId("cycle1");
  const secondCid = correlationId("cycle2");

  // Use a unique prerequisite to avoid collisions with other test data
  const uniquePrereq = `dedup_fix_test_session_${Date.now()}`;
  const actionPayload = {
    action: "dedup_fix_taxnet_lookup",
    type: "TaxNetUSA browser session workflow",
    description: "Blocked TaxNetUSA lookup in dedup fix test",
    portal: "taxnetusa",
    missing_prerequisites: [uniquePrereq],
  };

  // Cycle 1: Create a new capability request
  const first = await callTool("business_pm_loop", {
    objective: `Dedup fix test cycle 1 [${firstCid}]`,
    correlation_id: firstCid,
    proposed_actions: [actionPayload],
  });
  const firstReqs = first.propose?.capability_requests || [];
  const firstReq = firstReqs.find((r) =>
    String(r.source || "").includes("online_portal_prerequisite"),
  );

  assert(
    firstReq,
    "Cycle 1: should create an online portal prerequisite request",
  );
  assert(
    firstReq.status === "pending",
    `Cycle 1: request should be "pending", got "${firstReq.status}"`,
  );
  assert(
    typeof firstReq.blocker_key === "string" && firstReq.blocker_key.length > 0,
    "Cycle 1: request should have non-empty blocker_key",
  );
  assert(
    typeof firstReq.request_id === "string" && firstReq.request_id.length > 0,
    "Cycle 1: request should have non-empty request_id",
  );

  const firstBlockerKey = firstReq.blocker_key;
  const firstRequestId = firstReq.request_id;
  console.log(`  Cycle 1 blocker_key: ${firstBlockerKey}`);
  console.log(`  Cycle 1 request_id:  ${firstRequestId}`);

  // Verify the capability_gap memory was persisted
  const gapRows = await callTool("memory_recall", {
    category: "capability_gap",
    query: firstCid,
    limit: 20,
  });
  const gaps = Array.isArray(gapRows) ? gapRows : [];
  const matchGap = gaps.find((r) => {
    const meta = r.metadata || {};
    return (
      typeof meta.blocker_key === "string" &&
      meta.blocker_key === firstBlockerKey
    );
  });
  assert(
    matchGap,
    "Cycle 1 capability_gap record should be persisted with matching blocker_key",
  );
  console.log(
    `  Cycle 1 persisted gap memory_id: ${matchGap.memory_id || matchGap.id}`,
  );

  // Cycle 2: Same blocker context should reuse from persisted memory
  const second = await callTool("business_pm_loop", {
    objective: `Dedup fix test cycle 2 [${secondCid}]`,
    correlation_id: secondCid,
    proposed_actions: [actionPayload],
  });
  const secondReqs = second.propose?.capability_requests || [];
  const secondReq = secondReqs.find((r) =>
    String(r.source || "").includes("online_portal_prerequisite"),
  );

  assert(
    secondReq,
    "Cycle 2: should include an online portal prerequisite record",
  );

  const isReused =
    String(secondReq.source || "").includes("reused") ||
    secondReq.status === "reused_existing";
  const sameBlockerKey = secondReq.blocker_key === firstBlockerKey;
  const sameRequestId = secondReq.request_id === firstRequestId;

  console.log(`  Cycle 2 source:       ${secondReq.source}`);
  console.log(`  Cycle 2 status:       ${secondReq.status}`);
  console.log(`  Cycle 2 blocker_key:  ${secondReq.blocker_key}`);
  console.log(`  Cycle 2 request_id:   ${secondReq.request_id}`);

  assert(
    sameBlockerKey,
    `Cross-cycle blocker_key should match: ${secondReq.blocker_key} vs ${firstBlockerKey}`,
  );
  assert(
    isReused || sameRequestId,
    `Cross-cycle: second should reuse or share request_id. reused=${isReused}, same_id=${sameRequestId}`,
  );

  console.log(
    `  PASS: Cross-cycle deduplication: second cycle ${
      isReused ? "reused_existing" : "matched"
    } first's request`,
  );
}

// ─── Test 2: Within-cycle dedup still works ───

async function testWithinCycleBlockerKeyDedup() {
  console.log("\n=== Test 2: Within-cycle blocker_key dedup ===");
  const cid = correlationId("within");

  const result = await callTool("business_pm_loop", {
    objective: `Within-cycle dedup test [${cid}]`,
    correlation_id: cid,
    proposed_actions: [
      {
        action: "within_dedup_taxnet_a",
        type: "TaxNetUSA browser session workflow",
        description: "Blocked TaxNet form A",
        portal: "taxnetusa",
        missing_prerequisites: [`within_dedup_session_${Date.now()}`],
      },
      {
        action: "within_dedup_taxnet_b",
        type: "TaxNetUSA browser session workflow",
        description: "Blocked TaxNet form B (same blocker context)",
        portal: "taxnetusa",
        missing_prerequisites: [`within_dedup_session_${Date.now()}`],
      },
    ],
  });

  const reqs = result.propose?.capability_requests || [];
  const taxnetReqs = reqs.filter((r) => r.portal_surface === "taxnetusa");
  assert(
    taxnetReqs.length === 2,
    `Should have 2 taxnet capability request entries, got ${taxnetReqs.length}`,
  );

  const pending = taxnetReqs.filter((r) => r.status === "pending");
  const reused = taxnetReqs.filter((r) => r.status === "reused_existing");

  assert(
    pending.length === 1,
    `Should have exactly 1 pending request, got ${pending.length}`,
  );
  assert(
    reused.length === 1,
    `Should have exactly 1 reused request, got ${reused.length}`,
  );

  assert(
    reused[0].blocker_key === pending[0].blocker_key,
    "Within-cycle: reused and pending should share same blocker_key",
  );
  assert(
    reused[0].request_id === pending[0].request_id,
    "Within-cycle: reused should share same request_id",
  );

  console.log(
    `  PASS: Within-cycle dedup: 1 pending + 1 reused sharing blocker_key and request_id`,
  );
}

// ─── Test 3: Blocker_key with special chars (underscores) is handled correctly ───

async function testBlockerKeyWithUnderscores() {
  console.log(
    "\n=== Test 3: Blocker_key with underscores in value is matched correctly ===",
  );
  const firstCid = correlationId("underscore1");
  const secondCid = correlationId("underscore2");

  // This prerequisite naturally contains underscores (from normalizeHandle)
  const prereq = `test_underscore_value_${Date.now()}`;
  const actionPayload = {
    action: "underscore_test_taxnet_lookup",
    type: "TaxNetUSA browser session workflow",
    description: "Blocked TaxNet with underscore-rich prerequisite",
    portal: "taxnetusa",
    missing_prerequisites: [prereq],
  };

  // Cycle 1
  const first = await callTool("business_pm_loop", {
    objective: `Underscore blocker_key test cycle 1 [${firstCid}]`,
    correlation_id: firstCid,
    proposed_actions: [actionPayload],
  });
  const firstReq = (first.propose?.capability_requests || []).find((r) =>
    String(r.source || "").includes("online_portal_prerequisite"),
  );
  assert(firstReq, "Cycle 1 (underscore): should create request");
  const firstKey = firstReq.blocker_key;

  // Verify the capability_gap memory was persisted with exact key
  const gapRows = await callTool("memory_recall", {
    category: "capability_gap",
    query: firstCid,
    limit: 20,
  });
  const gaps = Array.isArray(gapRows) ? gapRows : [];
  const matchGap = gaps.find((r) => {
    const meta = r.metadata || {};
    return meta.blocker_key === firstKey;
  });
  assert(
    matchGap,
    "Cycle 1 (underscore): persisted gap should be findable by exact blocker_key",
  );

  // Cycle 2
  const second = await callTool("business_pm_loop", {
    objective: `Underscore blocker_key test cycle 2 [${secondCid}]`,
    correlation_id: secondCid,
    proposed_actions: [actionPayload],
  });
  const secondReq = (second.propose?.capability_requests || []).find((r) =>
    String(r.source || "").includes("online_portal_prerequisite"),
  );
  assert(secondReq, "Cycle 2 (underscore): should include request");

  assert(
    secondReq.blocker_key === firstKey,
    `Underscore blocker_key should match: ${secondReq.blocker_key} vs ${firstKey}`,
  );

  const isReused =
    String(secondReq.source || "").includes("reused") ||
    secondReq.status === "reused_existing" ||
    secondReq.request_id === firstReq.request_id;

  assert(
    isReused,
    `Underscore blocker_key: second cycle should reuse. source=${secondReq.source}, status=${secondReq.status}`,
  );

  console.log(
    `  PASS: Underscore-rich blocker_key correctly matched across cycles`,
  );
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("Blocker-Key Dedup Fix Tests");
  console.log("===========================");

  const health = await fetch(`${HERMES_URL}/health`);
  assert(health.ok, `Hermes health must be OK (got ${health.status})`);

  const tests = [
    testWithinCycleBlockerKeyDedup,
    testCrossCycleBlockerKeyDedup,
    testBlockerKeyWithUnderscores,
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

  console.log("\n===========================");
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${tests.length} total`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Fatal test error:", error);
  process.exit(1);
});
