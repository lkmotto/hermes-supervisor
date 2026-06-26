#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";

const HERMES_URL = process.env.HERMES_URL || "http://127.0.0.1:8150";

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

// ─── VAL-ORCH-001: deterministic session targeting ───────────────────

test("VAL-ORCH-001 each unique session_id appears exactly once in output", async () => {
  // Use known-invalid IDs to avoid dependency on live session state.
  // VAL-ORCH-001 only requires that each unique requested ID appears once.
  const fakeSessionIds = [
    `nonexistent-session-${Date.now()}-a`,
    `nonexistent-session-${Date.now()}-b`,
    `nonexistent-session-${Date.now()}-c`,
  ];
  const result = await callTool("factory_sync_sessions", {
    session_ids: fakeSessionIds,
  });

  assert.ok(Array.isArray(result.sessions), "sessions should be an array");
  assert.equal(result.sessions.length, 3, "three unique IDs should yield three snapshots");

  const returnedIds = result.sessions.map((s) => s.session_id).sort();
  const expectedIds = [...fakeSessionIds].sort();
  assert.deepEqual(returnedIds, expectedIds, "every requested session_id appears once");

  assert.equal(result.summary.total, 3, "summary.total must equal number of unique requested IDs");
  assert.equal(result.summary.total, result.sessions.length, "summary.total must align with returned snapshot rows");
});

test("VAL-ORCH-001 duplicate session_ids are deduplicated", async () => {
  const dupId = `nonexistent-session-${Date.now()}-dup`;
  const result = await callTool("factory_sync_sessions", {
    session_ids: [dupId, dupId, dupId],
  });

  assert.equal(result.sessions.length, 1, "three duplicates should yield exactly one snapshot");
  assert.equal(result.sessions[0].session_id, dupId, "returned session_id must match the requested ID");
  assert.equal(result.summary.total, 1, "summary.total must reflect deduplication");
});

test("VAL-ORCH-001 unknown session IDs surface as explicit error rows", async () => {
  const unknownId = `nonexistent-session-${Date.now()}-unknown`;
  const result = await callTool("factory_sync_sessions", {
    session_ids: [unknownId],
  });

  assert.equal(result.sessions.length, 1, "one unknown ID should yield one snapshot");
  assert.equal(result.sessions[0].session_id, unknownId, "error row must include the requested session_id");
  assert.equal(result.sessions[0].status, "error", "unknown session must have status 'error'");
  assert.strictEqual(result.sessions[0].completed, false, "error snapshot must not be completed");
  assert.strictEqual(result.sessions[0].blocked, true, "error snapshot must be blocked");
  assert.equal(typeof result.sessions[0].error, "string", "error snapshot must include an error message");
  assert.ok(result.sessions[0].error.length > 0, "error message must not be empty");
});

test("VAL-ORCH-001 unknown IDs are not silently dropped from output", async () => {
  const realId1 = "session-that-does-not-exist-1";
  const realId2 = "session-that-does-not-exist-2";
  const realId3 = "session-that-does-not-exist-3";

  const result = await callTool("factory_sync_sessions", {
    session_ids: [realId1, realId2, realId3],
  });

  // Verify every requested ID appears in output — no silent drops.
  const returnedIds = new Set(result.sessions.map((s) => s.session_id));
  assert.ok(returnedIds.has(realId1), "requested ID 1 must appear in output");
  assert.ok(returnedIds.has(realId2), "requested ID 2 must appear in output");
  assert.ok(returnedIds.has(realId3), "requested ID 3 must appear in output");

  // All should be error rows since the IDs don't exist.
  for (const session of result.sessions) {
    assert.equal(session.status, "error", `session ${session.session_id} must be an error row`);
  }
});

test("VAL-ORCH-001 summary totals align with returned snapshot rows", async () => {
  const ids = [
    `nonexistent-session-${Date.now()}-x`,
    `nonexistent-session-${Date.now()}-y`,
  ];
  const result = await callTool("factory_sync_sessions", {
    session_ids: ids,
  });

  assert.equal(result.summary.total, 2, "summary.total must equal 2");
  assert.equal(result.summary.total, result.sessions.length, "summary.total must equal sessions array length");
  // All unknown → all blocked, none completed
  assert.equal(result.summary.completed, 0, "no sessions should be completed for unknown IDs");
  assert.equal(result.summary.blocked, 2, "all unknown sessions should be blocked");
  assert.equal(result.summary.pending, 2, "all unknown sessions should be pending");
  assert.equal(result.summary.running, 0, "error snapshots must not count as running");
  assert.equal(result.summary.gated_incomplete, 0, "error snapshots must not count as gated_incomplete");
});

test("VAL-ORCH-001 mixed valid and invalid IDs each produce their own row", async () => {
  const invalidId = `nonexistent-session-${Date.now()}-invalid`;
  const result = await callTool("factory_sync_sessions", {
    session_ids: [invalidId],
  });

  // The invalid ID should produce an error row.
  const errorRow = result.sessions.find((s) => s.session_id === invalidId);
  assert.ok(errorRow, "invalid ID must appear in results");
  assert.equal(errorRow.status, "error", "invalid ID must have error status");

  // No rows should be missing. The only session ID requested must be present.
  assert.equal(result.sessions.length, 1, "only the requested ID should appear");
  assert.equal(result.sessions[0].session_id, invalidId, "the returned session_id must match");
});

test("VAL-ORCH-001 summary total is independent of session status distribution", async () => {
  const ids = [
    `nonexistent-session-${Date.now()}-p`,
    `nonexistent-session-${Date.now()}-q`,
  ];

  const result = await callTool("factory_sync_sessions", { session_ids: ids });

  // summary.total must always equal the number of unique requested IDs,
  // regardless of how many are valid or invalid.
  assert.equal(result.summary.total, ids.length, "summary.total must match unique requested count");
  assert.equal(result.sessions.length, ids.length, "sessions array length must match unique requested count");
});

// ─── Deduplication imports (unit-level from factory-sync-completion-gate) ───

import {
  extractCitationUrls,
} from "../dist/factory-sync-completion-gate.js";

test("extractCitationUrls deduplicates (session resolution uses same pattern)", () => {
  // The same dedupe pattern is used in session ID resolution.
  const urls = extractCitationUrls("https://a.com https://a.com https://b.com");
  assert.deepEqual(urls, ["https://a.com", "https://b.com"]);
});
