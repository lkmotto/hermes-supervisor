#!/usr/bin/env node
// One-time safe redaction sweep for Hermes memory rows written before
// at-rest redaction existed. Reuses the SAME persistence-layer redaction
// helpers (redactSecrets / redactMetadata) the live server applies on write,
// so swept rows match what a fresh memory_store/plan would have produced.
//
// Safety guarantees:
//   - Never prints raw content, metadata, or secret values. Output is a
//     non-secret manifest: counts, checksums, and [REDACTED:*] evidence tags.
//   - Preserves row id, category, created_at, and all non-secret metadata
//     (validation IDs, goals, run/correlation references).
//   - Only rewrites rows whose content or metadata actually changes under
//     redaction. Untouched columns are written back byte-for-byte.
//
// Modes:
//   --scan          report only; makes no changes (default)
//   --apply         rewrite affected rows in place
//
// Options:
//   --db <path>     SQLite DB path (default: $HERMES_DB_PATH or ./hermes.db)
//   --manifest <p>  write the JSON manifest to this path as well as stdout
//
// Run under the same secret environment as the server (e.g. via
// `doppler run -- node scripts/redaction-sweep.mjs ...`) so env-sourced
// secret values are redacted identically to live writes.

import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { redactSecrets, redactMetadata } from "../dist/redact.js";

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const APPLY = process.argv.includes("--apply");
const DB_PATH = arg("--db", process.env.HERMES_DB_PATH ?? "./hermes.db");
const MANIFEST_PATH = arg("--manifest");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Extract only the non-secret [REDACTED:*] / [REDACTED] evidence markers.
function redactionTags(...texts) {
  const tags = new Set();
  for (const t of texts) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(/\[REDACTED(?::[a-z0-9-]+|:[A-Z0-9_]+)?\]/g)) {
      tags.add(m[0]);
    }
  }
  return [...tags].sort();
}

// Compute the safe (redacted) content/metadata for a row and whether each
// column changed, isolating redaction changes from incidental JSON formatting.
function evaluateRow(content, metadata) {
  const safeContent = redactSecrets(content ?? "");
  const contentChanged = safeContent !== (content ?? "");

  let safeMetadata = metadata ?? "{}";
  let metadataChanged = false;
  if (metadata && metadata.length > 0) {
    try {
      const parsed = JSON.parse(metadata);
      const canonical = JSON.stringify(parsed);
      const redacted = JSON.stringify(redactMetadata(parsed));
      if (redacted !== canonical) {
        safeMetadata = redacted;
        metadataChanged = true;
      }
    } catch {
      // Metadata is not valid JSON; fall back to string-level redaction.
      const redacted = redactSecrets(metadata);
      if (redacted !== metadata) {
        safeMetadata = redacted;
        metadataChanged = true;
      }
    }
  }

  return { safeContent, contentChanged, safeMetadata, metadataChanged };
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`ERROR: DB not found at ${DB_PATH}`);
    process.exit(2);
  }

  const fileBefore = readFileSync(DB_PATH);
  const SQL = await initSqlJs();
  const db = new SQL.Database(fileBefore);

  const rows = [];
  const stmt = db.prepare("SELECT id, category, content, metadata, created_at FROM memories ORDER BY created_at ASC");
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const byCategory = {};
  const affected = [];
  const allTags = new Set();

  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    const { safeContent, contentChanged, safeMetadata, metadataChanged } = evaluateRow(row.content, row.metadata);
    if (contentChanged || metadataChanged) {
      const tags = redactionTags(
        contentChanged ? safeContent : "",
        metadataChanged ? safeMetadata : "",
      );
      tags.forEach((t) => allTags.add(t));
      affected.push({
        id: row.id,
        category: row.category,
        created_at: row.created_at,
        content_changed: contentChanged,
        metadata_changed: metadataChanged,
        redaction_tags: tags,
        _safeContent: safeContent,
        _safeMetadata: safeMetadata,
      });
    }
  }

  let applied = 0;
  if (APPLY && affected.length > 0) {
    db.run("BEGIN");
    for (const a of affected) {
      const set = [];
      const params = [];
      if (a.content_changed) { set.push("content = ?"); params.push(a._safeContent); }
      if (a.metadata_changed) { set.push("metadata = ?"); params.push(a._safeMetadata); }
      params.push(a.id);
      db.run(`UPDATE memories SET ${set.join(", ")} WHERE id = ?`, params);
      applied++;
    }
    db.run("COMMIT");
    const out = Buffer.from(db.export());
    writeFileSync(DB_PATH, out);
  }

  // Re-scan in-memory state to confirm zero residual findings after apply.
  let residual = 0;
  if (APPLY) {
    const r2 = db.prepare("SELECT content, metadata FROM memories");
    while (r2.step()) {
      const o = r2.getAsObject();
      const ev = evaluateRow(o.content, o.metadata);
      if (ev.contentChanged || ev.metadataChanged) residual++;
    }
    r2.free();
  }

  db.close();
  const fileAfter = existsSync(DB_PATH) ? readFileSync(DB_PATH) : fileBefore;

  const manifest = {
    sweep: {
      mode: APPLY ? "apply" : "scan",
      db_path: DB_PATH,
      timestamp: new Date().toISOString(),
    },
    totals: {
      total_rows: rows.length,
      by_category: byCategory,
      affected_rows: affected.length,
      rows_rewritten: applied,
      residual_findings_after_apply: APPLY ? residual : null,
    },
    redaction_tags_seen: [...allTags].sort(),
    affected: affected.map((a) => ({
      id: a.id,
      category: a.category,
      created_at: a.created_at,
      content_changed: a.content_changed,
      metadata_changed: a.metadata_changed,
      redaction_tags: a.redaction_tags,
    })),
    checksums: {
      db_sha256_before: sha256(fileBefore),
      db_sha256_after: sha256(fileAfter),
      db_bytes_before: fileBefore.length,
      db_bytes_after: fileAfter.length,
    },
  };

  const json = JSON.stringify(manifest, null, 2);
  console.log(json);
  if (MANIFEST_PATH) writeFileSync(MANIFEST_PATH, json);

  if (APPLY && residual > 0) {
    console.error(`ERROR: ${residual} rows still contain secret-like values after sweep.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Sweep error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
