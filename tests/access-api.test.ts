import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AccessPrincipal } from "@aihot/contracts/access";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, sessionPrincipal } from "@aihot/backend/admin/auth";
import { installModules } from "@aihot/backend/modules";
import { sha256 } from "@aihot/backend/lib/ids";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";
import { access } from "../modules/access/server.ts";
import { AccessError, changeMember, createMember, loginMember, memberPrincipal } from "../modules/access/backend/members.ts";

config.siteUrl = "https://inside.invalid";
config.adminPassword = "test-only admin password 123";
config.devAdmin = null;
process.env.SESSION_SECRET = "test-only-access-session-secret";
let readers = 0;
installModules([access, { name: "access-test", http: (app) => {
  app.get("/api/access-test/read", async (req, reply) => {
    readers++;
    reply.header("Cache-Control", "public, max-age=3600").header("X-Accel-Expires", "3600").header("ETag", '"test-etag"');
    if (req.headers["if-none-match"] === '"test-etag"') return reply.code(304).send();
    return { privateData: "local-test-only" };
  });
  app.get("/api/access-test/error", async () => { throw new Error("test failure"); });
} }]);
const app = await buildApp();
let adminCookie: string;
let adminCsrf: string;
let address = 10;
const password = "member test password 123";
const replacement = "replacement password 456";
const path = "/api/admin/access/members";
const privateResponse = (response: { headers: Record<string, unknown> }) => {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["x-accel-expires"], "0");
};
const adminHeaders = () => ({ cookie: adminCookie, origin: config.siteUrl, "x-csrf-token": adminCsrf });

before(async () => {
  const { token } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  adminCookie = `aihot_admin=${token}`;
  adminCsrf = (await sessionPrincipal(adminCookie))!.csrf;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); installModules([]); });

async function newMember() {
  const username = `user-${tag()}`;
  const response = await app.inject({ method: "POST", url: path, headers: adminHeaders(), payload: { username: `  ${username.toUpperCase()}  `, name: "测试成员", password } });
  assert.equal(response.statusCode, 200, response.body);
  privateResponse(response);
  assert.equal(response.json().member.username, username);
  return response.json().member as { id: number; username: string; name: string; disabled: boolean };
}
async function signIn(username: string, secret = password, returnTo = "/policy") {
  return app.inject({ method: "POST", url: "/api/access/login", remoteAddress: `127.0.0.${address++}`, headers: { origin: config.siteUrl }, payload: { username, password: secret, returnTo } });
}
async function memberSession(username: string, secret = password) {
  const login = await signIn(username, secret);
  assert.equal(login.statusCode, 200, login.body);
  const setCookie = String(login.headers["set-cookie"]);
  for (const flag of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]) assert.ok(setCookie.includes(flag));
  const cookie = setCookie.split(";")[0]!;
  const session = await app.inject({ url: "/api/access/session", headers: { cookie } });
  assert.equal(session.statusCode, 200);
  privateResponse(session);
  return { cookie, principal: session.json<AccessPrincipal>() };
}
const sessionStatus = async (cookie: string) => (await app.inject({ url: "/api/access/session", headers: { cookie } })).statusCode;

test("real admins create canonical members; credentials never appear in listing, responses or audit", async () => {
  const member = await newMember();
  const duplicate = await app.inject({ method: "POST", url: path, headers: adminHeaders(), payload: { username: member.username.toUpperCase(), password } });
  assert.equal(duplicate.statusCode, 409);
  for (const payload of [{ username: "bad/name", password }, { username: `large-${tag()}`, password: "口".repeat(342) }]) {
    assert.equal((await app.inject({ method: "POST", url: path, headers: adminHeaders(), payload })).statusCode, 400);
  }
  const session = await memberSession(member.username.toUpperCase());
  assert.equal(session.principal.id, `member:${member.id}`);
  assert.equal(session.principal.kind, "member");
  assert.equal(session.principal.name, "测试成员");
  assert.ok(session.principal.csrf.length >= 24);
  const token = session.cookie.split("=")[1]!;
  const [stored] = await sql<{ id_hash: string }[]>`SELECT id_hash FROM access_sessions WHERE member_id = ${member.id}`;
  assert.equal(stored!.id_hash, sha256(token));
  const [credential] = await sql<{ password_hash: string }[]>`SELECT password_hash FROM access_members WHERE id = ${member.id}`;
  assert.match(credential!.password_hash, /^scrypt-v1\$/);
  const list = await app.inject({ url: path, headers: adminHeaders() });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().rows.some((row: { id: number }) => row.id === member.id));
  const events = await sql`SELECT actor, action, before, after FROM audit_log WHERE subject = ${`member:${member.id}`} ORDER BY id`;
  assert.deepEqual(events.map((event) => event.action), ["access.member.create", "access.login"]);
  assert.match(events[0]!.actor, /^admin:/);
  assert.equal(events[1]!.actor, `member:${member.id}`);
  const exposed = `${list.body}${JSON.stringify(events)}`;
  for (const secret of [password, credential!.password_hash, token, stored!.id_hash, session.principal.csrf]) assert.equal(exposed.includes(secret), false);
});

