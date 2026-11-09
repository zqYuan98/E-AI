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

test("successful admin sign-ins never use up the attempt limit; failed ones do", async () => {
  const signInAdmin = (password: string) => app.inject({
    method: "POST", url: "/api/auth/password", remoteAddress: "127.0.0.250",
    headers: { origin: config.siteUrl, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.20.30.40" },
    payload: new URLSearchParams({ password, return: "/admin" }).toString(),
  });
  for (let i = 0; i < 15; i++) assert.equal((await signInAdmin(config.adminPassword!)).headers.location, "/admin", `success ${i + 1}`);
  for (let i = 0; i < 10; i++) assert.match(String((await signInAdmin(`wrong admin password ${i}`)).headers.location), /error=wrong/);
  assert.match(String((await signInAdmin(config.adminPassword!)).headers.location), /error=too-many/, "ten failures lock this address");
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

/** A stand-in for DingTalk's server: codes map to people; anything else is refused as DingTalk refuses an unknown code. */
function fakeDingtalk(people: Record<string, { userid: string; name: string }>) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://oapi.dingtalk.com") return realFetch(input, init);
    calls.push(url.pathname);
    if (url.pathname === "/gettoken") {
      return Response.json(url.searchParams.get("appsecret") === "test-dingtalk-secret" ? { errcode: 0, access_token: "fake-token", expires_in: 7200 } : { errcode: 40089, errmsg: "invalid appsecret" });
    }
    const code = (JSON.parse(String(init?.body)) as { code: string }).code;
    const person = people[code];
    return Response.json(person ? { errcode: 0, errmsg: "ok", result: person } : { errcode: 40078, errmsg: "不存在的临时授权码" });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
function dingtalkApp(t: { after: (fn: () => void) => void }) {
  const names = ["DINGTALK_CORP_ID", "DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"] as const;
  const previous = names.map((name) => process.env[name]);
  Object.assign(process.env, { DINGTALK_CORP_ID: "ding-test-corp", DINGTALK_APP_KEY: "ding-test-key", DINGTALK_APP_SECRET: "test-dingtalk-secret" });
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
}
const signInDingtalk = (code: string, headers: Record<string, string> = { origin: config.siteUrl }) =>
  app.inject({ method: "POST", url: "/api/access/dingtalk", remoteAddress: `127.0.1.${address++ % 250}`, headers, payload: { code, returnTo: "/research" } });

test("the sign-in page learns whether DingTalk sign-in is on, anonymously, and never sees the secret", async (t) => {
  assert.deepEqual((await app.inject({ url: "/api/access/options" })).json(), { dingtalk: null });
  assert.equal((await signInDingtalk("any-code")).statusCode, 404, "off until all three settings are given");
  dingtalkApp(t);
  const options = await app.inject({ url: "/api/access/options" });
  assert.equal(options.statusCode, 200);
  privateResponse(options);
  assert.deepEqual(options.json(), { dingtalk: { corpId: "ding-test-corp", clientId: "ding-test-key" } });
  assert.equal(options.body.includes("test-dingtalk-secret"), false);
});

test("a company member signing in from DingTalk gets one account, named as in DingTalk, and no password", async (t) => {
  dingtalkApp(t);
  const userid = `ding-${tag()}`;
  const dingtalk = fakeDingtalk({ first: { userid, name: "钉钉甲" }, again: { userid, name: "钉钉甲（改名）" }, other: { userid: `${userid}-b`, name: "钉钉乙" } });
  t.after(dingtalk.restore);

  const first = await signInDingtalk("first");
  assert.equal(first.statusCode, 200, first.body);
  privateResponse(first);
  assert.deepEqual(first.json(), { redirect: "/research" });
  const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
  assert.match(String(first.headers["set-cookie"]), /^aihot_member=.+HttpOnly/);
  const principal = (await app.inject({ url: "/api/access/session", headers: { cookie } })).json<AccessPrincipal>();
  assert.equal(principal.kind, "member");
  assert.equal(principal.name, "钉钉甲");

  const again = await signInDingtalk("again");
  assert.equal(again.statusCode, 200, again.body);
  const renamed = (await app.inject({ url: "/api/access/session", headers: { cookie: String(again.headers["set-cookie"]).split(";")[0]! } })).json<AccessPrincipal>();
  assert.equal(renamed.id, principal.id, "the same person is the same member");
  assert.equal(renamed.name, "钉钉甲（改名）", "the name follows DingTalk");
  assert.equal((await signInDingtalk("other")).statusCode, 200);

  const id = Number(principal.id.slice("member:".length));
  const [member] = await sql<{ username: string; password_hash: string }[]>`SELECT username, password_hash FROM access_members WHERE id = ${id}`;
  const links = await sql`SELECT member_id FROM access_dingtalk_users WHERE userid = ${userid}`;
  assert.deepEqual(links.map((l) => l.member_id), [id]);
  assert.equal((await signIn(member!.username, "dingtalk-only")).statusCode, 401, "an account DingTalk made has no password");
  assert.equal((await signIn(member!.username, "dingtalk-only padding")).statusCode, 401);
  assert.equal(dingtalk.calls.filter((p) => p === "/gettoken").length, 1, "the app token is reused while it is valid");
  const events = await sql`SELECT action, after FROM audit_log WHERE subject = ${principal.id} ORDER BY id`;
  assert.deepEqual(events.map((e) => e.action), ["access.member.dingtalk", "access.login", "access.login"]);
  assert.deepEqual(events[1]!.after, { via: "dingtalk" });
});

test("two first sign-ins of one person at once make one member", async (t) => {
  dingtalkApp(t);
  const userid = `ding-${tag()}`;
  const dingtalk = fakeDingtalk({ a: { userid, name: "并发" }, b: { userid, name: "并发" } });
  t.after(dingtalk.restore);
  const [a, b] = await Promise.all([signInDingtalk("a"), signInDingtalk("b")]);
  assert.deepEqual([a.statusCode, b.statusCode], [200, 200]);
  const links = await sql`SELECT member_id FROM access_dingtalk_users WHERE userid = ${userid}`;
  assert.equal(links.length, 1);
});

test("a refused code, a disabled member and a cross-site post get no session", async (t) => {
  dingtalkApp(t);
  const userid = `ding-${tag()}`;
  const dingtalk = fakeDingtalk({ good: { userid, name: "钉钉丙" } });
  t.after(dingtalk.restore);

  const before = await sql`SELECT count(*)::int AS n FROM access_members`;
  const refused = await signInDingtalk("expired-code");
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.headers["set-cookie"], undefined);
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM access_members`, before, "nobody is made from a refused code");
  assert.equal((await signInDingtalk("good", {})).statusCode, 403, "the page's own origin is required");
  assert.equal((await signInDingtalk("bad code with spaces")).statusCode, 400);

  const tokens = dingtalk.calls.filter((p) => p === "/gettoken").length;
  const ok = await signInDingtalk("good");
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(dingtalk.calls.filter((p) => p === "/gettoken").length, tokens + 1, "a refusal drops the cached app token");
  const id = Number(((await app.inject({ url: "/api/access/session", headers: { cookie: String(ok.headers["set-cookie"]).split(";")[0]! } })).json<AccessPrincipal>()).id.slice("member:".length));
  await changeMember(id, { disable: true }, "admin:test");
  const disabled = await signInDingtalk("good");
  assert.equal(disabled.statusCode, 403);
  assert.match(disabled.json().detail, /已停用/);
  assert.equal(disabled.headers["set-cookie"], undefined);
});
