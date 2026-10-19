import type { FastifyInstance } from "fastify";
import { originAllowed } from "@aihot/contracts/access";
import { config } from "@aihot/backend/config";
import { serverModules } from "@aihot/backend/modules";
import { sendProblem } from "../../../apps/api/src/http/respond.ts";
import { accessPrincipal, realAdmin } from "./members.ts";
import { LoginLimits } from "./limits.ts";

const OPEN_READS = new Set([
  "/api/auth/login", "/api/auth/options", "/api/auth/feishu", "/api/auth/callback",
  "/logo.svg", "/favicon.ico", "/icon.png", "/icon-192.png", "/apple-icon.png",
]);
const LOGIN_POSTS = new Set(["/api/access/login", "/api/auth/password"]);
const MEMBER_WRITES = new Set(["/api/access/logout", "/api/access/password", "/api/site/feedback"]);
const attempts = new LoginLimits();

export function allowedOrigins(): string[] {
  return [config.siteUrl, ...serverModules().flatMap((m) => (m.hosts ?? []).map((host) => `https://${host}`))];
}

export function registerAccessGuard(app: FastifyInstance): void {
  // onSend also runs for errors, redirects, conditional 304s and HEAD responses. Route cache headers
  // cannot make a response shareable after onRequest authenticated it.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Cache-Control", "private, no-store").header("X-Accel-Expires", "0").header("Surrogate-Control", "no-store");
    reply.removeHeader("Expires");
    return req.method === "HEAD" && !req.routeOptions.url ? "" : payload;
  });
  // Only failed sign-ins use up the budget: a successful one sets a session cookie with a value, and a busy
  // password check (429 with a short Retry-After, never the limit's own) did not try the password at all.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method !== "POST" || !req.routeOptions.url || !LOGIN_POSTS.has(req.routeOptions.url)) return;
    const cookies = [reply.getHeader("set-cookie") ?? []].flat().map(String);
    const signedIn = reply.statusCode < 400 && cookies.some((c) => /^[^=;\s]+=[^;\s]/.test(c));
    const busy = reply.statusCode === 429 && Number(reply.getHeader("retry-after")) <= 5;
    if (signedIn || busy) attempts.forgive(req.ip);
  });
  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url;
    const read = req.method === "GET" || req.method === "HEAD";
    // Match the router route and method, never raw prefixes, SSR/forwarding headers or an IP identity.
    // A missing route is private too. No database query or release information in anonymous health.
    if (read && route === "/api/health") return reply.send({ ok: true });
    if (read && route && OPEN_READS.has(route)) return;
    if (req.method === "POST" && route && LOGIN_POSTS.has(route)) {
      if (!originAllowed(req.headers.origin, allowedOrigins())) {
        return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "A same-origin request is required." });
      }
      // req.ip is the visitor address the web server wrote; the api port is reachable only from the web.
      if (!attempts.allow(req.ip)) {
        // The admin form is a full-page post: back to its page with the reason, not a JSON body.
        if (route === "/api/auth/password") return reply.redirect("/admin/login?error=too-many", 303);
        return sendProblem(req, reply, { status: 429, code: "too_many_requests", detail: "Try signing in later.", retryAfter: 900 });
      }
      return;
    }
    // The general session prefers a member, but admin routes independently require the real admin
    // cookie and CSRF token, even when both cookies are present. The dev stand-in never counts.
    const adminRoute = !!route && (/^\/api\/admin(?:\/|$)/.test(route) || route === "/api/auth/check" || route === "/api/auth/logout");
    const admin = adminRoute ? await realAdmin(req.headers.cookie) : null;
    const principal = admin ? { kind: "admin" as const, csrf: admin.csrf } : await accessPrincipal(req.headers.cookie);
    if (!principal) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in first." });
    if (adminRoute && !admin) return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "A real admin session is required." });
    if (read) return;
    // MCP POST is deliberately not opened in this batch; authentication still comes first.
    // Members may only sign out, change their own password and send feedback, all with their CSRF token below.
    if (route === "/api/mcp" || (principal.kind === "member" && !MEMBER_WRITES.has(route ?? ""))) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "This session is read-only." });
    }
    if (!originAllowed(req.headers.origin, allowedOrigins()) || req.headers["x-csrf-token"] !== principal.csrf) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "A same-origin request and current CSRF token are required." });
    }
  });
}
