import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const commit =
  process.env.HERMES_BUILD_COMMIT || git("rev-parse HEAD") || "unknown";
const ref =
  process.env.HERMES_BUILD_REF ||
  git("rev-parse --abbrev-ref HEAD") ||
  "unknown";

const info = {
  name: pkg.name,
  version: pkg.version,
  commit,
  ref,
  repository: "https://github.com/lkmotto/hermes-supervisor",
  builtAt: new Date().toISOString(),
};

writeFileSync(
  join(root, "build-info.json"),
  JSON.stringify(info, null, 2) + "\n",
);
console.error(
  `build-info: ${info.name}@${info.version} commit=${info.commit} ref=${info.ref}`,
);
