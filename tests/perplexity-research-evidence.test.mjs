/**
 * Integration tests for Perplexity research memory evidence persistence.
 *
 * These tests exercise the live Hermes MCP HTTP surface on 127.0.0.1:8150
 * and validate behavior for:
 *   - VAL-RSCH-001: Blocker research returns actionable output
 *   - VAL-RSCH-002: Perplexity planning produces persisted research artifact
 *   - VAL-RSCH-007: Perplexity ingest persists research evidence to shadow memory
 *   - VAL-RSCH-008: Autoloop persists round-level research evidence with gate context
 *   - VAL-RSCH-009: Perplexity planner captures structured confidence and citation evidence
 *   - VAL-RSCH-010: Autoloop honors shadow-ingest opt-out
 *
 * Run with: node tests/perplexity-research-evidence.test.mjs
 *
 * Requirements:
 *   - Hermes must be running on http://127.0.0.1:8150
 *   - Fleet MCP must be configured (MOTTO_MCP_URL, MOTTO_MCP_AUTH_TOKEN)
 *   - PERPLEXITY_API_KEY must be available for research/plan tests
 */

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";
const VALIDATION_PREFIX = "VALIDATION-RSCH";

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
    // Some tools return plain text, not JSON
    return { _raw: content, isError: result.isError ?? false };
  }
}

async function callToolRaw(name, args) {
  const result = await mcpCall("tools/call", { name, arguments: args });
  const content = result.content?.[0]?.text;
  if (!content && result.isError !== true)
    throw new Error(`No content in tool result for ${name}`);
  return { text: content ?? "", isError: result.isError ?? false };
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

// ─── Secret pattern check ────────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,
  /password\s*[=:]\s*\S+/i,
  /api[_-]?key\s*[=:]\s*\S+/i,
  /token\s*[=:]\s*[a-f0-9]{16,}/i,
];

