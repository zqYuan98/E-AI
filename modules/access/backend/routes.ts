import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MEMBER_COOKIE, safeReturnPath } from "@aihot/contracts/access";
import { cookie } from "@aihot/backend/admin/auth";
import { config } from "@aihot/backend/config";
import { adminHandler } from "../../../apps/api/src/routes/admin-auth.ts";
import { sendProblem } from "../../../apps/api/src/http/respond.ts";
import { DingtalkRefused, dingtalkLogin, dingtalkUser } from "./dingtalk.ts";
import { AccessError, SESSION_SECONDS, accessPrincipal, changeMember, changeOwnPassword, createMember, listMembers, loginDingtalk, loginMember, logoutMember, memberPrincipal } from "./members.ts";
import { PasswordBusy } from "./password.ts";

const secure = () => config.siteUrl.startsWith("https://");
function body(req: FastifyRequest): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new AccessError(400, "invalid_request", "A JSON object is required.");
  return req.body as Record<string, unknown>;
}

async function respond(req: FastifyRequest, reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AccessError) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message });
    if (error instanceof PasswordBusy) return sendProblem(req, reply, { status: 429, code: "too_many_requests", detail: "Try again later.", retryAfter: 2 });
    // PostgreSQL errors can contain bound credentials. Neither responses nor logs receive the error.
    req.log.error({ requestId: req.id }, "access request failed");
    return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "Temporarily unavailable." });
  }
}

export function registerAccess(app: FastifyInstance): void {
  app.get("/api/access/session", (req, reply) => respond(req, reply, async () => {
    const principal = await accessPrincipal(req.headers.cookie);
    if (!principal) throw new AccessError(401, "unauthorized", "Sign in first.");
    return principal;
  }));
  app.post("/api/access/login", { bodyLimit: 8 * 1024 }, (req, reply) => respond(req, reply, async () => {
    const b = body(req);
    const token = await loginMember(b.username, b.password, req.id);
    reply.header("Set-Cookie", cookie(MEMBER_COOKIE, token, SESSION_SECONDS, secure()));
    return { redirect: safeReturnPath(b.returnTo, { loginPath: "/login" }) };
  }));
  // What the sign-in page offers besides the password: DingTalk sign-in when the site has a DingTalk app.
  app.get("/api/access/options", async (_req, reply) => reply.header("Cache-Control", "no-store").send({ dingtalk: dingtalkLogin() }));
  // The sign-in page inside DingTalk posts the code DingTalk gave it; DingTalk says who it is.
  app.post("/api/access/dingtalk", { bodyLimit: 8 * 1024 }, (req, reply) => respond(req, reply, async () => {
    const b = body(req);
    if (typeof b.code !== "string" || !/^[!-~]{1,256}$/.test(b.code)) throw new AccessError(400, "invalid_request", "A DingTalk code is required.");
    if (!dingtalkLogin()) throw new AccessError(404, "not_found", "钉钉登录没有开启。");
    let user: { userId: string; name: string };
    try {
      user = await dingtalkUser(b.code);
    } catch (error) {
      if (!(error instanceof DingtalkRefused)) throw error;
      // DingTalk's own message names the cause (an expired code, a server address missing from the app's allowlist); it holds no credentials.
      req.log.warn({ errcode: error.errcode, err: error.message }, "dingtalk sign-in refused");
      throw new AccessError(401, "unauthorized", "钉钉身份验证没有通过。");
    }
    const token = await loginDingtalk(user, req.id);
    reply.header("Set-Cookie", cookie(MEMBER_COOKIE, token, SESSION_SECONDS, secure()));
    return { redirect: safeReturnPath(b.returnTo, { loginPath: "/login" }) };
  }));
  app.post("/api/access/logout", (req, reply) => respond(req, reply, async () => {
    if (!await memberPrincipal(req.headers.cookie)) throw new AccessError(401, "unauthorized", "Sign in first.");
    await logoutMember(req.headers.cookie, req.id);
    reply.header("Set-Cookie", cookie(MEMBER_COOKIE, "", 0, secure()));
    return { redirect: "/login" };
  }));

  const path = "/api/admin/access/members";
  app.get(path, adminHandler((req, reply) => respond(req, reply, async () => ({ rows: await listMembers() }))));
  app.post(path, { bodyLimit: 8 * 1024 }, adminHandler((req, reply, admin) => respond(req, reply, async () => {
    const b = body(req);
    if (typeof b.username !== "string" || typeof b.password !== "string" || (b.name !== undefined && typeof b.name !== "string")) {
      throw new AccessError(400, "invalid_request", "Invalid member details.");
    }
    return { member: await createMember({ username: b.username, password: b.password, name: b.name }, `admin:${admin.userId}`, req.id) };
  })));
  app.post("/api/access/password", { bodyLimit: 8 * 1024 }, (req, reply) => respond(req, reply, async () => {
    const b = body(req);
    await changeOwnPassword(req.headers.cookie, b.current, b.next, req.id);
    reply.header("Set-Cookie", cookie(MEMBER_COOKIE, "", 0, secure()));
    return { redirect: "/login" };
  }));
  app.post(`${path}/:id/enable`, adminHandler((req, reply, admin) => respond(req, reply, async () => ({
    member: await changeMember(Number((req.params as { id: string }).id), { enable: true }, `admin:${admin.userId}`, req.id),
  }))));
  app.post(`${path}/:id/disable`, adminHandler((req, reply, admin) => respond(req, reply, async () => ({
    member: await changeMember(Number((req.params as { id: string }).id), { disable: true }, `admin:${admin.userId}`, req.id),
  }))));
  app.post(`${path}/:id/reset`, { bodyLimit: 8 * 1024 }, adminHandler((req, reply, admin) => respond(req, reply, async () => {
    const b = body(req);
    if (typeof b.password !== "string") throw new AccessError(400, "invalid_request", "A password is required.");
    return { member: await changeMember(Number((req.params as { id: string }).id), { password: b.password }, `admin:${admin.userId}`, req.id) };
  })));
}
