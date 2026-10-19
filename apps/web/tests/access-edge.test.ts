// Internal-site fixture only. All HTTP peers are local fakes; no database or real identity is used.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import { startWebServer, type WebServer } from "./web-server.ts";
import { ACCESS } from "../app/lib/access.ts";

assert.ok(ACCESS, "Run this suite in the isolated internal-site fixture");
let web: WebServer;
let revoked = false;
let sessionStatus = 200;
const hits: Array<{ path: string; cookie: string }> = [];
const principal = (cookie: string) => cookie.includes("aihot_member=a") ? { id: "member:1", kind: "member", name: "成员甲", csrf: "csrf-a" }
  : cookie.includes("aihot_member=b") ? { id: "member:2", kind: "member", name: "成员乙", csrf: "csrf-b" }
  : cookie.includes("aihot_admin=admin") ? { id: "admin:1", kind: "admin", name: "管理员", csrf: "csrf-admin" } : null;
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://api.local").pathname;
  const cookie = req.headers.cookie ?? "";
  const who = revoked ? null : principal(cookie);
  hits.push({ path, cookie });
  const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/api/access/session") return json(sessionStatus !== 200 ? sessionStatus : who ? 200 : 401, who ?? {});
  if (path === "/api/auth/options") return json(200, { password: true, feishu: false });
  if (path === "/api/admin/me") return json(cookie.includes("aihot_admin=admin") ? 200 : cookie ? 403 : 401, { name: "管理员", csrf: "csrf-admin", dev: false });
  if (path === "/api/access/login") {
    let body = "";
    req.on("data", data => { body += data; });
    req.on("end", () => {
      const login = JSON.parse(body);
      if (login.username !== "member-a" || login.password !== "fixture-password") return json(401, {});
      res.setHeader("set-cookie", "aihot_member=a; HttpOnly; Path=/; SameSite=Lax");
      json(200, { redirect: login.returnTo });
    });
    return;
  }
  if (!who) return json(401, {});
  if (path === "/api/site/meta") return json(200, { changelogVersion: null });
  if (path === "/api/admin/nav-counts") return json(200, {});
  if (path === "/api/admin/access/members") return json(cookie.includes("aihot_admin=admin") ? 200 : 403, { rows: [] });
  if (path === "/api/site/timeline") return setTimeout(() => json(200, {
    filters: { category: null, channel: "all", tag: null }, cards: [], nextCursor: null, dayCounts: {}, hot: null, fixtureActor: who.id,
  }), who.kind === "member" && who.id === "member:1" ? 30 : 1);
  if (path === "/api/site/proxy-error") { req.socket.destroy(); return; }
  if (path === "/api/site/not-modified") { res.writeHead(304, { "Cache-Control": "public, max-age=3600", ETag: "unsafe" }); return res.end(); }
  if (path === "/api/site/echo") return json(200, { cookie, conditional: req.headers["if-none-match"] ?? null });
  return json(404, {});
});
before(async () => { web = await startWebServer(api); });
after(async () => { await web?.stop(); });
const get = (path: string, cookie = "", method = "GET") => fetch(web.origin + path, { redirect: "manual", method, headers: { cookie, "If-None-Match": "*" } });
function privateHeaders(res: Response) {
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("X-Accel-Expires"), "0");
  assert.equal(res.headers.get("Surrogate-Control"), "no-store");
  assert.equal(res.headers.get("ETag"), null);
}

test("every unknown path and data route authenticates before rendering or conditional reuse", async () => {
  for (const path of ["/", "/hot", "/policy", "/nothing", "/assets/copied-private.txt", "/.access-assets.json", "/.vite/manifest.json", "/app/private.ts", "/@fs/private.ts", "/__anything", "/terms.data?_routes=root", "/_.data", "/%61dmin/access", "/ADMIN/access.data"]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await get(path, "", method);
      assert.equal(res.status, path.includes(".data") ? 204 : 302, `${method} ${path}`);
      privateHeaders(res);
      const location = res.headers.get("Location") ?? res.headers.get("X-Remix-Redirect")!;
      assert.ok(location.startsWith(path.toLowerCase().includes("admin") || path.includes("%61dmin") ? "/api/auth/login" : "/login"), location);
      assert.equal(await res.text(), "");
    }
  }
  assert.ok(!hits.some(hit => hit.path === "/api/site/timeline"));
});

test("login, precise emitted browser files and the compiled router manifest are anonymously usable", async () => {
  const login = await get("/login?returnTo=%2Fpolicy");
  assert.equal(login.status, 200); privateHeaders(login);
  const html = await login.text();
  assert.match(html, /登录工作空间/); assert.doesNotMatch(html, /成员甲|成员乙/);
  const files = JSON.parse(await readFile(new URL("../build/client/.access-assets.json", import.meta.url), "utf8")) as string[];
  assert.ok(files.length > 10);
  assert.ok(files.every(file => !file.includes(".map") && !file.startsWith("/.")));
  const scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const asset of new Set([...scripts, ...files])) {
    const res = await get(asset, "", "HEAD");
    assert.equal(res.status, 200, asset); privateHeaders(res);
  }
});

