// Tool-risk policy and fail-closed mutation gating for Hermes.
//
// Every tool is classified into an auditable risk level. Mutating VPS tools
// fail closed unless the caller supplies explicit policy fields:
//   - confirm: required for any mutating tool
//   - approval: required for dangerous/global actions and non-Hermes project control
//   - validation_id + validation_evidence + approval: required for Hermes-scoped redeploy/restart

export type RiskLevel =
  | "read-only"
  | "low-impact-write"
  | "hermes-scoped-mutation"
  | "dangerous-global-mutation";

export interface RiskMetadata {
  level: RiskLevel;
  mutating: boolean;
  confirmation_required: boolean;
  approval_required: boolean;
  scope: "read" | "memory" | "hermes" | "global";
  summary: string;
}

export const HERMES_PROJECT = "hermes";

// Mutating tools that target a project; the field carrying the project name.
const PROJECT_FIELD: Record<string, string> = {
  vps_restart_project: "project",
  vps_stop_project: "project",
  vps_start_project: "project",
  vps_deploy: "name",
};

// Mutating tools that are always dangerous/global regardless of arguments.
const DANGEROUS_ALWAYS = new Set(["vps_restart", "vps_snapshot", "vps_stop_project"]);

// Project-targeted tools that may be Hermes-scoped when they target only "hermes".
const SCOPED_CAPABLE = new Set(["vps_restart_project", "vps_start_project", "vps_deploy"]);

export const RISK_METADATA: Record<string, RiskMetadata> = {
  research: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only Perplexity research; no state change.",
  },
  vps_info: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only Hostinger VPS info.",
  },
  vps_metrics: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only VPS metrics.",
  },
  vps_projects: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only list of Docker Compose projects.",
  },
  vps_project_logs: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only project logs.",
  },
  memory_recall: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only memory recall.",
  },
  memory_store: {
    level: "low-impact-write", mutating: false, confirmation_required: false, approval_required: false,
    scope: "memory", summary: "Low-impact write to Hermes memory; no infrastructure change.",
  },
  plan: {
    level: "low-impact-write", mutating: false, confirmation_required: false, approval_required: false,
    scope: "memory", summary: "Generates a plan and stores it in Hermes memory; no infrastructure change.",
  },
  business_management_cycle: {
    level: "low-impact-write", mutating: false, confirmation_required: false, approval_required: false,
    scope: "memory", summary: "Writes structured fleet run/events/artifacts and heartbeats for Hermes business-management cycles.",
  },
  fleet_get_run_details: {
    level: "read-only", mutating: false, confirmation_required: false, approval_required: false,
    scope: "read", summary: "Read-only retrieval of fleet run details and artifact contents.",
  },
  vps_restart_project: {
    level: "hermes-scoped-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "hermes", summary: "Restarts a Docker project. Hermes-scoped when project=hermes (requires validation + approval); any other project is dangerous/global and requires explicit approval.",
  },
  vps_start_project: {
    level: "hermes-scoped-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "hermes", summary: "Starts a Docker project. Hermes-scoped when project=hermes (requires validation + approval); any other project is dangerous/global and requires explicit approval.",
  },
  vps_deploy: {
    level: "hermes-scoped-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "hermes", summary: "Deploys/redeploys a Docker project. Hermes-scoped when name=hermes (requires validation + approval); any other project is dangerous/global and requires explicit approval.",
  },
  vps_stop_project: {
    level: "dangerous-global-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "global", summary: "Stops a Docker project. Dangerous/global; requires confirmation and explicit approval.",
  },
  vps_snapshot: {
    level: "dangerous-global-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "global", summary: "Creates a VPS snapshot, overwriting any existing snapshot. Dangerous/global; requires confirmation and explicit approval.",
  },
  vps_restart: {
    level: "dangerous-global-mutation", mutating: true, confirmation_required: true, approval_required: true,
    scope: "global", summary: "Full VPS restart. Dangerous/global; requires confirmation and explicit approval.",
  },
};

export interface PolicyDenial {
  status: "denied";
  reason: "confirmation_required" | "approval_required" | "validation_required";
  risk_level: RiskLevel;
  tool: string;
  required_fields: string[];
  message: string;
}

export interface PolicyResult {
  allowed: boolean;
  effective_level: RiskLevel;
  scope_decision: "read" | "memory" | "hermes-scoped" | "non-hermes-global" | "global";
  denial?: PolicyDenial;
}

export interface PolicyContext {
  buildCommit: string;
}

type Args = Record<string, unknown>;

function projectCandidates(args: Args): string[] {
  const out: string[] = [];
  for (const key of ["project", "projects", "name", "names", "target", "targets"]) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string") out.push(item);
    } else if (typeof v === "string") {
      out.push(v);
    }
  }
  return out;
}

function targetsOnlyHermes(args: Args): boolean {
  const candidates = projectCandidates(args);
  if (candidates.length === 0) return false;
  return candidates.every((c) => c === HERMES_PROJECT);
}

function approvalProvided(args: Args): boolean {
  const a = args.approval;
  if (typeof a === "string") return a.trim().length > 0;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    return Boolean(o.approved_by || o.approver || o.token || o.reason || o.policy);
  }
  return false;
}

