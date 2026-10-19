import assert from "node:assert/strict";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/auth/options") return res.end(JSON.stringify({ password: true, feishu: false }));
  if (req.headers.cookie?.includes("aihot_member=dev-fixture")) {
    if (req.url === "/api/access/session") return res.end(JSON.stringify({ id: "member:1", kind: "member", name: "开发测试成员", csrf: "fixture" }));
    if (req.url === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
    if (req.url?.startsWith("/api/site/timeline")) return res.end(JSON.stringify({ cards: [], filters: { category: null, channel: "all", tag: null }, dayCounts: {}, nextCursor: null, hot: null }));
  }
  res.statusCode = 401; res.end("{}");
});
before(async () => {
  const results = await Promise.allSettled([
    startWebServer(api, {}, "development").then(value => { web = value; }),
    chromium.launch({ channel: "chromium" }).then(value => { browser = value; }),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
after(async () => { await browser?.close(); await web?.stop(); });

test("Vite guards unknown files, data, prefixes and conditional requests before transformation", async () => {
  for (const path of ["/", "/unknown", "/app/root.tsx?raw", "/@fs/private.ts", "/__unknown", "/assets/private.js", "/policy.data?_routes=root", "/admin/access.data"]) {
    const response = await fetch(web.origin + path, { redirect: "manual", headers: { "If-None-Match": "*" } });
    assert.equal(response.status, path.includes(".data") ? 204 : 302, path);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(await response.text(), "");
  }
});

test("Vite login and signed-in documents hydrate using only graph-proven browser resources", async () => {
  const context = await browser.newContext();
  const failures: string[] = [];
  try {
    await context.route("**/*", route => new URL(route.request().url()).origin === web.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on("pageerror", error => failures.push(error.message));
    page.on("response", response => { if (response.request().resourceType() === "script" && response.status() !== 200 && response.status() !== 304) failures.push(`${response.status()} ${response.url()}`); });
    await page.goto(web.origin + "/login");
    await expect(page.getByText("登录工作空间", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __reactRouterDataRouter?: { state?: { initialized: boolean } } }).__reactRouterDataRouter?.state?.initialized)).toBe(true);
    assert.deepEqual(failures, []);
    await context.addCookies([{ name: "aihot_member", value: "dev-fixture", url: web.origin, httpOnly: true }]);
    await page.goto(web.origin + "/");
    await expect(page.getByRole("region", { name: "当前成员" })).toContainText("开发测试成员");
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { __reactRouterDataRouter?: { state?: { initialized: boolean } } }).__reactRouterDataRouter?.state?.initialized)).toBe(true);
    assert.deepEqual(failures, []);
    await context.clearCookies();
    const response = await context.request.get(web.origin + "/app/lib/api.server.ts", { maxRedirects: 0 });
    assert.equal(response.status(), 302);
  } catch (error) {
    throw new Error(`Development hydration failed: ${JSON.stringify(failures)}; ${web.logs()}`, { cause: error });
  } finally { await context.close(); }
});
