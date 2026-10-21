// Prepare a disposable source tree, never an .env or a live backend. Build/test commands run there.
// Dependencies are reused locally; workspace packages always resolve to the copied sources.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isolatedFixture(source: string, mode: "internal" | "public") {
  const root = mkdtempSync(path.join(tmpdir(), `powerai-m1-${mode}-`));
  const excluded = new Set([".git", ".data", ".claude", "node_modules", "build", ".react-router", ".vite"]);
  const filter = (file: string) => !excluded.has(path.basename(file)) && !path.basename(file).startsWith(".env");
  for (const entry of ["apps", "packages", "modules", "industry", "site", "tests", "scripts", "assets", "package.json", "package-lock.json", "tsconfig.base.json"]) {
    cpSync(path.join(source, entry), path.join(root, entry), { recursive: true, filter });
  }
  const dependencies = path.join(root, "node_modules");
  mkdirSync(dependencies);
  const link = (from: string, to: string) => symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  for (const entry of readdirSync(path.join(source, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "@aihot" || entry.name.startsWith(".")) continue;
    link(path.join(source, "node_modules", entry.name), path.join(dependencies, entry.name));
  }
  mkdirSync(path.join(dependencies, "@aihot"));
  const workspaces = ["site", "industry", ...["apps", "packages", "modules"].flatMap(dir => readdirSync(path.join(root, dir)).map(name => `${dir}/${name}`))];
  for (const workspace of workspaces) {
    const folder = path.join(root, workspace);
    if (!existsSync(path.join(folder, "package.json"))) continue;
    const { name } = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
    link(folder, path.join(dependencies, ...name.split("/")));
    // A workspace's own versions (the backend's undici) differ from the hoisted ones.
    const nested = path.join(source, workspace, "node_modules");
    if (existsSync(nested)) link(nested, path.join(folder, "node_modules"));
  }
  if (mode === "public") {
    // The public-site fixture really uninstalls the access module, rather than bypassing auth in runtime code.
    for (const file of ["index.ts", "server.ts", "web.ts"]) {
      const target = path.join(root, "site/modules", file);
      const text = readFileSync(target, "utf8").split("\n").filter(line => !line.includes('from "@aihot/access/')).join("\n")
        .replace("[access, ", "[").replace("[accessWeb, ", "[");
      writeFileSync(target, text);
    }
  }
  return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[3];
  if (!process.argv[2] || (mode !== "internal" && mode !== "public")) throw new Error("source and internal/public mode required");
  console.log(isolatedFixture(path.resolve(process.argv[2]), mode));
}
