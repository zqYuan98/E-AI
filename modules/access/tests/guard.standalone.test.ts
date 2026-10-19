// Run through tests/standalone.ts: the database is deliberately unreachable, never a business database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../../../apps/api/src/app.ts";
import { access } from "../server.ts";

process.env.SESSION_SECRET = "test-only-guard-session-secret";
config.siteUrl = "https://inside.invalid";
config.devAdmin = { displayName: "Must not authenticate" };
config.environmentName = "development";
let reached = 0;
installModules([access, { name: "access-probe", httpBefore: (app) => {
  app.addHook("onRequest", async () => { reached++; });
} }]);
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); installModules([]); });

const privateHeaders = (headers: Record<string, unknown>) => {
  assert.equal(headers["cache-control"], "private, no-store");
  assert.equal(headers["x-accel-expires"], "0");
};

test("anonymous GET and HEAD are denied before all readers, aliases, ETags and media queues", async () => {
  const paths = [
    "/api/access/session", "/api/admin/me", "/api/admin/access/members", "/api/auth/check",
    "/api/site/home", "/api/v1/items", "/api/v1/unknown", "/feed.xml", "/feed/all.xml", "/feed", "/rss", "/about/",
    "/api/mcp", "/og/site.png", "/og/items/example.png", "/api/img-proxy?url=https://example.invalid/a.jpg",
    "/openapi-v1.json", "/sitemap.xml", "/llms.txt", "/robots.txt", "/manifest.webmanifest", "/contact/test.png",
    "/items/test/markdown", "/.well-known/oauth-authorization-server", "/unknown", "/api/health/", "/api/health/more",
    "/api/auth/options/more", "/favicon.ico/more", "/api/%61dmin/me", "/api/access/login/extra",
  ];
  const before = reached;
  for (const method of ["GET", "HEAD"] as const) for (const url of paths) {
    const response = await app.inject({ method, url, headers: {
      "if-none-match": "*", "x-aihot-ssr": "1", "x-forwarded-for": "127.0.0.1", "x-forwarded-user": "admin",
      "x-forwarded-host": "inside.invalid", cookie: "aihot_member=%; unrelated=%",
    } });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
    assert.equal(response.headers.location, undefined);
    privateHeaders(response.headers);
    if (method === "HEAD") assert.equal(response.body, "", `HEAD body ${url}`);
  }
  assert.equal(reached, before, "none of the downstream hooks or business routes ran");
});

test("unknown and write routes are not anonymous even with bearer or development identity", async () => {
  for (const url of ["/api/mcp", "/api/ingest/items", "/api/access/logout", "/api/auth/logout", "/api/health", "/api/admin/access/members", "/api/access/login/extra"]) {
    const response = await app.inject({ method: "POST", url, headers: { authorization: "Bearer forged", "x-csrf-token": "dev", "x-aihot-ssr": "true" }, payload: {} });
    assert.equal(response.statusCode, 401, url);
    privateHeaders(response.headers);
  }
  const preflight = await app.inject({ method: "OPTIONS", url: "/api/mcp" });
  assert.equal(preflight.statusCode, 401);
});

test("anonymous health is minimal and never reaches the database; only explicit login routes are open", async () => {
  const before = reached;
  const health = await app.inject({ url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });
  privateHeaders(health.headers);
  assert.equal(reached, before);
  const head = await app.inject({ method: "HEAD", url: "/api/health" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal((await app.inject({ url: "/api/auth/options" })).statusCode, 200);
  const callback = await app.inject({ url: "/api/auth/callback?state=invalid" });
  assert.equal(callback.statusCode, 403);
  assert.match(callback.body, /登录状态已失效/);
  privateHeaders(callback.headers);
});

test("login requires Origin, bounds bodies and limits each visitor the web server names", async () => {
  for (const url of ["/api/access/login", "/api/auth/password"]) for (const origin of [undefined, "null", "https://outside.invalid"]) {
    const response = await app.inject({ method: "POST", url, headers: origin ? { origin } : {}, payload: { username: "somebody", password: "short" } });
    assert.equal(response.statusCode, 403);
    privateHeaders(response.headers);
  }
  const tooLarge = await app.inject({ method: "POST", url: "/api/access/login", remoteAddress: "127.0.0.2", headers: { origin: config.siteUrl }, payload: { password: "x".repeat(9000) } });
  assert.equal(tooLarge.statusCode, 413);
  privateHeaders(tooLarge.headers);
  const broken = await app.inject({ method: "POST", url: "/api/access/login", remoteAddress: "127.0.0.3", headers: { origin: config.siteUrl, "content-type": "application/json" }, payload: "{" });
  assert.equal(broken.statusCode, 400);
  privateHeaders(broken.headers);
  // Every sign-in reaches the api from the web container; the web server writes the visitor's address.
  const attempt = (visitor: string) => app.inject({ method: "POST", url: "/api/access/login", remoteAddress: "127.0.0.4", headers: { origin: config.siteUrl, "x-forwarded-for": visitor }, payload: { username: "somebody", password: "short" } });
  for (let i = 0; i < 11; i++) {
    const response = await attempt("10.0.0.1");
    assert.equal(response.statusCode, i < 10 ? 401 : 429);
    privateHeaders(response.headers);
  }
  assert.equal((await attempt("10.0.0.2")).statusCode, 401, "another visitor behind the same web container is not locked out");
  // The admin form is a full-page post: a limited visitor goes back to its page with the reason.
  const admin = await app.inject({ method: "POST", url: "/api/auth/password", remoteAddress: "127.0.0.4", headers: { origin: config.siteUrl, "x-forwarded-for": "10.0.0.1", "content-type": "application/x-www-form-urlencoded" }, payload: "password=wrong" });
  assert.equal(admin.statusCode, 303);
  assert.equal(admin.headers.location, "/admin/login?error=too-many");
});

test("router-level malformed targets are private too, without reflecting their contents", async () => {
  for (const method of ["GET", "HEAD"] as const) for (const url of ["/api/%", "/api/v1/items/%ZZ"]) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 400);
    privateHeaders(response.headers);
    assert.equal(response.body.includes(url), false);
    if (method === "HEAD") assert.equal(response.body, "");
  }
  const logo = await app.inject({ url: "/logo.svg" });
  assert.equal(logo.statusCode, 200);
  const conditional = await app.inject({ url: "/logo.svg", headers: { "if-none-match": String(logo.headers.etag) } });
  assert.equal(conditional.statusCode, 304);
  privateHeaders(conditional.headers);
});
