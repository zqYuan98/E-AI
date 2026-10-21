// Explicit, offline entry point. Does not inherit credentials, read .env, or start a real API/database.
// node apps/web/tests/check-isolated.ts <absolute source directory> [internal|public|both]
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedFixture } from "./isolated-fixture.ts";

const source = process.argv[2];
const mode = process.argv[3] ?? "both";
if (!source || !path.isAbsolute(source) || !["internal", "public", "both"].includes(mode)) throw new Error("absolute source and internal/public/both required");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"].includes(key.toUpperCase())));
const cli = fileURLToPath(new URL("./bin.cjs", import.meta.resolve("@react-router/dev/package.json")));
const tsc = fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json")));
const failures: Array<{ root: string; args: string[]; exit: number | null; error?: string }> = [];
function run(root: string, args: string[], web = true) {
  console.log(JSON.stringify({ cwd: web ? path.join(root, "apps/web") : root, command: [process.execPath, ...args] }));
  const result = spawnSync(process.execPath, args, { cwd: web ? path.join(root, "apps/web") : root, env, stdio: "inherit", timeout: 300_000 });
  if (result.error || result.status !== 0) failures.push({ root, args, exit: result.status, error: result.error?.message });
  return !result.error && result.status === 0;
}
for (const kind of mode === "both" ? ["internal", "public"] as const : [mode as "internal" | "public"]) {
  const root = isolatedFixture(source, kind);
  console.log(JSON.stringify({ fixture: root, mode: kind }));
  run(root, [cli, "typegen"]);
  if (kind === "internal") for (const dir of ["packages/contracts", "packages/backend", "apps/api", "apps/worker", "tests", "modules"]) {
    if (existsSync(path.join(root, dir, "tsconfig.json"))) run(root, [tsc, "-p", dir, "--pretty", "false"], false);
  }
  run(root, [tsc, "-p", ".", "--pretty", "false"]);
  const built = run(root, [cli, "build"]);
  // All pre-existing public tests run unchanged in a site that really has no access module.
  // The access suites exercise the installed module, not an auth-bypass test flag.
  const suites = readdirSync(path.join(root, "apps/web/tests")).filter(name => name.endsWith(".test.ts") && name.startsWith("access-") === (kind === "internal"));
  if (built) run(root, ["--test", "--test-concurrency=1", ...suites.map(name => `tests/${name}`), ...(kind === "public" ? ["../../tests/web-error-logging.standalone.test.ts", "../../tests/web-render-recovery.standalone.test.ts", "../../tests/page-metadata.standalone.test.ts", "../../tests/malformed-public-paths.standalone.test.ts", "../../tests/local-font.standalone.test.ts"] : [])]);
  else console.error(JSON.stringify({ notRun: suites, reason: "build failed", root }));
}

console.log(JSON.stringify({ failures }));
process.exitCode = failures.length ? 1 : 0;