test("with dev admin enabled, two cookies prefer member for session but require real admin CSRF and origin for writes", async (t) => {
  const previous = { devAdmin: config.devAdmin, environmentName: config.environmentName };
  t.after(() => { Object.assign(config, previous); });
  config.devAdmin = { displayName: "Synthetic admin" };
  config.environmentName = "development";
  const member = await newMember();
  const signed = await memberSession(member.username);
  const cookie = `${signed.cookie}; ${adminCookie}`;
  const session = await app.inject({ url: "/api/access/session", headers: { cookie } });
  assert.equal(session.json().kind, "member");
  const admin = await app.inject({ url: "/api/access/session", headers: { cookie: adminCookie } });
  assert.equal(admin.json().kind, "admin");
  assert.match(admin.json().id, /^admin:/);
  const me = await app.inject({ url: "/api/admin/me", headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().dev, false);
  assert.equal(me.json().csrf, adminCsrf);
  assert.equal((await app.inject({ url: path, headers: { cookie: signed.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/me", headers: { cookie: signed.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ url: path, headers: { cookie } })).statusCode, 200);
  const payload = { username: `dual-${tag()}`, password };
  const recovery = "/api/admin/deliveries/1/resolve";
  const invalidRecovery = { outcome: "typo", note: "checked the group" };
  for (const headers of [
    { cookie, origin: config.siteUrl, "x-csrf-token": signed.principal.csrf },
    { cookie, origin: config.siteUrl, "x-csrf-token": "dev" },
    { cookie, "x-csrf-token": adminCsrf },
    { cookie, origin: "https://other.invalid", "x-csrf-token": adminCsrf },
    { cookie, origin: config.siteUrl },
  ]) {
    assert.equal((await app.inject({ method: "POST", url: path, headers, payload })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: recovery, headers, payload: invalidRecovery })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: "POST", url: path, headers: { ...adminHeaders(), cookie }, payload })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: recovery, headers: { ...adminHeaders(), cookie }, payload: invalidRecovery })).statusCode, 400);
});

test("member logout needs its own CSRF and origin, revokes immediately and leaves the admin session alone", async () => {
  const member = await newMember();
  const signed = await memberSession(member.username);
  const cookie = `${signed.cookie}; ${adminCookie}`;
  for (const headers of [{ cookie }, { cookie, origin: config.siteUrl }, { cookie, origin: "https://other.invalid", "x-csrf-token": signed.principal.csrf }, { cookie, origin: config.siteUrl, "x-csrf-token": adminCsrf }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/access/logout", headers })).statusCode, 403);
    assert.equal(await sessionStatus(signed.cookie), 200);
  }
  const logout = await app.inject({ method: "POST", url: "/api/access/logout", headers: { cookie, origin: config.siteUrl, "x-csrf-token": signed.principal.csrf } });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json(), { redirect: "/login" });
  assert.match(String(logout.headers["set-cookie"]), /aihot_member=;.*Max-Age=0/);
  assert.equal(await sessionStatus(signed.cookie), 401);
  assert.equal(await sessionStatus(adminCookie), 200);
  const [event] = await sql`SELECT actor FROM audit_log WHERE subject = ${`member:${member.id}`} AND action = 'access.logout'`;
  assert.equal(event!.actor, `member:${member.id}`);
});

test("expiry, reset and disable revoke live cookies; reset never re-enables a disabled member", async () => {
  const member = await newMember();
  const expired = await memberSession(member.username);
  await sql`UPDATE access_sessions SET expires_at = now() - interval '1 second' WHERE member_id = ${member.id}`;
  assert.equal(await sessionStatus(expired.cookie), 401);
  const old = await memberSession(member.username);
  const reset = await app.inject({ method: "POST", url: `${path}/${member.id}/reset`, headers: adminHeaders(), payload: { password: replacement } });
  assert.equal(reset.statusCode, 200);
  assert.equal(await sessionStatus(old.cookie), 401);
  assert.equal((await signIn(member.username)).statusCode, 401);
  const current = await memberSession(member.username, replacement);
  const disabled = await app.inject({ method: "POST", url: `${path}/${member.id}/disable`, headers: adminHeaders() });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().member.disabled, true);
  assert.equal(await sessionStatus(current.cookie), 401);
  const wrong = await signIn("unknown-member", replacement);
  const blocked = await signIn(member.username, replacement);
  assert.equal(blocked.statusCode, 401);
  assert.equal(blocked.json().detail, wrong.json().detail);
  assert.equal(blocked.json().code, wrong.json().code);
  assert.equal(blocked.headers["set-cookie"], undefined);
  const again = await app.inject({ method: "POST", url: `${path}/${member.id}/reset`, headers: adminHeaders(), payload: { password } });
  assert.equal(again.json().member.disabled, true);
  assert.equal((await signIn(member.username)).statusCode, 401);
});

