// Real HTTP and real CLI checks against a loopback-only fixture. No .env, backend initialization or DB.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { SITE } from "@aihot/site";
import { loginLocation } from "@aihot/contracts/access";
import { checkArgs, handshakeProblem, sessionCookie } from "../scripts/lib/outlet-checks.ts";

const access = { loginPath: "/login", sessionPath: "/api/access/session" };
const COOKIE = "aihot_member=fake-cookie-never-log";
const SECRET = "response-body-never-log";
const CSRF = "csrf-never-log";
const data = (s: string) => `data:text/javascript,${encodeURIComponent(s)}`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@aihot/site/modules") return { url: data("export const MODULES = [];"), shortCircuit: true };
  if (specifier === "@aihot/site/modules/server" || specifier.startsWith("@aihot/backend/")) throw new Error("Unexpected backend initialization");
  return next(specifier, context);
} });
const { runSmoke, runInternalMcpChecks } = await import("../scripts/smoke.ts");
const directory = await mkdtemp(path.join(tmpdir(), "outlet-smoke-"));
after(async () => { hook.deregister(); await rm(directory, { recursive: true, force: true }); });

type McpHandler = (req: IncomingMessage, res: ServerResponse, body: string, base: string) => Promise<void>;
interface FixtureOptions {
  internal?: boolean;
  leak?: string;
  cache?: string;
  allDenied?: boolean;
  sessionStatus?: number;
  sessionBody?: unknown;
  redirectSession?: string;
  redirectRead?: string;
  wrongLogin?: boolean;
  mcpStatus?: number;
  mcpError?: boolean;
  mcpStall?: boolean;
  assetTarget?: string;
  assetStatus?: number;
  mcpHandler?: McpHandler;
}
async function fixture(options: FixtureOptions = {}) {
  const hits: Array<{ path: string; method: string; cookie?: string }> = [];
  let base = "";
  const server = createServer(async (req, res) => {
    const p = new URL(req.url!, "http://fixture.invalid").pathname;
    hits.push({ path: p, method: req.method!, cookie: req.headers.cookie });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const auth = req.headers.cookie === COOKIE;
    if (options.internal) res.setHeader("cache-control", options.cache ?? "private, no-store");
    const reply = (status: number, type: string, value: string) => { res.writeHead(status, { "content-type": type }); res.end(value); };
    const reject = (status: number) => reply(status, "application/problem+json", JSON.stringify({ name: SITE.mcpPrefix, detail: SECRET }));
    if (options.allDenied) return reject(401);
    if (p === "/api/mcp") {
      if (options.mcpStall) return;
      if (options.internal) return reject(options.mcpStatus ?? (auth ? 403 : 401));
      if (options.mcpHandler) return options.mcpHandler(req, res, body, base);
      return reply(options.mcpStatus ?? 200, "application/json", JSON.stringify(options.mcpError
        ? { jsonrpc: "2.0", id: 1, error: { name: SITE.mcpPrefix, code: -32603, message: SECRET } }
        : { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: SITE.mcpPrefix, version: SITE.interfaceVersion }, capabilities: {} } }));
    }
    const open = ["/api/health", "/icon.png", "/favicon.ico", "/login", "/admin/login", "/assets/login.js", "/assets/login.css"].includes(p);
    const machine = p.startsWith("/api/") || p === "/feed.xml" || p.startsWith("/feed/") || /\.(?:txt|xml|json|webmanifest|png|ico)$/.test(p);
    if (options.internal && !auth && !open && options.leak !== p) {
      if (machine) return reject(401);
      res.writeHead(302, { location: options.wrongLogin ? "/login" : loginLocation(access, p) }); res.end(); return;
    }
    if (p === access.sessionPath) {
      if (options.redirectSession) { res.writeHead(302, { location: options.redirectSession }); res.end(); return; }
      return reply(options.sessionStatus ?? 200, "application/json", JSON.stringify(options.sessionBody ?? { kind: "member", id: "member:1", name: SECRET, csrf: CSRF }));
    }
    if (auth && p === "/api/v1/items" && options.redirectRead) { res.writeHead(302, { location: options.redirectRead }); res.end(); return; }
    if (p === "/api/health") return reply(200, "application/json", '{"ok":true}');
    if (p.startsWith("/api/v1/agent")) return reply(200, "text/markdown", SECRET);
    if (p.startsWith("/api/") || p === "/openapi-v1.json") return reply(200, "application/json", "{}");
    if (p === "/feed.xml" || p.startsWith("/feed/") || p === "/sitemap.xml") return reply(200, "application/xml", "<xml/>");
    if (p.endsWith(".txt")) return reply(200, "text/plain", SECRET);
    if (p.endsWith(".webmanifest")) return reply(200, "application/manifest+json", "{}");
    if (p.endsWith(".png")) return reply(200, "image/png", "png");
    if (p.endsWith(".ico")) return reply(200, "image/x-icon", "ico");
    if (p.startsWith("/assets/")) return reply(options.assetStatus ?? 200, p.endsWith(".css") ? "text/css" : "text/javascript", SECRET);
    reply(200, "text/html", `<html><title>${SITE.name}</title><link rel="stylesheet" href="/assets/login.css"><script src="${options.assetTarget ?? "/assets/login.js"}"></script></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, hits, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function smoke(options: FixtureOptions, cookie?: string, requireAuth = false, timeoutMs = 2000) {
  const service = await fixture(options);
  const logs: string[] = [];
  try {
    const result = await runSmoke({ base: service.base, access: options.internal ? access : null, site: SITE, cookie, requireAuth, timeoutMs, log: (s) => logs.push(s) });
    const output = logs.join("\n");
    for (const secret of [COOKIE, SECRET, CSRF]) assert.ok(!output.includes(secret));
    return { result, output, hits: service.hits };
  } finally { await service.close(); }
}

test("public smoke passes genuine page/content types and initialize success", async () => {
  const { result, hits } = await smoke({});
  assert.deepEqual(result, { failed: 0, auth: "not-required" });
  assert.ok(hits.some((h) => h.path === "/api/mcp" && h.method === "POST"));
  assert.ok(hits.every((h) => !h.cookie));
});

test("internal anonymous denial passes but explicitly leaves authentication untested", async () => {
  const { result, output, hits } = await smoke({ internal: true });
  assert.deepEqual(result, { failed: 0, auth: "not-run" });
  assert.match(output, /认证检查未执行/);
  assert.ok(hits.some((h) => h.path === "/assets/login.js"));
  assert.ok(hits.some((h) => h.path === "/sitemap.xml" && h.method === "HEAD"));
});

test("internal anonymous business 200, missing privacy headers and blanket 401 all fail", async () => {
  for (const options of [{ leak: "/api/v1/items" }, { cache: "public, max-age=60" }, { allDenied: true }, { wrongLogin: true }, { assetStatus: 401 }]) {
    const { result } = await smoke({ internal: true, ...options });
    assert.ok(result.failed > 0);
  }
});

test("require-auth fails without credentials, but a verified member can read and gets MCP 403", async () => {
  const absent = await smoke({ internal: true }, undefined, true);
  assert.ok(absent.result.failed > 0);
  assert.equal(absent.result.auth, "not-run");
  const good = await smoke({ internal: true }, COOKIE, true);
  assert.deepEqual(good.result, { failed: 0, auth: "passed" });
  const withCookie = good.hits.filter((h) => h.cookie);
  assert.equal(withCookie[0].path, access.sessionPath);
  assert.ok(withCookie.some((h) => h.path === "/api/v1/items"));
  assert.ok(withCookie.some((h) => h.path === "/api/mcp" && h.method === "POST"));
  assert.ok(good.hits.slice(0, good.hits.indexOf(withCookie[0])).every((h) => !h.cookie));
});

test("expired and malformed sessions fail before any authenticated business request", async () => {
  for (const options of [{ sessionStatus: 401 }, { sessionBody: { kind: "member", name: SECRET, csrf: CSRF } }, { sessionBody: { kind: "admin", id: "member:1", name: SECRET, csrf: CSRF } }]) {
    const out = await smoke({ internal: true, ...options }, COOKIE, true);
    assert.ok(out.result.failed > 0);
    assert.equal(out.result.auth, "failed");
    assert.deepEqual(out.hits.filter((h) => h.cookie).map((h) => h.path), [access.sessionPath]);
  }
  assert.equal((await smoke({ internal: true }, "aihot_member=expired")).result.auth, "failed");
});

test("a server name in an HTTP or JSON-RPC error never counts as a public handshake", async () => {
  for (const options of [{ mcpError: true }, { mcpStatus: 500, mcpError: true }, { mcpStatus: 401 }]) {
    assert.ok((await smoke(options)).result.failed > 0);
  }
  const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
  const success = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: SITE.mcpPrefix }, capabilities: {} } };
  assert.equal(handshakeProblem(response, `event: message\ndata: ${JSON.stringify(success)}\n\n`, SITE.mcpPrefix), null);
});

test("timeouts are failures without logging response data", async () => {
  const out = await smoke({ mcpStall: true }, undefined, false, 80);
  assert.ok(out.result.failed > 0);
});

test("redirects and external login assets never cause a request to another origin", async () => {
  const other = await fixture();
  try {
    for (const options of [{ redirectSession: other.base }, { redirectRead: other.base }, { assetTarget: `${other.base}/assets/login.js` }]) {
      const out = await smoke({ internal: true, ...options }, COOKIE, true);
      assert.ok(out.result.failed > 0);
    }
    assert.equal(other.hits.length, 0);
  } finally { await other.close(); }
});

test("MCP-only internal check validates anonymous 401 and authenticated 403, not a broad unauthorized success", async () => {
  for (const mcpStatus of [undefined, 200, 401]) {
    const service = await fixture({ internal: true, mcpStatus });
    try {
      const result = await runInternalMcpChecks({ base: service.base, access, site: SITE, cookie: COOKIE, requireAuth: true, log: () => {} });
      assert.equal(result.failed === 0, mcpStatus === undefined);
    } finally { await service.close(); }
  }
});

test("CLI parsing is explicit, requires a base and refuses credential-bearing URLs and conflicting modes", () => {
  for (const args of [[], ["--base", "https://name:password@example.invalid"], ["--base", "https://example.invalid/?token=x"], ["--base", "https://example.invalid", "--anonymous-only", "--require-auth"], ["--base", "https://example.invalid", "--cookie-fd", "1"], ["--cookie"]]) {
    assert.throws(() => checkArgs(args, "smoke"));
  }
  assert.equal(checkArgs(["https://example.invalid/api/mcp", "--anonymous-only"], "mcp").base, "https://example.invalid");
  assert.equal(sessionCookie(`${COOKIE}\n`), COOKIE);
  for (const value of [`${COOKIE}\r\nother:secret`, "", "x=" + "a".repeat(8192)]) assert.throws(() => sessionCookie(value));
});