test("parallel SSR requests forward exactly their own Cookie, never a process identity", async () => {
  const replies = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const member = index % 2 ? "b" : "a";
    const res = await get("/_.data", `aihot_member=${member}`);
    assert.equal(res.status, 200); privateHeaders(res);
    const text = await res.text();
    assert.match(text, new RegExp(member === "a" ? "成员甲" : "成员乙"));
    assert.doesNotMatch(text, new RegExp(member === "a" ? "成员乙" : "成员甲"));
    return text;
  }));
  assert.equal(replies.length, 16);
  assert.ok(hits.filter(hit => hit.path === "/api/site/timeline").every(hit => /^aihot_member=[ab]$/.test(hit.cookie)));
});

test("member-first general identity cannot replace the real admin check", async () => {
  const member = await get("/admin/access", "aihot_member=a");
  assert.equal(member.status, 403); privateHeaders(member);
  assert.doesNotMatch(await member.text(), /已授权成员|csrf-admin/);
  const both = await get("/admin/access", "aihot_member=a; aihot_admin=admin");
  assert.equal(both.status, 200); privateHeaders(both);
  const html = await both.text();
  assert.match(html, /成员管理/); assert.match(html, /member:1/); assert.match(html, /csrf-admin/);
});

test("expired sessions and unavailable identity service fail closed; authenticated unknowns remain private", async () => {
  revoked = true;
  try {
    const res = await get("/_.data", "aihot_member=a");
    assert.equal(res.status, 204); privateHeaders(res); assert.equal(await res.text(), "");
  } finally { revoked = false; }
  sessionStatus = 503;
  try {
    const res = await get("/", "aihot_member=a");
    assert.equal(res.status, 503); privateHeaders(res); assert.doesNotMatch(await res.text(), /成员甲/);
  } finally { sessionStatus = 200; }
  const unknown = await get("/not-a-route", "aihot_member=a");
  assert.equal(unknown.status, 404); privateHeaders(unknown); await unknown.text();
});

test("API proxy preserves per-request cookies and errors/HEAD/304 are always no-store", async () => {
  const anon = await get("/api/site/echo"); assert.equal(anon.status, 401); privateHeaders(anon); await anon.text();
  for (const member of ["a", "b"]) {
    const res = await get("/api/site/echo", `aihot_member=${member}`); privateHeaders(res);
    assert.deepEqual(await res.json(), { cookie: `aihot_member=${member}`, conditional: null });
  }
  const conditional = await get("/api/site/not-modified", "aihot_member=a");
  assert.equal(conditional.status, 304); privateHeaders(conditional);
  const failed = await get("/api/site/proxy-error", "aihot_member=a");
  assert.equal(failed.status, 502); privateHeaders(failed); await failed.text();
  const head = await get("/api/not-found", "aihot_member=a", "HEAD");
  assert.equal(head.status, 404); privateHeaders(head); assert.equal(await head.text(), "");
});

test("member form validates origin and safe returns without echoing submitted secrets", async () => {
  for (const [origin, password, status] of [["https://untrusted.invalid", "fixture-password", 400], [web.origin, "wrong-secret-value", 401], [web.origin, "fixture-password", 303]] as const) {
    const res = await fetch(web.origin + "/login", { method: "POST", redirect: "manual", headers: { origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "member-a", password, returnTo: "//untrusted.invalid" }) });
    assert.equal(res.status, status); privateHeaders(res);
    assert.doesNotMatch(await res.text(), /wrong-secret-value|fixture-password/);
    if (status === 303) { assert.equal(res.headers.get("Location"), "/"); assert.match(res.headers.get("Set-Cookie")!, /aihot_member=a/); }
  }
});

test("behind a proxy that ends TLS, the member form signs in from SITE_URL's https origin only", async () => {
  // The proxy forwards plain HTTP with the public Host; the browser's Origin is the https SITE_URL.
  const proxied = await startWebServer(createServer(api.listeners("request")[0] as Parameters<typeof createServer>[1]), { SITE_URL: "https://power.example.test:18443" });
  try {
    const post = (origin: string) => new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const body = new URLSearchParams({ username: "member-a", password: "fixture-password", returnTo: "/" }).toString();
      const req = request({ hostname: "127.0.0.1", port: proxied.port, path: "/login", method: "POST", headers: {
        host: "power.example.test:18443", origin, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body),
      } }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location })); });
      req.on("error", reject); req.end(body);
    });
    assert.deepEqual(await post("https://power.example.test:18443"), { status: 303, location: "/" });
    assert.equal((await post("http://power.example.test:18443")).status, 403, "the sign-in action still requires SITE_URL's exact origin");
    assert.equal((await post("https://other.example.test:18443")).status, 400, "another host is refused before the action runs");
  } finally { await proxied.stop(); }
});

test("malformed origin-form targets fail privately without crashing", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: web.port, path: "/%zz", method: "HEAD" }, res => {
      assert.equal(res.headers["cache-control"], "private, no-store");
      res.resume(); res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await get("/login", "", "HEAD")).status, 200);
});