test("readers admit real sessions, but 301, HEAD, ETag and errors remain private and cannot bypass logout", async () => {
  const member = await newMember();
  const signed = await memberSession(member.username);
  for (const cookie of [signed.cookie, adminCookie]) {
    const read = await app.inject({ url: "/api/access-test/read", headers: { cookie } });
    assert.equal(read.statusCode, 200);
    privateResponse(read);
    const conditional = await app.inject({ url: "/api/access-test/read", headers: { cookie, "if-none-match": '"test-etag"' } });
    assert.equal(conditional.statusCode, 304);
    privateResponse(conditional);
    const head = await app.inject({ method: "HEAD", url: "/api/access-test/read", headers: { cookie } });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    privateResponse(head);
    const redirect = await app.inject({ url: "/feed", headers: { cookie } });
    assert.equal(redirect.statusCode, 301);
    privateResponse(redirect);
    const error = await app.inject({ url: "/api/access-test/error", headers: { cookie } });
    assert.equal(error.statusCode, 503);
    privateResponse(error);
    const missing = await app.inject({ url: "/unknown-private-route", headers: { cookie } });
    assert.equal(missing.statusCode, 404);
    privateResponse(missing);
  }
  await changeMember(member.id, { disable: true }, "admin:test");
  const before = readers;
  for (const method of ["GET", "HEAD"] as const) {
    const response = await app.inject({ method, url: "/api/access-test/read", headers: { cookie: signed.cookie, "if-none-match": '"test-etag"', "x-aihot-ssr": "1" } });
    assert.equal(response.statusCode, 401);
    privateResponse(response);
  }
  assert.equal(readers, before);
});

