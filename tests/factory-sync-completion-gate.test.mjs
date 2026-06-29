#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCitationUrls,
  extractConfidenceScore,
  latestAssistantMessageSnapshot,
  normalizeConfidenceThreshold,
} from "../dist/factory-sync-completion-gate.js";

test("latestAssistantMessageSnapshot prefers newest assistant timestamp", () => {
  const snapshot = latestAssistantMessageSnapshot([
    {
      id: "m-old",
      role: "assistant",
      text: "DONE with confidence: 95%",
      created_at: "2026-01-01T10:00:00.000Z",
    },
    {
      id: "m-new",
      role: "assistant",
      text: "Still validating, not done yet.",
      created_at: "2026-01-01T10:01:00.000Z",
    },
  ]);

  assert.equal(snapshot.message_id, "m-new");
  assert.equal(snapshot.full_text, "Still validating, not done yet.");
});

test("latestAssistantMessageSnapshot breaks timestamp ties by latest array position", () => {
  const snapshot = latestAssistantMessageSnapshot([
    {
      id: "m-1",
      role: "assistant",
      text: "Earlier assistant content",
      created_at: "2026-01-01T10:00:00.000Z",
    },
    {
      id: "m-2",
      role: "assistant",
      text: "Later assistant content",
      created_at: "2026-01-01T10:00:00.000Z",
    },
  ]);

  assert.equal(snapshot.message_id, "m-2");
  assert.equal(snapshot.summary, "Later assistant content");
});

test("latestAssistantMessageSnapshot ignores non-assistant role and missing role", () => {
  const snapshot = latestAssistantMessageSnapshot([
    { id: "m-0", role: "assistant", text: "Initial assistant update" },
    { id: "m-x", text: "DONE without role should be ignored" },
    { id: "m-1", role: "user", text: "User follow-up" },
    { id: "m-2", role: "assistant", text: "Latest assistant update" },
  ]);

  assert.equal(snapshot.message_id, "m-2");
  assert.equal(snapshot.full_text, "Latest assistant update");
});

test("normalizeConfidenceThreshold supports percent-style inputs", () => {
  assert.equal(normalizeConfidenceThreshold(null), null);
  assert.equal(normalizeConfidenceThreshold(-10), 0);
  assert.equal(normalizeConfidenceThreshold(0.75), 0.75);
  assert.equal(normalizeConfidenceThreshold(75), 0.75);
  assert.equal(normalizeConfidenceThreshold(125), 1);
});

test("extractCitationUrls returns machine-readable deduped URLs", () => {
  const urls = extractCitationUrls(
    "Sources: https://a.example.com/x, https://b.example.com/y). Also https://a.example.com/x.",
  );
  assert.deepEqual(urls, [
    "https://a.example.com/x",
    "https://b.example.com/y",
  ]);
});

test("extractConfidenceScore normalizes percent confidence", () => {
  assert.equal(extractConfidenceScore("confidence: 82%"), 0.82);
  assert.equal(extractConfidenceScore("confidence score: 0.64"), 0.64);
});