function validationIdProvided(args: Args): boolean {
  return typeof args.validation_id === "string" && args.validation_id.trim().length > 0;
}

function validationEvidenceValid(args: Args, buildCommit: string): boolean {
  const ev = args.validation_evidence;
  if (!ev || typeof ev !== "object") return false;
  const o = ev as Record<string, unknown>;
  if (o.build_passed !== true) return false;
  if (typeof o.commit !== "string" || o.commit.trim().length < 7) return false;
  const commit = o.commit.trim();
  // "current" evidence: the validated commit must match the deployed build commit
  // (allow short/long hash via prefix comparison).
  if (buildCommit && buildCommit !== "unknown") {
    return buildCommit.startsWith(commit) || commit.startsWith(buildCommit) || commit === buildCommit;
  }
  // No build commit available to compare against: accept a well-formed evidence object.
  return true;
}

function deny(
  tool: string,
  reason: PolicyDenial["reason"],
  risk_level: RiskLevel,
  required_fields: string[],
  message: string,
): PolicyResult {
  return {
    allowed: false,
    effective_level: risk_level,
    scope_decision: risk_level === "dangerous-global-mutation" ? "global" : "hermes-scoped",
    denial: { status: "denied", reason, risk_level, tool, required_fields, message },
  };
}

export function evaluateToolPolicy(toolName: string, rawArgs: unknown, ctx: PolicyContext): PolicyResult {
  const args: Args = (rawArgs && typeof rawArgs === "object") ? (rawArgs as Args) : {};
  const meta = RISK_METADATA[toolName];

  if (!meta || !meta.mutating) {
    const level = meta?.level ?? "read-only";
    return {
      allowed: true,
      effective_level: level,
      scope_decision: level === "low-impact-write" ? "memory" : "read",
    };
  }

  // Fail closed: every mutating tool requires explicit confirmation.
  if (args.confirm !== true) {
    return deny(
      toolName,
      "confirmation_required",
      meta.level,
      ["confirm=true", ...mutationFieldHints(toolName)],
      "Mutating VPS tool blocked: confirmation is required. Resend with confirm=true and the required policy fields. No state was changed.",
    );
  }

  // Always-dangerous global actions require explicit approval.
  if (DANGEROUS_ALWAYS.has(toolName)) {
    if (!approvalProvided(args)) {
      return deny(
        toolName,
        "approval_required",
        "dangerous-global-mutation",
        ["confirm=true", "approval"],
        "Dangerous/global VPS action blocked: explicit approval is required. No state was changed.",
      );
    }
    return { allowed: true, effective_level: "dangerous-global-mutation", scope_decision: "global" };
  }

  // Project-targeted scoped-capable tools.
  if (SCOPED_CAPABLE.has(toolName)) {
    const onlyHermes = targetsOnlyHermes(args);
    if (!onlyHermes) {
      // Non-Hermes project control is dangerous/global.
      if (!approvalProvided(args)) {
        return deny(
          toolName,
          "approval_required",
          "dangerous-global-mutation",
          ["confirm=true", `${PROJECT_FIELD[toolName]}="hermes" for scoped automation`, "approval"],
          "Non-Hermes project control is a dangerous/global action and requires explicit approval. No state was changed.",
        );
      }
      return { allowed: true, effective_level: "dangerous-global-mutation", scope_decision: "non-hermes-global" };
    }

    // Hermes-scoped redeploy/restart policy.
    const missing: string[] = [];
    let sawValidationGap = false;
    if (!validationIdProvided(args)) {
      missing.push("validation_id");
      sawValidationGap = true;
    }
    if (!validationEvidenceValid(args, ctx.buildCommit)) {
      missing.push("validation_evidence{commit (matching deployed commit), build_passed:true}");
      sawValidationGap = true;
    }
    if (!approvalProvided(args)) {
      missing.push("approval");
    }
    if (missing.length > 0) {
      return deny(
        toolName,
        sawValidationGap ? "validation_required" : "approval_required",
        "hermes-scoped-mutation",
        ["confirm=true", `${PROJECT_FIELD[toolName]}="hermes"`, ...missing],
        "Hermes-scoped redeploy/restart blocked: requires project=hermes, current source validation evidence, and approval provenance. No state was changed.",
      );
    }
    return { allowed: true, effective_level: "hermes-scoped-mutation", scope_decision: "hermes-scoped" };
  }

  // Defensive default for any other mutating tool: require approval.
  if (!approvalProvided(args)) {
    return deny(
      toolName,
      "approval_required",
      meta.level,
      ["confirm=true", "approval"],
      "Mutating tool blocked: explicit approval is required. No state was changed.",
    );
  }
  return { allowed: true, effective_level: meta.level, scope_decision: "global" };
}

function mutationFieldHints(toolName: string): string[] {
  if (DANGEROUS_ALWAYS.has(toolName)) return ["approval"];
  if (SCOPED_CAPABLE.has(toolName)) {
    return [`${PROJECT_FIELD[toolName]}="hermes"`, "validation_id", "validation_evidence{commit,build_passed:true}", "approval"];
  }
  return ["approval"];
}
