import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViteDevServer, EnvironmentModuleNode } from "vite";
import { ACCESS } from "../app/lib/access.ts";
import { apiGet, loadOr404, cachedPage, edgeTtl } from "../app/lib/api.server.ts";
import { requireAccess, validAdmin, validPrincipal } from "../app/lib/access.server.ts";
import { createRenderErrorHandler } from "../app/lib/render-recovery.ts";
import { accessBootScript } from "../app/lib/access-browser.ts";
import { devAsset } from "../dev-assets.ts";
import { pageReuse, hasFreshPage } from "../app/lib/page-reuse.ts";
import { sessionCache } from "../app/lib/session-cache.ts";
import type { ClientLoaderFunctionArgs } from "react-router";

assert.ok(ACCESS, "Run in the isolated internal-site fixture");
const request = (cookie = "aihot_member=fixture") => new Request("http://web.local/policy.data?q=local&_routes=root", { headers: { cookie } });

test("SSR API cookies override differently-cased caller headers and never mix concurrent callers", async t => {
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const cookie = new Headers(init.headers).get("cookie");
    await new Promise(resolve => setTimeout(resolve, cookie?.endsWith("a") ? 15 : 1));
    assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "manual");
    return Response.json({ cookie });
  });
  const replies = await Promise.all(["a", "b", "a", "b"].map(cookie => apiGet("/api/site/example", { request: request(cookie), headers: { Cookie: "forged" } })));
  assert.deepEqual(replies, [{ cookie: "a" }, { cookie: "b" }, { cookie: "a" }, { cookie: "b" }]);
  assert.deepEqual(await apiGet("/api/site/example", { headers: { Cookie: "forged" } }), { cookie: null }, "legacy calls without Request are anonymous, never the previous reader");
});

test("401 from a loader is a document sign-in redirect with a safe non-data return; 403 is not swallowed", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 401 }));
  await assert.rejects(() => loadOr404("/api/site/example", { request: request() }), (error: unknown) => {
    assert.ok(error instanceof Response);
    assert.equal(error.status, 302);
    assert.equal(error.headers.get("Location"), "/login?returnTo=%2Fpolicy%3Fq%3Dlocal");
    assert.equal(error.headers.get("X-Remix-Reload-Document"), "true");
    assert.equal(error.headers.get("Cache-Control"), "private, no-store");
    return true;
  });
  fetch.mock.mockImplementation(async () => Response.json({}, { status: 403 }));
  await assert.rejects(() => loadOr404("/api/site/example", { request: request() }), (error: unknown) => {
    assert.equal((error as { init: { status: number } }).init.status, 403); return true;
  });
});

test("direct session contract and real administrator shape reject wrappers and development identities", async t => {
  const value = { id: "member:1", kind: "member", name: "成员甲", csrf: "fixture-token" };
  assert.ok(validPrincipal(value)); assert.equal(validPrincipal({ principal: value }), false);
  assert.equal(validPrincipal({ ...value, id: "admin:1" }), false);
  assert.equal(validAdmin({ name: "dev", csrf: "dev", dev: true }), false);
  t.mock.method(globalThis, "fetch", async () => Response.json(value));
  assert.deepEqual(await requireAccess(request()), value);
});

test("internal loaders and snapshot helpers never renew or retain public content", async () => {
  assert.equal(cachedPage(3600, { content: "internal" }).data.expiresAt, 0);
  assert.equal(edgeTtl(3600)["Cache-Control"], "private, no-store");
  const reuse = pageReuse(); let calls = 0;
  const args = { request: request(), serverLoader: async () => ({ expiresAt: Date.now() + 60_000, calls: ++calls }) } as unknown as ClientLoaderFunctionArgs;
  await reuse.clientLoader(args); await reuse.clientLoader(args);
  assert.equal(calls, 2); assert.equal(hasFreshPage(new URL(request().url)), false);
  const cache = sessionCache<{ savedAt: number; content: string }>("test", 3600);
  cache.set("page", { savedAt: Date.now(), content: "internal" });
  assert.equal(cache.peek("page"), null); assert.equal(cache.read("page"), null);
});

test("inline identity JSON cannot break out of a script", () => {
  const script = accessBootScript({ id: "</script><script>alert(1)</script>", csrf: "fixture" }, "/login", "/api/access/session");
  assert.doesNotMatch(script, /<\/script/i);
  assert.doesNotThrow(() => new Function(script));
});

test("dev resource permission requires a browser import chain, not merely a warm graph or prefix", () => {
  const node = (url: string, file: string | null, importers: EnvironmentModuleNode[] = []) => ({ url, file, importers: new Set(importers) }) as EnvironmentModuleNode;
  const entry = node("/app/entry.client.tsx", "/project/apps/web/app/entry.client.tsx");
  const imported = node("/app/safe.ts", "/project/apps/web/app/safe.ts", [entry]);
  const unknown = node("/app/unknown.ts", "/project/apps/web/app/unknown.ts");
  const serverOnly = node("/app/lib/api.server.ts", "/project/apps/web/app/lib/api.server.ts", [entry]);
  const publicFile = node("/public/private.js", "/project/site/public/private.js", [entry]);
  const graph = new Map([entry, imported, unknown, serverOnly, publicFile].map(value => [value.url, value]));
  const server = { environments: { client: { moduleGraph: { urlToModuleMap: graph } } } } as unknown as ViteDevServer;
  assert.ok(devAsset(server, "/app/safe.ts"));
  assert.ok(devAsset(server, "/app/safe.ts?t=123"));
  for (const target of ["/app/unknown.ts", "/app/safe.ts?raw", "/app/safe.ts?url", "/@fs/arbitrary.ts", "/@vite/client?raw", serverOnly.url, publicFile.url]) assert.equal(devAsset(server, target), false, target);
});

test("internal render errors never touch browser persistence or release-recovery fetches", async t => {
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => { throw new Error("recovery must not fetch"); });
  // There is deliberately no window/storage here: internal recovery exits before accessing either.
  await createRenderErrorHandler("fixture-release")(new Error("fixture-render"), { componentStack: "" });
});