test("members cannot write business data or call MCP POST; forged cookies and dev admin grant nothing", async () => {
  const member = await newMember();
  const signed = await memberSession(member.username);
  const headers = { cookie: signed.cookie, origin: config.siteUrl, "x-csrf-token": signed.principal.csrf };
  // Feedback is the one business write a member makes, and only with the session's CSRF token.
  assert.equal((await app.inject({ method: "POST", url: "/api/site/feedback", headers: { cookie: signed.cookie, origin: config.siteUrl }, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/site/feedback", headers, payload: {} })).statusCode, 400, "reaches the form reader");
  for (const url of ["/api/ingest/items", "/api/mcp", path, "/api/admin/sources", "/api/admin/deliveries/1/resolve"]) {
    const response = await app.inject({ method: "POST", url, headers, payload: {} });
    assert.equal(response.statusCode, 403, url);
    privateResponse(response);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/mcp", headers: adminHeaders(), payload: {} })).statusCode, 403);
  for (const cookie of ["aihot_member=forged", `aihot_member=${"A".repeat(43)}`, "aihot_admin=forged", `${signed.cookie}changed`]) {
    assert.equal(await sessionStatus(cookie), 401);
  }
  const previous = { devAdmin: config.devAdmin, environmentName: config.environmentName };
  config.devAdmin = { displayName: "Synthetic admin" };
  config.environmentName = "development";
  try {
    const devHeaders = { origin: config.siteUrl, "x-csrf-token": "dev", "x-forwarded-for": "127.0.0.1", "x-aihot-ssr": "1" };
    for (const url of ["/api/access/session", "/api/admin/me", path, "/api/auth/check", "/api/access-test/read"]) {
      const response = await app.inject({ url, headers: devHeaders });
      assert.equal(response.statusCode, 401, url);
    }
    for (const [cookie, status] of [[undefined, 401], ["aihot_admin=forged", 401], [signed.cookie, 403]] as const) {
      const response = await app.inject({ method: "POST", url: "/api/admin/deliveries/1/resolve", headers: { ...devHeaders, ...(cookie ? { cookie } : {}) }, payload: {} });
      assert.equal(response.statusCode, status, cookie ?? "no cookie");
      privateResponse(response);
    }
  } finally { Object.assign(config, previous); }
  const unsafe = await signIn(member.username, password, "//evil.invalid");
  assert.equal(unsafe.statusCode, 200);
  assert.deepEqual(unsafe.json(), { redirect: "/" });
});

/** Observe real PostgreSQL lock waits, rather than hope two password hashes finish in an order. */
async function waitForMemberLocks(count: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
        AND query LIKE '%FROM access_members WHERE id =%FOR UPDATE%'`;
    if (row!.count >= count) return;
    await delay(25);
  }
  throw new Error(`Expected ${count} member-row lock waiters`);
}

for (const operation of ["reset", "disable"] as const) test(`${operation} racing an old-password login cannot leave a usable or newly inserted old session`, async () => {
  const member = await createMember({ username: `race-${tag()}`, password }, "admin:test");
  const existing = await loginMember(member.username, password);
  const locked = gate();
  const release = gate();
  const held = sql.begin(async (tx) => {
    await tx`SELECT id FROM access_members WHERE id = ${member.id} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  // Reset/disable queues for the row first. The old-password login reads the old committed snapshot,
  // verifies it, then queues second. Its post-lock version check must reject after the change commits.
  const changed = changeMember(member.id, operation === "reset" ? { password: replacement } : { disable: true }, "admin:test")
    .then((value) => ({ value }), (error: unknown) => ({ error }));
  let login: Promise<{ token: string } | { error: unknown }> | undefined;
  try {
    await waitForMemberLocks(1);
    login = loginMember(member.username, password).then((token) => ({ token }), (error: unknown) => ({ error }));
    await waitForMemberLocks(2);
  } finally {
    release.open();
    await held;
    // Never leave a blocked transaction behind if an assertion or the lock observer fails.
    await Promise.all([changed, login]);
  }
  assert.ok("value" in await changed);
  const result = await login!;
  assert.ok("error" in result && result.error instanceof AccessError && result.error.status === 401);
  assert.equal(await memberPrincipal(`aihot_member=${existing}`), null);
  const [sessions] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM access_sessions WHERE member_id = ${member.id}`;
  assert.equal(sessions!.count, 0);
  if (operation === "reset") {
    const token = await loginMember(member.username, replacement);
    assert.equal((await memberPrincipal(`aihot_member=${token}`))!.id, `member:${member.id}`);
  }
});

test("a disabled member can be restored; a member changes their own password and every session of theirs ends", async () => {
  const member = await newMember();
  assert.equal((await app.inject({ method: "POST", url: `${path}/${member.id}/disable`, headers: adminHeaders() })).statusCode, 200);
  assert.equal((await signIn(member.username)).statusCode, 401);
  const enabled = await app.inject({ method: "POST", url: `${path}/${member.id}/enable`, headers: adminHeaders() });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().member.disabled, false);
  const audited = await sql`SELECT 1 FROM audit_log WHERE action = 'access.member.enable' AND subject = ${`member:${member.id}`}`;
  assert.equal(audited.length, 1);

  const here = await memberSession(member.username);
  const elsewhere = await memberSession(member.username);
  const change = (payload: Record<string, unknown>, headers: Record<string, string> = { cookie: here.cookie, origin: config.siteUrl, "x-csrf-token": here.principal.csrf }) =>
    app.inject({ method: "POST", url: "/api/access/password", headers, payload });
  const fresh = "brand new password 789";
  assert.equal((await change({ current: password, next: fresh }, { cookie: here.cookie, origin: config.siteUrl })).statusCode, 403, "the CSRF token is required");
  assert.equal((await change({ current: "not the password 000", next: fresh })).statusCode, 403, "the current password must match");
  assert.equal((await change({ current: password, next: "short" })).statusCode, 400);
  assert.equal((await change({ current: password, next: password })).statusCode, 400);
  assert.equal((await change({ current: password, next: fresh }, { cookie: adminCookie, origin: config.siteUrl, "x-csrf-token": adminCsrf })).statusCode, 401, "only a member changes a member password");

  const done = await change({ current: password, next: fresh });
  assert.equal(done.statusCode, 200, done.body);
  privateResponse(done);
  assert.match(String(done.headers["set-cookie"]), /aihot_member=;/);
  assert.equal(await sessionStatus(here.cookie), 401, "this session ends");
  assert.equal(await sessionStatus(elsewhere.cookie), 401, "and every other session of the member");
  assert.equal((await signIn(member.username)).statusCode, 401);
  assert.equal((await signIn(member.username, fresh)).statusCode, 200);
});

test("admin logout uses real admin CSRF even with a member cookie and revokes only the admin session", async () => {
  const member = await newMember();
  const signed = await memberSession(member.username);
  const cookie = `${signed.cookie}; ${adminCookie}`;
  const wrong = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, origin: config.siteUrl, "x-csrf-token": signed.principal.csrf } });
  assert.equal(wrong.statusCode, 403);
  const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...adminHeaders(), cookie } });
  assert.equal(logout.statusCode, 303);
  privateResponse(logout);
  assert.equal(await sessionStatus(adminCookie), 401);
  assert.equal(await sessionStatus(signed.cookie), 200);
});
