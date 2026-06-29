#!/usr/bin/env node
/**
 * Integration tests for durable objective-cycle state.
 *
 * Validates:
 * - VAL-CORE-001
 * - VAL-CORE-002
 * - VAL-CORE-003
 * - VAL-CORE-014
 */

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
const TEST_PREFIX = "VALIDATION-CORE-DURABILITY";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function correlationId(tag) {
  return `${TEST_PREFIX}-${tag}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
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

  if (!res.ok)
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const raw = await res.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine)
    throw new Error(`No data line in SSE response: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(dataLine.slice(5).trim());
  if (envelope.error)
    throw new Error(
      `MCP error: ${JSON.stringify(envelope.error).slice(0, 300)}`,
    );
  return envelope.result;
}

async function callTool(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const content = result?.content?.[0]?.text;
  if (!content) throw new Error(`No content returned for tool ${name}`);
  try {
    return JSON.parse(content);
  } catch {
    return { _raw: content };
  }
}

function durabilityFailureSections() {
  return [
    "inbound_intents",
    "coordination_intents",
    "local_tasks",
    "local_task_outcomes",
    "capability_requests",
    "observations",
    "plan",
    "proposed_actions",
    "capability_gaps",
    "validation_evidence",
    "learning_memory_records",
    "learnings",
    "motto_skills_bridge",
    "recalled_bridges",
    "business_pm_output",
  ];
}

async function testValCore001_ObjectiveStatePersistsDurableKnowledge() {
  console.log(
    "\n=== VAL-CORE-001: Objective state persists as durable cycle knowledge ===",
  );
  const cid = correlationId("CORE001");
  const objective = `Durable knowledge linkage validation [${cid}]`;

  const cycle = await callTool("business_management_cycle", {
    objective,
    correlation_id: cid,
    observations: [
      {
        type: "validation_probe",
        summary: "Verifying durable knowledge linkage persistence",
        source: "objective-store-durability-test",
        timestamp: new Date().toISOString(),
        confidence: "high",
      },
    ],
  });

  assert(
    typeof cycle.knowledge_record_id === "string" &&
      cycle.knowledge_record_id.length > 0,
    "business_management_cycle should return non-null knowledge_record_id",
  );
  assert(
    typeof cycle.run_id === "string" && cycle.run_id.length > 0,
    "business_management_cycle should return run_id",
  );
  assert(
    cycle.correlation_id === cid,
    "business_management_cycle should echo provided correlation_id",
  );

  const recalled = await callTool("memory_recall", {
    category: "validation",
    query: cid,
    limit: 50,
  });

  const rows = asArray(recalled);
  const linked = rows.find((row) => {
    const record = asRecord(row);
    if (record.id === cycle.knowledge_record_id) return true;
    const metadata = asRecord(record.metadata);
    return metadata.correlation_id === cid && metadata.run_id === cycle.run_id;
  });

  assert(
    Boolean(linked),
    "memory_recall should include validation record linked to the cycle",
  );
  const linkedRecord = asRecord(linked);
  const metadata = asRecord(linkedRecord.metadata);
  assert(
    metadata.objective === objective,
    "Recalled validation record should preserve objective",
  );
  assert(
    metadata.correlation_id === cid,
    "Recalled validation record should preserve correlation_id",
  );
  assert(
    metadata.run_id === cycle.run_id,
    "Recalled validation record should preserve run_id",
  );

  console.log(
    `  PASS: knowledge_record_id=${cycle.knowledge_record_id} linked with run_id=${cycle.run_id}`,
  );
}

async function testValCore002_CorrelationAndRunLinkageAcrossArtifacts() {
  console.log(
    "\n=== VAL-CORE-002: Correlation and run linkage are consistent across emitted cycle artifacts ===",
  );
  const cid = correlationId("CORE002");

  const cycle = await callTool("business_management_cycle", {
    objective: `Artifact linkage validation [${cid}]`,
    correlation_id: cid,
  });

  assert(
    typeof cycle.run_id === "string" && cycle.run_id.length > 0,
    "Cycle should return run_id",
  );
  const emittedSections = asArray(cycle.emitted_sections);
  assert(emittedSections.length > 0, "Cycle should return emitted_sections");

  const runDetails = await callTool("fleet_get_run_details", {
    run_id: cycle.run_id,
  });
  const artifacts = asArray(runDetails.artifacts);
  assert(artifacts.length > 0, "fleet_get_run_details should return artifacts");

  for (const emittedSection of emittedSections) {
    const section = asRecord(emittedSection);
    const artifactId = section.artifact_id;
    assert(
      artifactId !== null && artifactId !== undefined,
      `Section ${section.section ?? "unknown"} should have artifact_id`,
    );

    const artifact = artifacts.find(
      (candidate) => asRecord(candidate).artifact_id === artifactId,
    );
    assert(
      Boolean(artifact),
      `Artifact ${artifactId} should be present in run details`,
    );

    const parsedBody = asRecord(
      asRecord(asRecord(artifact).content).parsed_body,
    );
    assert(
      parsedBody.correlation_id === cycle.correlation_id,
      `Artifact ${artifactId} should preserve correlation_id linkage`,
    );
    assert(
      parsedBody.run_id === cycle.run_id,
      `Artifact ${artifactId} should preserve run_id linkage`,
    );
  }

  console.log(
    `  PASS: Verified linkage across ${emittedSections.length} emitted sections`,
  );
}

