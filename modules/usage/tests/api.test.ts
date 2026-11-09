// 访问统计走完整的守卫链路：成员的浏览器报到被记下（谁、哪一页、什么设备），身份只认服务端的会话；
// 没有令牌、没登录、带查询参数的不记；管理员自己的访问不计入；报表和导出只有管理员能读，导出留审计。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { passwordLogin, sessionPrincipal } from "@aihot/backend/admin/auth";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../../../apps/api/src/app.ts";
import { access } from "../../access/server.ts";
import { usage } from "../server.ts";
import type { UsageReport } from "../types.ts";

config.siteUrl = "https://inside.invalid";
config.adminPassword = "test-only admin password 123";
config.devAdmin = null;
process.env.SESSION_SECRET = "test-only-usage-session-secret";
installModules([access, usage]);
const app = await buildApp();
const password = "member test password 123";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
let admin: { cookie: string; csrf: string };
let member: { id: number; name: string; cookie: string; csrf: string };

const send = (who: { cookie: string; csrf: string } | null, payload: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/site/visit", headers: { ...(who ? { cookie: who.cookie, "x-csrf-token": who.csrf } : {}), origin: config.siteUrl, ...extra }, payload: payload as object });
const rows = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_visits`)[0]!.n;

before(async () => {
  const { token } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  const cookie = `aihot_admin=${token}`;
  admin = { cookie, csrf: (await sessionPrincipal(cookie))!.csrf };
  const username = `visitor-${tag()}`;
  const created = await app.inject({ method: "POST", url: "/api/admin/access/members", headers: { cookie: admin.cookie, origin: config.siteUrl, "x-csrf-token": admin.csrf }, payload: { username, name: "访问测试", password } });
  assert.equal(created.statusCode, 200, created.body);
  const login = await app.inject({ method: "POST", url: "/api/access/login", remoteAddress: "127.0.0.31", headers: { origin: config.siteUrl }, payload: { username, password } });
  assert.equal(login.statusCode, 200, login.body);
  const memberCookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const session = await app.inject({ url: "/api/access/session", headers: { cookie: memberCookie } });
  member = { id: created.json().member.id, name: "访问测试", cookie: memberCookie, csrf: session.json().csrf };
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); installModules([]); });

test("a member's visit is recorded with who, which page and what device; the body cannot name someone else", async () => {
  const response = await send(member, { path: "/story/abc", title: "事件一" }, { "user-agent": IPHONE });
  assert.equal(response.statusCode, 204, response.body);
  const [row] = await sql<{ member_id: number; member_name: string; path: string; title: string; device: string }[]>`
    SELECT member_id, member_name, path, title, device FROM usage_visits WHERE member_id = ${member.id}`;
  assert.deepEqual(row, { member_id: member.id, member_name: "访问测试", path: "/story/abc", title: "事件一", device: "mobile" });

  const before = await rows();
  assert.equal((await send(member, { path: "/story/abc", memberId: 1 })).statusCode, 400, "an id in the body is refused, not believed");
  assert.equal(await rows(), before);
});

test("nothing is recorded without a signed-in member, the CSRF token, or a plain page path", async () => {
  const before = await rows();
  assert.equal((await send(null, { path: "/about" })).statusCode, 401);
  assert.equal((await send({ cookie: member.cookie, csrf: "" }, { path: "/about" })).statusCode, 403, "no CSRF token");
  assert.equal((await send({ cookie: member.cookie, csrf: "stale" }, { path: "/about" })).statusCode, 403, "a stale CSRF token");
  assert.equal((await send(member, { path: "/all?q=secret" })).statusCode, 400, "search terms never reach the table");
  assert.equal((await send(member, { path: "/admin/usage" })).statusCode, 400);
  assert.equal(await rows(), before);
});

test("the admin's own visits are not counted", async () => {
  const before = await rows();
  assert.equal((await send(admin, { path: "/story/abc", title: "事件一" })).statusCode, 204);
  assert.equal(await rows(), before);
});

test("only a real admin reads the report and exports; an export is audited", async () => {
  const today = beijingDate(new Date());
  for (const url of ["/api/admin/usage", `/api/admin/usage/export?from=${today}&to=${today}`]) {
    assert.equal((await app.inject({ url, headers: { cookie: member.cookie } })).statusCode, 403, `member ${url}`);
    assert.equal((await app.inject({ url })).statusCode, 401, `anonymous ${url}`);
  }
  const report = await app.inject({ url: "/api/admin/usage?range=7", headers: { cookie: admin.cookie } });
  assert.equal(report.statusCode, 200, report.body);
  const body = report.json<UsageReport>();
  assert.ok(body.dayMembers.some((m) => m.memberId === member.id && m.name === "访问测试"));
  assert.ok(body.topPages.some((p) => p.path === "/story/abc" && p.title === "事件一"));

  const csv = await app.inject({ url: `/api/admin/usage/export?from=${today}&to=${today}`, headers: { cookie: admin.cookie } });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.match(String(csv.headers["content-type"]), /^text\/csv/);
  assert.match(String(csv.headers["content-disposition"]), /^attachment; filename="usage-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.match(csv.body, /访问测试,\/story\/abc,事件一,手机/);
  const [audited] = await sql<{ after: { rows: number } }[]>`SELECT after FROM audit_log WHERE action = 'usage.export' ORDER BY id DESC LIMIT 1`;
  assert.ok(audited && audited.after.rows >= 1);

  assert.equal((await app.inject({ url: "/api/admin/usage/export?from=2026-01-01&to=2026-12-31", headers: { cookie: admin.cookie } })).statusCode, 400, "a year is too long to export in one go");
});
