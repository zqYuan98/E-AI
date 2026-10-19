// Vite's browser runtime plus modules reached by browser import edges, not URL prefixes or extensions.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import type { EnvironmentModuleNode, ViteDevServer } from "vite";

const entries = new Set([
  "/@vite/client", "/@react-refresh", "/app/entry.client.tsx",
  "/@id/__x00__virtual:react-router/browser-manifest",
  "/@id/__x00__virtual:react-router/hmr-runtime",
  "/@id/__x00__virtual:react-router/inject-hmr-runtime",
]);

/** Document route modules are loaded by the router manifest, not by a JS import edge. */
export function devEntries(root: string, routes: readonly RouteConfigEntry[]): Set<string> {
  const urls = new Set(entries);
  // Vite serves its own client without import analysis, so this one runtime dependency has no graph edge.
  const env = fileURLToPath(new URL("./dist/client/env.mjs", import.meta.resolve("vite/package.json")));
  urls.add(path.posix.join("/@fs", env.split(path.sep).join("/")));
  function add(file: string) {
    const absolute = path.resolve(root, "app", file);
    const relative = path.relative(root, absolute);
    urls.add(!relative.startsWith("..") && !path.isAbsolute(relative)
      ? "/" + relative.split(path.sep).join("/")
      : path.posix.join("/@fs", absolute.split(path.sep).join("/")));
  }
  function walk(items: readonly RouteConfigEntry[]) {
    for (const item of items) { add(item.file); if (item.children) walk(item.children); }
  }
  add("root.tsx"); walk(routes);
  return urls;
}

export function devAsset(server: ViteDevServer, target: string, trusted = entries): boolean {
  const url = new URL(`http://dev.local${target}`);
  // Only Vite's version/timestamp queries. A known module with ?raw is not its browser transform.
  if ([...url.searchParams.keys()].some(key => key !== "v" && key !== "t" && key !== "import")) return false;
  if (trusted.has(url.pathname)) return true;
  const graph = server.environments.client?.moduleGraph;
  const module = graph?.urlToModuleMap.get(url.pathname + url.search) ?? graph?.urlToModuleMap.get(url.pathname);
  function reachable(node: EnvironmentModuleNode, seen: Set<EnvironmentModuleNode>): boolean {
    if (trusted.has(node.url)) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    return [...node.importers].some(parent => reachable(parent, seen));
  }
  if (!module?.file || module.file.includes(".server.") || module.file.replaceAll("\\", "/").includes("/public/")) return false;
  return reachable(module, new Set());
}
