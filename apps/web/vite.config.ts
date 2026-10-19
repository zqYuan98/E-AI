import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { isApiOwned, resolveRedirect } from "@aihot/contracts/http-policy";
import { pageTarget } from "@aihot/contracts/access";
import { accessAssets } from "./build-assets.ts";
import { devAsset, devEntries } from "./dev-assets.ts";
import routes from "./app/routes.ts";
import { ACCESS } from "./app/lib/access.ts";
import { guardPage, privateResponse, rejectPage } from "./access-edge.server.ts";
import { proxyToApi } from "./app/lib/api-proxy.server.ts";

/** Development stand-in for the production web server: the shared redirect table and api-owned path routing. */
function devEdge(): Plugin {
  return {
    name: "aihot-dev-edge",
    configureServer(server) {
      const entries = devEntries(server.config.root, routes);
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const target = pageTarget(req.url ?? "/", req.headers.host);
          const resource = !!target && !target.data && (req.method === "GET" || req.method === "HEAD") && devAsset(server, req.url!, entries);
          if (ACCESS) {
            privateResponse(res);
            delete req.headers["if-none-match"];
            delete req.headers["if-modified-since"];
          }
          if (!target) return rejectPage(req, res, 400);
          if (!target.data && isApiOwned(target.path)) {
            return proxyToApi(req, res);
          }
          if (resource) return next();
          if (await guardPage(req, res, target)) return;
          const decision = resolveRedirect(target.path, new URL(`http://dev.local${target.href}`).search);
          if (decision) {
            for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
            if (decision.location) res.setHeader("Location", decision.location);
            res.statusCode = decision.status;
            return res.end();
          }
          next();
        })().catch(() => { if (!res.headersSent) rejectPage(req, res, 503); else res.destroy(); });
      });
    },
  };
}

export default defineConfig({
  // Environment is supplied by the process; do not read secrets while typegen/build runs.
  envDir: false,
  plugins: [devEdge(), accessAssets(), tailwindcss(), reactRouter()],
  // The modules' pages import the engine's web code by this name (tsconfig.json paths).
  resolve: { alias: { "@aihot/web/": `${path.resolve(import.meta.dirname, "app")}/` } },
  server: { port: 3000, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // Keep the framework stable across releases and reused shell/feed code in one browser cache
        // entry, including the site and industry packages. Page-specific code still splits by route;
        // report, agent and admin features stay with their pages instead of enlarging every document.
        codeSplitting: {
          groups: [
            { name: "framework", test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|@react-router|cookie|set-cookie-parser|turbo-stream)[\\/]/, priority: 30 },
            { name: "motion", test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            { name: "shared", test: /apps[\\/]web[\\/]app[\\/](?!features[\\/](?:admin|agent|report)[\\/]|routes[\\/])|[\\/](?:industry|site)[\\/]/, minShareCount: 2, priority: 10 },
          ],
        },
      },
    },
  },
});
