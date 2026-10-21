// Runs the production web server (apps/web/server.ts, after `npm run build -w @aihot/web`) in front of
// a synthetic api, for tests that read pages over HTTP or in a browser; and that api with its reports.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { DataRouter } from "react-router";
import type { FeedItemSummary, SiteItemDetail } from "@aihot/contracts/site";

/** When the synthetic reports were published. */
export const FIXTURE_AT = "2026-10-04T08:00:00.000Z";

/** A report as list cards show it; the fields a test does not name are fixed. */
export function feedItem(fields: Partial<FeedItemSummary> & Pick<FeedItemSummary, "id" | "title">): FeedItemSummary {
  return {
    summary: "固定摘要", reason: "固定推荐理由", source: { name: "Fixture" }, publishedAt: FIXTURE_AT, timelineAt: FIXTURE_AT,
    category: "models", tags: [], score: 80, selected: true, channel: "news", x: null, ...fields,
  };
}

/** A report as its article page shows it; the fields a test does not name are fixed. */
export function itemDetail(fields: Partial<SiteItemDetail> & Pick<SiteItemDetail, "id" | "title">): SiteItemDetail {
  return {
    ...feedItem({ id: fields.id, title: fields.title }), x: null, originalTitle: null, links: { original: "https://example.org/article" },
    discoveredAt: FIXTURE_AT, story: null, readingMode: "full", author: null,
    body: { zh: "<p>固定正文</p>", original: null, zhKind: "translation", complete: true },
    outline: [], relatedStories: [], topics: [], indexable: true, markdownAvailable: true, group: null, hasTranslation: true, bodyLanguage: "zh",
    ...fields,
  };
}

/**
 * A synthetic api. `route` answers first: a value it returns is sent as JSON (with any status it set), and
 * a response it ends itself is left alone. What it leaves unanswered gets the reads every page makes (site
 * metadata, the analytics beacon, health), and anything else a 404.
 */
export function fakeApi(route: (url: URL, res: ServerResponse, req: IncomingMessage) => unknown = () => undefined): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    res.setHeader("Content-Type", "application/json");
    const body = await route(url, res, req);
    if (res.writableEnded) return;
    if (body !== undefined) return res.end(JSON.stringify(body));
    if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "fixture" }));
    if (url.pathname === "/api/site/track") { res.statusCode = 204; return res.end(); }
    if (url.pathname === "/api/health") return res.end("{}");
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "not_found" }));
  });
}

export interface WebServer {
  origin: string;
  port: number;
  /** What the server wrote to stderr so far: its error lines. */
  logs: () => string;
  /** Stops the web server and the api. */
  stop: () => Promise<void>;
}

/** Starts `api` and a web server that reads it. `env` adds to or overrides the web server's environment. */
export async function startWebServer(api: Server, env: NodeJS.ProcessEnv = {}, mode: "production" | "development" = "production"): Promise<WebServer> {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  // The production server listens on port 0 and reports the port it got (canonical addresses follow it).
  // The development server needs its port up front: one is reserved and released just before it starts.
  let port = 0;
  if (mode === "development") {
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
  let logs = "";
  const args = mode === "production" ? [fileURLToPath(new URL("../server.ts", import.meta.url))]
    : ["--conditions=development", fileURLToPath(new URL("./bin.cjs", import.meta.resolve("@react-router/dev/package.json"))), "dev", "--port", String(port), "--host", "127.0.0.1"];
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"].includes(key.toUpperCase())));
  const web = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...safeEnv, WEB_PORT: String(port), SITE_URL: `http://127.0.0.1:${port}`, TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (web.exitCode === null) {
      web.kill("SIGTERM");
      await once(web, "exit");
    }
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), mode === "development" ? 60_000 : 15_000);
      web.once("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
      web.stderr!.on("data", (chunk) => { logs += String(chunk); });
      const output = createInterface({ input: web.stdout! });
      output.on("line", (line) => {
        const started = line.startsWith("{") ? JSON.parse(line) as { msg?: string; port?: number } : null;
        if (started?.msg === "web started") port = started.port ?? port;
        else if (!(mode === "development" && line.includes("Local"))) return;
        clearTimeout(timeout); output.close(); web.stdout!.resume(); resolve();
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: `http://127.0.0.1:${port}`, port, logs: () => logs, stop };
}

/**
 * Opens `url` for a test that acts on the page; reading the server's HTML needs only `goto`. `goto` resolves
 * at the load event, but the client entry is imported after it and can run later: a press before hydration
 * reaches no handler, and going offline before then leaves the page without its client data. The router is
 * initialized once hydration has run each route's client loader on the HTML's own result.
 */
export async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (globalThis as { __reactRouterDataRouter?: DataRouter }).__reactRouterDataRouter?.state.initialized);
}
