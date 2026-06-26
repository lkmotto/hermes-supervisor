#!/usr/bin/env node
/**
 * Regression test for SFREP autonomous handoff deterministic fallback on
 * no-AI-response path.
 *
 * When neither Ollama nor Groq returns a valid AI response (missing keys,
 * unreachable hosts), handleSfrepAutonomousHandoff must fall back to
 * deterministic catalog mapping immediately on the first attempt —
 * matching the contract established by handleSfrepContextTransport.
 *
 * Run with: node tests/sfrep-deterministic-fallback.test.mjs
 *
 * Requirements:
 *   - Hermes must be running on http://127.0.0.1:8150
 *   - No GROQ_API_KEY must be set (or it won't hurt — Ollama and Groq
 *     are tried first, and if they both fail the no-response else fires)
 *   - OLLAMA_HOST should point to an unreachable host (or be unset) so
 *     the Ollama path fails, ensuring the no-response branch is exercised
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";

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
  try {
    return JSON.parse(content);
  } catch {
    return { _raw: content, isError: result.isError ?? false };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertHasField(obj, field, context) {
  assert(obj && typeof obj === "object" && field in obj, `${context}: missing field "${field}"`);
}

// ─── Fixture helpers ────────────────────────────────────────────────

function createWorkfileFixture() {
  const dir = mkdtempSync(join(tmpdir(), "sfrep-fallback-test-"));
  const extractedDir = join(dir, "extracted");
  mkdirSync(extractedDir, { recursive: true });

  const facts = [
    { canonical_key: "subject.address.street", value: "123 Main St", value_type: "string", status: "grounded", source_path: "doc1.txt" },
    { canonical_key: "subject.address.city", value: "Springfield", value_type: "string", status: "grounded", source_path: "doc1.txt" },
    { canonical_key: "subject.address.state", value: "IL", value_type: "string", status: "grounded", source_path: "doc1.txt" },
    { canonical_key: "subject.address.zip", value: "62701", value_type: "string", status: "grounded", source_path: "doc1.txt" },
    { canonical_key: "subject.gla", value: 1850, value_type: "number", status: "grounded", source_path: "doc2.txt" },
    { canonical_key: "subject.year_built", value: 1995, value_type: "number", status: "grounded", source_path: "doc2.txt" },
    { canonical_key: "subject.beds", value: 3, value_type: "number", status: "grounded", source_path: "doc1.txt" },
    { canonical_key: "subject.baths", value: 2, value_type: "number", status: "grounded", source_path: "doc1.txt" },
    // conflict fact — should be excluded from payload
    { canonical_key: "subject.lot_size", value: "0.25 acre", value_type: "string", status: "conflict", source_path: "doc3.txt" },
    // missing fact — should be excluded from payload
    { canonical_key: "subject.pool", value: null, value_type: null, status: "missing", source_path: null },
  ];

  writeFileSync(join(extractedDir, "facts.json"), JSON.stringify(facts, null, 2), "utf8");
  return dir;
}

function cleanupWorkfileFixture(dir) {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

const TESTS = [];

TESTS.push({
  name: "noAiResponseFallsBackToDeterministicMapping",
  async run() {
    const wf = createWorkfileFixture();
    try {
      const result = await callTool("sfrep_autonomous_handoff", {
        workfile_path: wf,
        max_attempts: 3,
      });

      // Status must be "ready", not "blocked" — the deterministic
      // fallback should produce a valid payload.
      assert(result.status === "ready",
        `Expected status "ready", got "${result.status}"`);

      // Attempt count should be 1 — the no-AI branch breaks out of
      // the loop immediately, not wasting retries on empty responses.
      assert(result.attempt_count === 1,
        `Expected attempt_count=1 (no wasted retries), got ${result.attempt_count}`);

      // Mapping plan must indicate deterministic fallback.
      assert(
        result.mapping_plan != null && result.mapping_plan.includes("deterministic"),
        `Expected mapping_plan to include "deterministic", got "${result.mapping_plan}"`
      );

      // Payload should contain the mappable grounded facts.
      assertHasField(result, "field_count", "result");
      assert(result.field_count >= 7,
        `Expected at least 7 mapped fields, got ${result.field_count}`);

      // Verify the payload file was written.
      const payloadPath = join(wf, "sfrep", "payload.json");
      assert(existsSync(payloadPath),
        `Payload file not found at ${payloadPath}`);

      // Read the payload and check specific keys are mapped correctly.
      const payloadJSON = JSON.parse(readFileSync(payloadPath, "utf8"));
      assert(payloadJSON.StreetAddress === "123 Main St",
        `Expected StreetAddress "123 Main St", got "${payloadJSON.StreetAddress}"`);
      assert(payloadJSON.City === "Springfield",
        `Expected City "Springfield", got "${payloadJSON.City}"`);
      assert(payloadJSON.GLA === 1850,
        `Expected GLA 1850, got ${payloadJSON.GLA}`);
      assert(payloadJSON.Bedrooms === 3,
        `Expected Bedrooms 3, got ${payloadJSON.Bedrooms}`);

      // Conflict and missing facts must NOT appear in the payload.
      assert(!("LotSize" in payloadJSON),
        "Conflict fact (lot_size) should not appear in payload");
      assert(!("Pool" in payloadJSON),
        "Missing fact (pool) should not appear in payload");

      return true;
    } finally {
      cleanupWorkfileFixture(wf);
    }
  },
});

TESTS.push({
  name: "deterministicFallbackProducesReadyStatus",
  async run() {
    const wf = createWorkfileFixture();
    try {
      const result = await callTool("sfrep_autonomous_handoff", {
        workfile_path: wf,
        max_attempts: 1,
      });

      assert(result.status === "ready",
        `Expected status "ready", got "${result.status}"`);

      assert(result.ready_for_sfrep_apply === true,
        `Expected ready_for_sfrep_apply=true, got ${result.ready_for_sfrep_apply}`);

      assert(result.field_count > 0,
        `Expected field_count > 0, got ${result.field_count}`);

      // Diagnostics should mention the deterministic fallback.
      const diagText = Array.isArray(result.diagnostics)
        ? result.diagnostics.join(" ")
        : String(result.diagnostics ?? "");
      assert(
        diagText.includes("deterministic fallback"),
        `Diagnostics should mention "deterministic fallback", got: ${diagText}`
      );

      return true;
    } finally {
      cleanupWorkfileFixture(wf);
    }
  },
});

TESTS.push({
  name: "noGroundedFactsReturnsBlocked",
  async run() {
    // Create a workfile with no grounded facts at all.
    const dir = mkdtempSync(join(tmpdir(), "sfrep-fallback-test-"));
    const extractedDir = join(dir, "extracted");
    mkdirSync(extractedDir, { recursive: true });
    writeFileSync(join(extractedDir, "facts.json"), JSON.stringify([
      { canonical_key: "subject.beds", value: null, status: "missing" },
    ]), "utf8");

    try {
      const result = await callTool("sfrep_autonomous_handoff", {
        workfile_path: dir,
        max_attempts: 3,
      });

      assert(result.status === "blocked",
        `Expected status "blocked" for no grounded facts, got "${result.status}"`);
      assert(result.reason === "empty_payload" || String(result.reason).includes("empty"),
        `Expected reason containing "empty", got "${result.reason}"`);
      assert(result.field_count === 0,
        `Expected field_count=0, got ${result.field_count}`);
      assert(result.attempt_count === 0,
        `Expected attempt_count=0 (loop never entered), got ${result.attempt_count}`);

      return true;
    } finally {
      cleanupWorkfileFixture(dir);
    }
  },
});

// ─── Runner ─────────────────────────────────────────────────────────

async function runTests() {
  // Ensure AI services are unreachable so the no-response path fires.
  // Save original values for restoration.
  const origGroq = process.env.GROQ_API_KEY;
  const origOllamaHost = process.env.OLLAMA_HOST;
  const origOllamaModel = process.env.OLLAMA_MODEL;

  // Clear GROQ_API_KEY so the Groq path is skipped.
  delete process.env.GROQ_API_KEY;
  // Point Ollama at an unreachable host so the Ollama path fails
  // quickly (doable localhost port that nothing listens on).
  process.env.OLLAMA_HOST = "http://127.0.0.1:19999";
  process.env.OLLAMA_MODEL = "gemma3:4b";

  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(`Running ${TESTS.length} SFREP deterministic-fallback regression tests...\n`);

  for (const test of TESTS) {
    try {
      const ok = await test.run();
      if (ok) {
        console.log(`  ✓ ${test.name}`);
        passed++;
      } else {
        failed++;
        failures.push({ name: test.name, error: "test returned false" });
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${test.name}: ${msg}`);
      failures.push({ name: test.name, error: msg });
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  // Restore env
  if (origGroq != null) process.env.GROQ_API_KEY = origGroq;
  if (origOllamaHost != null) process.env.OLLAMA_HOST = origOllamaHost;
  if (origOllamaModel != null) process.env.OLLAMA_MODEL = origOllamaModel;

  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }

  console.log("All SFREP deterministic-fallback regression tests passed.");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