async function testValCore003_RetryStateBoundedPerCycleInvocation() {
  console.log(
    "\n=== VAL-CORE-003: Retry state is bounded per cycle invocation ===",
  );
  const firstCid = correlationId("CORE003-A");
  const secondCid = correlationId("CORE003-B");

  const firstCycle = await callTool("business_management_cycle", {
    objective: `Retry reset baseline cycle [${firstCid}]`,
    correlation_id: firstCid,
    simulate_failures: {
      fleet_sections: durabilityFailureSections(),
    },
  });
  const firstRetries = asArray(firstCycle.pending_retries);
  assert(
    firstRetries.length > 0,
    "First cycle should produce pending_retries under simulated failures",
  );

  const secondCycle = await callTool("business_management_cycle", {
    objective: `Retry reset validation cycle [${secondCid}]`,
    correlation_id: secondCid,
    simulate_failures: {
      fleet_sections: ["plan"],
    },
  });

  const secondRetries = asArray(secondCycle.pending_retries);
  for (const retry of secondRetries) {
    const item = asRecord(retry);
    assert(
      item.correlation_id === secondCid,
      "Second cycle pending_retries should only contain entries scoped to second correlation_id",
    );
  }
  assert(
    !secondRetries.some((retry) => asRecord(retry).correlation_id === firstCid),
    "Second cycle pending_retries must not leak stale entries from first cycle",
  );

  const secondKnowledgeRetries = asArray(secondCycle.pending_knowledge_retries);
  for (const retry of secondKnowledgeRetries) {
    const item = asRecord(retry);
    assert(
      item.correlation_id === secondCid,
      "Second cycle pending_knowledge_retries should only contain entries scoped to second correlation_id",
    );
  }

  console.log(
    `  PASS: first pending_retries=${firstRetries.length}, second pending_retries=${secondRetries.length}`,
  );
}

async function testValCore014_RetryQueueBoundedUnderHighFailureVolume() {
  console.log(
    "\n=== VAL-CORE-014: Retry queue remains bounded under high failure volume ===",
  );
  const cid = correlationId("CORE014");

  const cycle = await callTool("business_management_cycle", {
    objective: `High-failure bounded retry validation [${cid}]`,
    correlation_id: cid,
    simulate_failures: {
      fleet_sections: durabilityFailureSections(),
      knowledge_store: true,
    },
  });

  const pendingRetries = asArray(cycle.pending_retries);
  const pendingKnowledgeRetries = asArray(cycle.pending_knowledge_retries);

  assert(
    pendingRetries.length <= 25,
    `pending_retries must be bounded at 25, got ${pendingRetries.length}`,
  );
  assert(
    pendingKnowledgeRetries.length <= 25,
    `pending_knowledge_retries must be bounded at 25, got ${pendingKnowledgeRetries.length}`,
  );

  for (const retry of pendingRetries) {
    const item = asRecord(retry);
    assert(
      item.correlation_id === cid,
      "pending_retries entries should be scoped to active correlation_id",
    );
  }
  for (const retry of pendingKnowledgeRetries) {
    const item = asRecord(retry);
    assert(
      item.correlation_id === cid,
      "pending_knowledge_retries entries should be scoped to active correlation_id",
    );
  }

  console.log(
    `  PASS: pending_retries=${pendingRetries.length}, pending_knowledge_retries=${pendingKnowledgeRetries.length}`,
  );
}

async function main() {
  try {
    const health = await fetch(`${HERMES_URL}/health`);
    if (!health.ok)
      throw new Error(`Health check failed: HTTP ${health.status}`);
    const payload = await health.json();
    console.log(`Hermes health: ${payload.status} v${payload.version}`);
  } catch (error) {
    console.error(
      `FATAL: Hermes not reachable at ${HERMES_URL}: ${error.message}`,
    );
    process.exit(1);
  }

  const tests = [
    testValCore001_ObjectiveStatePersistsDurableKnowledge,
    testValCore002_CorrelationAndRunLinkageAcrossArtifacts,
    testValCore003_RetryStateBoundedPerCycleInvocation,
    testValCore014_RetryQueueBoundedUnderHighFailureVolume,
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

  console.log("\n========================================");
  console.log(
    `Objective durability results: ${passed} passed, ${failed} failed, ${tests.length} total`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Fatal test error: ${error.message}`);
  process.exit(1);
});
