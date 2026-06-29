#!/usr/bin/env node
// Regression validator for Hermes memory/plan secret redaction.
//
// Source-level checks (always run) prove that the persistence-layer redaction
// helpers strip secret-like values from content and metadata while preserving
// benign data such as commit hashes.
//
// Live checks (run when HERMES_BASE_URL is set) drive the real MCP HTTP surface
// to prove memory_store, memory_recall, and plan still work and that injected
// secret-like validation strings are never recallable in raw form.
//
// The secret-like fixtures are assembled from fragments and random characters
// at runtime so no scannable credential literal is committed to the repo while
// the values still match the redaction patterns under test.
//
// Usage:
//   node scripts/secret-redaction-regression.mjs
//   HERMES_BASE_URL=http://127.0.0.1:8150 node scripts/secret-redaction-regression.mjs

import { redactSecrets, redactMetadata } from "../dist/redact.js";

const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
    failures.push(name);
  }
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const B62 = LOWER + UPPER + DIGIT;
function rnd(alphabet, n) {
  let s = "";
  for (let i = 0; i < n; i++)
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

const VID = `VALIDATION-redaction-${Date.now()}`;
const urlPw = "Sx" + rnd(B62, 12);

// name -> { value (injected), probe (must NOT appear raw after redaction) }.
const FIX = {
  aws: { value: "AK" + "IA" + rnd(UPPER + DIGIT, 16) },
  openai: { value: "sk" + "-proj-" + rnd(B62, 30) },
  github: { value: "gh" + "p_" + rnd(B62, 36) },
  githubPat: { value: "github" + "_pat_" + rnd(B62 + "_", 52) },
  slack: { value: "xo" + "xb-" + rnd(DIGIT, 12) + "-" + rnd(LOWER, 16) },
  google: { value: "AI" + "za" + rnd(B62 + "_-", 35) },
  bearerUrl: { value: `https://user:${urlPw}@example.com/path`, probe: urlPw },
  password: { value: "Pw" + rnd(B62, 18) },
};
for (const f of Object.values(FIX)) if (!f.probe) f.probe = f.value;

console.log("== Source-level redaction checks ==");

for (const [name, f] of Object.entries(FIX)) {
  const redacted = redactSecrets(`leaked ${name}: ${f.value}`);
  check(
    `content redaction hides ${name}`,
    !redacted.includes(f.probe),
    redacted,
  );
}

// Metadata redaction (recursive + key-aware) strips secret-like values.
const meta = redactMetadata({
  goal: "ship feature",
  password: FIX.password.value,
  nested: { api_key: FIX.openai.value, token: FIX.github.value },
  list: [`bearer ${FIX.aws.value}`],
});
const metaStr = JSON.stringify(meta);
check(
  "metadata hides password",
  !metaStr.includes(FIX.password.probe),
  metaStr,
);
check(
  "metadata hides nested api_key",
  !metaStr.includes(FIX.openai.probe),
  metaStr,
);
check(
  "metadata hides nested token",
  !metaStr.includes(FIX.github.probe),
  metaStr,
);
check("metadata hides aws in list", !metaStr.includes(FIX.aws.probe), metaStr);

// Benign values must be preserved (no over-redaction of traceability data).
const commit = "8956a835f75ca6907703493c18577e21dbb5fc33";
check(
  "commit hash preserved",
  redactSecrets(`deployed commit ${commit}`).includes(commit),
);
check(
  "plain prose preserved",
  redactSecrets("perceive plan propose learn cycle").includes(
    "perceive plan propose learn",
  ),
);

// ── Live MCP checks ────────────────────────────────────────────────
const BASE = process.env.HERMES_BASE_URL;
if (!BASE) {
  console.log("\n(Skipping live MCP checks: set HERMES_BASE_URL to enable.)");
  finish();
}

console.log(`\n== Live MCP checks against ${BASE} ==`);

async function rpc(method, params) {
  const res = await fetch(`${BASE.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = line ? line.slice(5).trim() : text.trim();
  return JSON.parse(payload);
}

function toolText(rpcResult) {
  const c = rpcResult?.result?.content;
  if (Array.isArray(c)) return c.map((x) => x.text ?? "").join("\n");
  return JSON.stringify(rpcResult);
}

function assertNoRawSecrets(label, haystack) {
  for (const [name, f] of Object.entries(FIX)) {
    check(`${label}: no raw ${name}`, !haystack.includes(f.probe));
  }
}

async function live() {
  const storeContent = `${VID} stored creds aws=${FIX.aws.value} openai=${FIX.openai.value} ${FIX.bearerUrl.value}`;
  const storeRes = await rpc("tools/call", {
    name: "memory_store",
    arguments: {
      category: "validation",
      content: storeContent,
      metadata: {
        validation_id: VID,
        password: FIX.password.value,
        token: FIX.github.value,
        slack: FIX.slack.value,
      },
    },
  });
  const storeText = toolText(storeRes);
  check(
    "memory_store succeeds",
    !storeRes.error && /Memory stored \[/.test(storeText),
    storeText,
  );

  const recallRes = await rpc("tools/call", {
    name: "memory_recall",
    arguments: { category: "validation", query: VID, limit: 5 },
  });
  const recallText = toolText(recallRes);
  check(
    "memory_recall returns the stored record",
    recallText.includes(VID),
    recallText.slice(0, 400),
  );
  assertNoRawSecrets("memory_recall", recallText);

  const planGoal = `${VID} validation plan (do not leak ${FIX.openai.value})`;
  const planRes = await rpc("tools/call", {
    name: "plan",
    arguments: {
      goal: planGoal,
      context: `password=${FIX.password.value} github=${FIX.githubPat.value}`,
    },
  });
  const planText = toolText(planRes);
  check(
    "plan returns substantive output",
    !planRes.error && planText.length > 80,
    planText.slice(0, 200),
  );
  assertNoRawSecrets("plan output", planText);

  const planRecall = await rpc("tools/call", {
    name: "memory_recall",
    arguments: { category: "plan", query: VID, limit: 5 },
  });
  const planRecallText = toolText(planRecall);
  check(
    "plan is recallable by validation ID",
    planRecallText.includes(VID),
    planRecallText.slice(0, 300),
  );
  assertNoRawSecrets("plan recall", planRecallText);

  finish();
}

live().catch((err) => {
  console.error("Live check error:", err);
  process.exit(1);
});

function finish() {
  console.log("");
  if (failures.length) {
    console.log(`RESULT: FAIL (${failures.length} failing checks)`);
    process.exit(1);
  }
  console.log("RESULT: PASS");
  process.exit(0);
}
