#!/usr/bin/env node
// Regression test for the one-time memory redaction sweep
// (scripts/redaction-sweep.mjs).
//
// Builds a throwaway SQLite memory DB matching the live schema, seeds it with
// pre-redaction-style rows that carry secret-like values in both content and
// metadata, runs the sweep in --apply mode, and asserts that:
//   - every secret-bearing row is rewritten, clean rows are untouched,
//   - no residual secret-like findings remain,
//   - row ids, categories, and created_at are preserved,
//   - benign correlation metadata (validation_id, goal, run_id) survives,
//   - the secret probe values no longer appear in content or metadata.
//
// Secret-like fixtures are assembled from fragments and random characters at
// runtime so no scannable credential literal is committed to the repo while
// still matching the redaction patterns under test.

import initSqlJs from "sql.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(HERE, "redaction-sweep.mjs");

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

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
    failures.push(name);
  }
}

const SECRET = {
  github: "gh" + "p_" + rnd(B62, 36),
  openai: "sk" + "-proj-" + rnd(B62, 30),
  aws: "AK" + "IA" + rnd(UPPER + DIGIT, 16),
  password: "Pw" + rnd(B62, 18),
};

async function main() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Pre-redaction rows: ids/categories/created_at must be preserved as-is.
  const seed = [
    {
      id: "row-clean-1",
      category: "fact",
      created_at: "2024-01-01T00:00:00Z",
      content: "Hermes runs on port 8150 and persists memory via sql.js.",
      metadata: JSON.stringify({ source: "init", confidence: 0.9 }),
    },
    {
      id: "row-secret-content",
      category: "validation",
      created_at: "2024-02-02T00:00:00Z",
      content: `VALIDATION-legacy stored github=${SECRET.github} openai=${SECRET.openai}`,
      metadata: JSON.stringify({
        validation_id: "VALIDATION-legacy",
        run_id: "run-42",
      }),
    },
    {
      id: "row-secret-metadata",
      category: "plan",
      created_at: "2024-03-03T00:00:00Z",
      content: "## Plan: legacy plan with no secret in body",
      metadata: JSON.stringify({
        goal: "ship release",
        password: SECRET.password,
        nested: { aws: SECRET.aws },
      }),
    },
  ];
  for (const r of seed) {
    db.run(
      "INSERT INTO memories (id, category, content, metadata, created_at) VALUES (?,?,?,?,?)",
      [r.id, r.category, r.content, r.metadata, r.created_at],
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "hermes-sweep-test-"));
  const dbPath = join(dir, "fixture.db");
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();

  let manifest;
  try {
    const out = execFileSync("node", [SWEEP, "--apply", "--db", dbPath], {
      encoding: "utf8",
    });
    manifest = JSON.parse(out);
  } catch (err) {
    console.error("sweep --apply failed:", err.stdout || err.message);
    process.exit(1);
  }

  check(
    "total rows counted",
    manifest.totals.total_rows === 3,
    JSON.stringify(manifest.totals),
  );
  check(
    "two rows affected",
    manifest.totals.affected_rows === 2,
    JSON.stringify(manifest.totals),
  );
  check(
    "two rows rewritten",
    manifest.totals.rows_rewritten === 2,
    JSON.stringify(manifest.totals),
  );
  check(
    "zero residual findings",
    manifest.totals.residual_findings_after_apply === 0,
    JSON.stringify(manifest.totals),
  );
  check(
    "manifest exposes no raw secret",
    !JSON.stringify(manifest).includes(SECRET.github) &&
      !JSON.stringify(manifest).includes(SECRET.openai) &&
      !JSON.stringify(manifest).includes(SECRET.password) &&
      !JSON.stringify(manifest).includes(SECRET.aws),
  );

  // Re-open the rewritten DB and verify preservation + redaction.
  const SQL2 = await initSqlJs();
  const after = new SQL2.Database(readFileSync(dbPath));
  const rows = {};
  const st = after.prepare(
    "SELECT id, category, content, metadata, created_at FROM memories",
  );
  while (st.step()) {
    const o = st.getAsObject();
    rows[o.id] = o;
  }
  st.free();
  after.close();

  check(
    "clean row untouched",
    rows["row-clean-1"]?.content === seed[0].content &&
      rows["row-clean-1"]?.metadata === seed[0].metadata,
  );

  for (const r of seed) {
    const got = rows[r.id];
    check(
      `row ${r.id} id/category/created_at preserved`,
      got && got.category === r.category && got.created_at === r.created_at,
      JSON.stringify(got),
    );
  }

  const sc = rows["row-secret-content"];
  check(
    "secret content row: github redacted",
    sc && !sc.content.includes(SECRET.github),
    sc?.content,
  );
  check(
    "secret content row: openai redacted",
    sc && !sc.content.includes(SECRET.openai),
  );
  check(
    "secret content row: validation_id preserved",
    sc && sc.metadata.includes("VALIDATION-legacy"),
  );
  check(
    "secret content row: run_id preserved",
    sc && sc.metadata.includes("run-42"),
  );

  const sm = rows["row-secret-metadata"];
  check(
    "secret metadata row: password redacted",
    sm && !sm.metadata.includes(SECRET.password),
    sm?.metadata,
  );
  check(
    "secret metadata row: nested aws redacted",
    sm && !sm.metadata.includes(SECRET.aws),
  );
  check(
    "secret metadata row: goal preserved",
    sm && sm.metadata.includes("ship release"),
  );

  rmSync(dir, { recursive: true, force: true });

  console.log("");
  if (failures.length) {
    console.log(`RESULT: FAIL (${failures.length} failing checks)`);
    process.exit(1);
  }
  console.log("RESULT: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