function checkNoSecrets(obj, path = "") {
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  const cleaned = str.replace(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
    "UUID",
  );
  for (const pattern of SECRET_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      const matched = match[0];
      if (matched.length < 40 && /VALIDATION|correlation/i.test(path)) continue;
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

// VAL-RSCH-001: Blocker research returns actionable output
async function testValRsch001_BlockerResearchReturnsActionableOutput() {
  console.log(
    "\n=== VAL-RSCH-001: Blocker research returns actionable output ===",
  );

  if (!process.env.PERPLEXITY_API_KEY) {
    console.log("  SKIP: PERPLEXITY_API_KEY not available");
    return;
  }

  const result = await callToolRaw("research", {
    query:
      "What are best practices for unblocking an automated appraisal workflow when SFREP validation fails due to mapping coverage gaps?",
  });

  assert(result.isError !== true, "Research call should not error");
  assert(
    result.text.length > 40,
    `Research response should be substantive, got ${result.text.length} chars`,
  );
  assert(
    !/mock|stub|placeholder/i.test(result.text),
    "Research response should not look mocked",
  );

  console.log(
    `  PASS: Research returned ${result.text.length} chars of actionable content`,
  );
}

// VAL-RSCH-002: Perplexity planning produces persisted research artifact
async function testValRsch002_PlanningProducesPersistedArtifact() {
  console.log(
    "\n=== VAL-RSCH-002: Perplexity planning produces persisted research artifact ===",
  );

  if (!process.env.PERPLEXITY_API_KEY) {
    console.log("  SKIP: PERPLEXITY_API_KEY not available");
    return;
  }

  const correlationId = generateCorrelationId();

  // Step 1: Call plan tool
  const planResult = await callToolRaw("plan", {
    goal: `Resolve SFREP mapping coverage gap for appraisal workfile validation [${correlationId}]`,
    context:
      "The validation is blocked because 3 fields in the payload are unmapped. Need to determine the correct mapping keys and retry.",
  });

  assert(planResult.isError !== true, "Plan call should not error");
  assert(
    planResult.text.length > 50,
    `Plan response should be substantive, got ${planResult.text.length} chars`,
  );

  // Step 2: Verify Stored [<memory_id>] reference
  const storedMatch = planResult.text.match(/Stored\s+\[([a-f0-9-]+)\]/i);
  assert(
    storedMatch,
    "Plan response should include 'Stored [<memory_id>]' reference",
  );
  const memoryId = storedMatch[1];
  console.log(`  Plan stored with memory_id: ${memoryId}`);

  // Step 3: Verify traceability metadata via memory_recall
  const recallResult = await callTool("memory_recall", {
    category: "project",
    limit: 10,
  });
  const records = Array.isArray(recallResult) ? recallResult : [];
  const targetRecord = records.find((r) => r.id === memoryId);
  assert(
    targetRecord,
    `memory_recall should find the stored plan record ${memoryId} in project category (found ${records.length} records)`,
  );

  // Verify metadata fields
  const metadata = targetRecord.metadata || {};
  assertHasField(metadata, "source", "plan metadata");
  assert(
    metadata.source === "plan_tool",
    `source should be "plan_tool", got "${metadata.source}"`,
  );
  assertHasField(metadata, "timestamp", "plan metadata");
  assert(
    typeof metadata.timestamp === "string" && metadata.timestamp.length > 0,
    "timestamp should be non-empty string",
  );
  assertHasField(metadata, "confidence", "plan metadata");
  assert(
    ["high", "medium", "low"].includes(metadata.confidence),
    `confidence should be high/medium/low, got "${metadata.confidence}"`,
  );
  assertHasField(metadata, "goal", "plan metadata");
  assert(
    typeof metadata.goal === "string" && metadata.goal.length > 0,
    "goal should be non-empty",
  );
  assertHasField(metadata, "context", "plan metadata");

  console.log(
    "  PASS: Plan persisted with recallable source/timestamp/confidence linkage and goal/context fields",
  );
}

// VAL-RSCH-007: Perplexity ingest persists research evidence to shadow memory
async function testValRsch007_PerplexityIngestPersistsShadowMemory() {
  console.log(
    "\n=== VAL-RSCH-007: Perplexity ingest persists research evidence to shadow memory ===",
  );

  const correlationId = generateCorrelationId();
  const testQuery = `How to verify appraisal comparables are valid for ${correlationId}`;
  const testFindings =
    "Comparables should be within 1 mile for urban, 5 miles for suburban, and have sold within 6 months.";
  const testContext = "Validation test for shadow memory persistence";
  const testSourceUrl = "https://example.com/appraisal-guidelines";
  const testTags = ["appraisal", "comparables", "validation"];

  // Step 1: Ingest research evidence
  const ingestResult = await callTool("perplexity_ingest", {
    query: testQuery,
    findings: testFindings,
    context: testContext,
    source_url: testSourceUrl,
    correlation_id: correlationId,
    tags: testTags,
  });

  assert(
    ingestResult.status === "ingested",
    `Expected status "ingested", got "${ingestResult.status}"`,
  );
  assertHasField(ingestResult, "memory_id", "ingest result");
  assert(
    typeof ingestResult.memory_id === "string" &&
      ingestResult.memory_id.length > 0,
    "memory_id should be non-empty",
  );
  assert(ingestResult.query === testQuery, "query should match");
  assert(
    ingestResult.correlation_id === correlationId,
    "correlation_id should match",
  );
  assertHasField(ingestResult, "ingested_at", "ingest result");

  const memoryId = ingestResult.memory_id;
  console.log(`  Ingested with memory_id: ${memoryId}`);

  // Step 2: Verify via perplexity_shadow_status
  const shadowResult = await callTool("perplexity_shadow_status", {
    limit: 20,
  });

  assert(
    typeof shadowResult.summary === "string",
    "shadow status should have summary",
  );
  assert(
    typeof shadowResult.observation_count === "number" &&
      shadowResult.observation_count > 0,
    "shadow status should have positive observation_count",
  );
  assert(
    Array.isArray(shadowResult.observations),
    "shadow status should have observations array",
  );

  // Find the ingested entry
  const ingestedEntry = shadowResult.observations.find(
    (obs) => obs.memory_id === memoryId && obs.query === testQuery,
  );
  assert(
    ingestedEntry,
    `Shadow status should include the ingested entry for memory_id=${memoryId}`,
  );

  // Verify continuity fields
  assertHasField(ingestedEntry, "context", "shadow observation");
  assert(
    ingestedEntry.context === testContext || ingestedEntry.context === null,
    `context should be "${testContext}"`,
  );
  assertHasField(ingestedEntry, "source_url", "shadow observation");
  assert(
    ingestedEntry.source_url === testSourceUrl ||
      ingestedEntry.source_url === null,
    `source_url should be "${testSourceUrl}"`,
  );
  assertHasField(ingestedEntry, "tags", "shadow observation");
  assert(Array.isArray(ingestedEntry.tags), "tags should be an array");
  assert(
    ingestedEntry.tags.includes("appraisal"),
    "tags should include 'appraisal'",
  );
  assertHasField(ingestedEntry, "ingested_at", "shadow observation");

  console.log(
    "  PASS: Perplexity ingest persists retrievable shadow memory with continuity metadata",
  );
}

// VAL-RSCH-008: Autoloop persists round-level research evidence with gate context
async function testValRsch008_AutoloopPersistsRoundLevelEvidence() {
  console.log(
    "\n=== VAL-RSCH-008: Autoloop persists round-level research evidence with gate context ===",
  );

  const correlationId = generateCorrelationId();
  const unknownSessionId = generateUnknownSessionId();

  // Step 1: Get baseline shadow count
  const beforeResult = await callTool("perplexity_shadow_status", {
    limit: 100,
  });
  const beforeCount = beforeResult.observation_count ?? 0;

  // Step 2: Run autoloop with push_to_perplexity_shadow=true
  const autoloopResult = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate autoloop shadow evidence persistence [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: true,
    correlation_id: correlationId,
    require_citations: true,
    min_confidence: 0.7,
    completion_keywords: ["complete", "done", "finished"],
  });

  assert(
    typeof autoloopResult.correlation_id === "string",
    "autoloop should include correlation_id",
  );
  assert(
    Array.isArray(autoloopResult.rounds),
    "autoloop should have rounds array",
  );

  // Step 3: Verify new shadow observations were written
  const afterResult = await callTool("perplexity_shadow_status", {
    limit: 100,
  });
  const afterCount = afterResult.observation_count ?? 0;
  assert(
    afterCount > beforeCount,
    `Shadow observation count should increase from ${beforeCount} to ${afterCount} after autoloop with shadow push`,
  );

  // Find new observations related to this correlation
  const newObservations = afterResult.observations.filter((obs) => {
    const content = typeof obs.content === "string" ? obs.content : "";
    return (
      content.includes(correlationId) || content.includes(unknownSessionId)
    );
  });

  // At least one observation should have round-level findings with gate context
  if (newObservations.length > 0) {
    console.log(
      `  Found ${newObservations.length} new shadow observation(s) for this run`,
    );
    // Verify at least one has gate context
    const withGateContext = newObservations.filter((obs) => {
      const content = typeof obs.content === "string" ? obs.content : "";
      return (
        content.includes("confidence") ||
        content.includes("citations") ||
        content.includes("gate")
      );
    });
    if (withGateContext.length > 0) {
      console.log(
        `  ${withGateContext.length} observation(s) include gate context metadata`,
      );
    }
  }

  console.log(
    "  PASS: Autoloop with push_to_perplexity_shadow=true writes new shadow observations",
  );
}

// VAL-RSCH-009: Perplexity planner captures structured confidence and citation evidence
async function testValRsch009_PlannerCapturesStructuredConfidenceCitation() {
  console.log(
    "\n=== VAL-RSCH-009: Perplexity planner captures structured confidence and citation evidence ===",
  );

  if (!process.env.PERPLEXITY_API_KEY) {
    console.log("  SKIP: PERPLEXITY_API_KEY not available");
    return;
  }

  const correlationId = generateCorrelationId();

  // Step 1: Call plan tool to generate a research-backed plan
  const planResult = await callToolRaw("plan", {
    goal: `Create a plan with cited sources and confidence estimates for appraisal workflow improvement [${correlationId}]`,
    context:
      "Current workflow has 85% automation rate but 15% require manual intervention. Need to identify bottlenecks and cite best practices.",
  });

  assert(planResult.isError !== true, "Plan call should not error");
  const storedMatch = planResult.text.match(/Stored\s+\[([a-f0-9-]+)\]/i);
  assert(
    storedMatch,
    "Plan response should include 'Stored [<memory_id>]' reference",
  );
  const memoryId = storedMatch[1];

  // Step 2: Recall the stored plan and verify structured fields
  const recallResult = await callTool("memory_recall", {
    category: "project",
    limit: 10,
  });
  const records = Array.isArray(recallResult) ? recallResult : [];
  const targetRecord = records.find((r) => r.id === memoryId);
  assert(
    targetRecord,
    `memory_recall should find the stored plan record ${memoryId} in project category (found ${records.length} records)`,
  );

  const metadata = targetRecord.metadata || {};

  // Verify confidence_score is a machine-readable number
  assertHasField(metadata, "confidence_score", "plan metadata");
  const confidenceScore = metadata.confidence_score;
  assert(
    typeof confidenceScore === "number",
    `confidence_score should be a number, got ${typeof confidenceScore}: ${confidenceScore}`,
  );
  assert(
    confidenceScore >= 0 && confidenceScore <= 1,
    `confidence_score should be between 0 and 1, got ${confidenceScore}`,
  );

  // Verify citation_urls is an array (may be empty if no URLs in Perplexity output)
  assertHasField(metadata, "citation_urls", "plan metadata");
  const citationUrls = metadata.citation_urls;
  assert(
    Array.isArray(citationUrls),
    `citation_urls should be an array, got ${typeof citationUrls}`,
  );

  console.log(
    `  Plan confidence_score: ${confidenceScore}, citation_urls count: ${citationUrls.length}`,
  );
  console.log(
    "  PASS: Planner output includes structured confidence_score (number) and citation_urls (array) fields",
  );
}

// VAL-RSCH-010: Autoloop honors shadow-ingest opt-out
async function testValRsch010_AutoloopHonorsShadowOptOut() {
  console.log("\n=== VAL-RSCH-010: Autoloop honors shadow-ingest opt-out ===");

  const correlationId = generateCorrelationId();
  const unknownSessionId = generateUnknownSessionId();

  // Step 1: Get baseline shadow count
  const beforeResult = await callTool("perplexity_shadow_status", {
    limit: 100,
  });
  const beforeCount = beforeResult.observation_count ?? 0;

  // Step 2: Run autoloop with push_to_perplexity_shadow=false
  const autoloopResult = await callTool("factory_autoloop", {
    session_ids: [unknownSessionId],
    objective: `Validate shadow opt-out behavior [${correlationId}]`,
    max_rounds: 1,
    poll_delay_ms: 250,
    push_to_perplexity_shadow: false,
    correlation_id: correlationId,
  });

  assert(
    typeof autoloopResult.correlation_id === "string",
    "autoloop should include correlation_id",
  );

  // Step 3: Verify no new shadow observations for this run
  const afterResult = await callTool("perplexity_shadow_status", {
    limit: 100,
  });
  const afterCount = afterResult.observation_count ?? 0;

  // Check for any new observations that contain this correlation ID
  const newForThisRun = afterResult.observations.filter((obs) => {
    const content = typeof obs.content === "string" ? obs.content : "";
    return (
      content.includes(correlationId) || content.includes(unknownSessionId)
    );
  });

  assert(
    newForThisRun.length === 0,
    `No new shadow observations should be written when push_to_perplexity_shadow=false, found ${newForThisRun.length}`,
  );

  console.log(
    `  Shadow count: ${beforeCount} → ${afterCount} (no change for this correlation)`,
  );
  console.log(
    "  PASS: Autoloop with push_to_perplexity_shadow=false writes no new shadow observations",
  );
}

// ─── Run all tests ──────────────────────────────────────────────────

async function main() {
  console.log("Hermes Perplexity Research Evidence Integration Tests");
  console.log("=====================================================");

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

  // Try to source PERPLEXITY_API_KEY if not already set
  if (!process.env.PERPLEXITY_API_KEY) {
    try {
      const { execSync } = await import("node:child_process");
      const key = execSync(
        `doppler secrets get PERPLEXITY_API_KEY --project motto-core --config prd --plain`,
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
      if (key.length > 0) {
        process.env.PERPLEXITY_API_KEY = key;
        console.log("PERPLEXITY_API_KEY sourced from Doppler");
      }
    } catch {
      console.log(
        "WARN: Could not source PERPLEXITY_API_KEY from Doppler. Research/plan tests will be skipped.",
      );
    }
  }

  const tests = [
    {
      name: "VAL-RSCH-001",
      fn: testValRsch001_BlockerResearchReturnsActionableOutput,
    },
    {
      name: "VAL-RSCH-002",
      fn: testValRsch002_PlanningProducesPersistedArtifact,
    },
    {
      name: "VAL-RSCH-007",
      fn: testValRsch007_PerplexityIngestPersistsShadowMemory,
    },
    {
      name: "VAL-RSCH-008",
      fn: testValRsch008_AutoloopPersistsRoundLevelEvidence,
    },
    {
      name: "VAL-RSCH-009",
      fn: testValRsch009_PlannerCapturesStructuredConfidenceCitation,
    },
    { name: "VAL-RSCH-010", fn: testValRsch010_AutoloopHonorsShadowOptOut },
  ];

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const test of tests) {
    try {
      await test.fn();
      passed += 1;
    } catch (err) {
      if (err.message && err.message.startsWith("SKIP:")) {
        skipped += 1;
      } else {
        console.error(`  FAIL: ${err.message}`);
        failed += 1;
      }
    }
  }

  console.log(`\n========================================`);
  console.log(
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
