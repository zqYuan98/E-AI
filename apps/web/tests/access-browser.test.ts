// Run in the disposable internal build. Browsers and fake API never contact a real service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { before, after, test } from "node:test";
import { chromium, webkit, expect, type Browser, type BrowserContext } from "@playwright/test";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
let chrome: Browser;
let safari: Browser;
let token = 0;
let releaseDelayed: (() => void) | null = null;
const sessions = new Map<string, string>();
const mutations: Array<{ path: string; csrf: string; origin: string }> = [];
let rows: Array<{ id: number; username: string; name: string; disabled: boolean }> = [];
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://fixture.local").pathname;
  const cookie = req.headers.cookie ?? "";
  const memberToken = cookie.match(/(?:^|;\s*)aihot_member=([^;]+)/)?.[1] ?? "";
  const name = sessions.get(memberToken);
  const admin = cookie.includes("aihot_admin=fixture-admin");
  const who = name ? { id: name === "成员甲" ? "member:1" : "member:2", kind: "member", name, csrf: memberToken }
    : admin ? { id: "admin:1", kind: "admin", name: "测试管理员", csrf: "admin-csrf" } : null;
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const body = (run: (value: Record<string, string>) => void) => {
    let text = ""; req.on("data", chunk => { text += chunk; }); req.on("end", () => run(text ? JSON.parse(text) : {}));
  };
  if (path === "/api/access/login") return body(input => {
    if (input.password !== "fixture-password") return json(401, {});
    const value = `session-${++token}`;
    sessions.set(value, input.username === "member-b" ? "成员乙" : "成员甲");
    res.setHeader("set-cookie", `aihot_member=${value}; Path=/; HttpOnly; SameSite=Lax`);
    json(200, { redirect: input.returnTo });
  });
  if (path === "/api/auth/login") { res.writeHead(302, { Location: "/admin/login" }); return res.end(); }
  if (path === "/api/auth/options") return json(200, { password: true, feishu: false });
  if (path === "/api/admin/me") return json(admin ? 200 : name ? 403 : 401, { name: "测试管理员", dev: false, csrf: "admin-csrf" });
  if (!who) return json(401, {});
  if (path === "/api/access/session") return json(200, who);
  if (path === "/api/site/delayed") { releaseDelayed = () => json(200, { content: "late-private-content" }); return; }
  if (req.method === "POST") {
    const csrf = String(req.headers["x-csrf-token"] ?? "");
    const origin = String(req.headers.origin ?? "");
    mutations.push({ path, csrf, origin });
    if (origin !== web.origin || csrf !== (path.startsWith("/api/admin/") || path === "/api/auth/logout" ? "admin-csrf" : who.csrf)) return json(403, {});
    if (path === "/api/access/logout") { sessions.delete(memberToken); res.setHeader("set-cookie", "aihot_member=; Max-Age=0; Path=/"); return json(200, { redirect: "/login" }); }
    if (path === "/api/auth/logout") { res.setHeader("set-cookie", "aihot_admin=; Max-Age=0; Path=/"); res.writeHead(303, { Location: "/" }); return res.end(); }
    if (!admin) return json(403, {});
    if (path === "/api/admin/access/members") return body(input => { rows.push({ id: rows.length + 1, username: input.username, name: input.name, disabled: false }); json(200, { member: rows.at(-1) }); });
    const member = rows.find(row => path.includes(`/members/${row.id}/`));
    if (member && path.endsWith("/disable")) { member.disabled = true; return json(200, { member }); }
    if (member && path.endsWith("/reset")) return body(() => json(200, { member }));
    return json(404, {});
  }
  if (path === "/api/admin/access/members") return json(admin ? 200 : 403, { rows });
  if (path === "/api/admin/nav-counts") return json(200, {});
  if (path === "/api/site/meta") return json(200, { changelogVersion: null });
  if (path === "/api/site/timeline") return json(200, { filters: { category: null, channel: "all", tag: null }, cards: [], nextCursor: null, hot: null, dayCounts: {} });
  if (path === "/api/site/pool") return json(200, { filters: { channel: "all", category: null, tag: null, q: null, tab: "time" }, items: [], page: 1, pageCount: 1, total: 0, todayCount: 0, freshness: null });
  if (path === "/api/health") return json(200, { ok: true });
  return json(404, {});
});
before(async () => {
  const results = await Promise.allSettled([
    startWebServer(api).then(value => { web = value; }),
    chromium.launch({ channel: "chromium" }).then(value => { chrome = value; }),
    webkit.launch().then(value => { safari = value; }),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
});
after(async () => { await chrome?.close(); await safari?.close(); await web?.stop(); });
async function context(browser: Browser) {
  const result = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await result.route("**/*", route => new URL(route.request().url()).origin === web.origin ? route.continue() : route.abort());
  return result;
}
async function login(context: BrowserContext, user = "member-a") {
  const page = await context.newPage();
  await page.goto(web.origin + "/login");
  await page.getByLabel("用户名", { exact: true }).fill(user);
  await page.getByLabel("密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前成员" })).toContainText(user === "member-a" ? "成员甲" : "成员乙");
  return page;
}

for (const engine of ["Chromium", "WebKit"] as const) {
  test(`${engine}: login, no prefetch/persistence, logout and history cannot reveal old content`, async () => {
    const ctx = await context(engine === "Chromium" ? chrome : safari);
    try {
      const page = await login(ctx);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const navigation: string[] = [];
      page.on("request", req => { if (req.url().includes(".data")) navigation.push(req.url()); });
      await page.locator('aside a[href="/all"]').hover();
      await page.waitForTimeout(200);
      assert.deepEqual(navigation, []);
      assert.equal(await page.locator('link[rel="prefetch"]').count(), 0);
      await page.locator('aside a[href="/all"]').click();
      await expect(page).toHaveURL(web.origin + "/all");
      await expect(page.getByRole("region", { name: "当前成员" })).toContainText("成员甲");
      assert.deepEqual(navigation, []);
      assert.deepEqual(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key !== "aihot-theme" && key !== "aihot:access-epoch")), []);
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await expect(page).toHaveURL(/\/login/);
      await page.goBack();
      await expect(page.getByText("登录工作空间", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "当前成员" })).toHaveCount(0);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
}

test("cross-tab replacement, revocation and persisted pageshow recheck live identity", async () => {
  const ctx = await context(chrome);
  try {
    const first = await login(ctx);
    const second = await login(ctx, "member-b");
    await first.bringToFront();
    await expect(first.getByRole("region", { name: "当前成员" })).toContainText("成员乙");
    await expect(first.getByRole("region", { name: "当前成员" })).not.toContainText("成员甲");
    await second.close();
    sessions.clear();
    await first.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(first.getByText("登录工作空间", { exact: true })).toBeVisible();
    assert.equal((await ctx.request.get(web.origin + "/_.data", { maxRedirects: 0 })).status(), 204);
  } finally { await ctx.close(); }
});

test("dual-cookie admin creates, resets and disables members using the admin CSRF; passwords are not stored", async () => {
  rows = [];
  const ctx = await context(chrome);
  try {
    const page = await login(ctx);
    await ctx.addCookies([{ name: "aihot_admin", value: "fixture-admin", url: web.origin, httpOnly: true, sameSite: "Lax" }]);
    await page.goto(web.origin + "/admin/access");
    await page.getByLabel("用户名", { exact: false }).fill("created-member");
    await page.getByLabel("显示名称", { exact: false }).fill("新建成员");
    await page.getByLabel("初始密码", { exact: false }).fill("sensitive-create-password");
    await page.getByRole("button", { name: "创建成员", exact: true }).click();
    await expect(page.getByText("新建成员", { exact: true })).toBeVisible();
    await expect(page.getByLabel("初始密码", { exact: false })).toHaveValue("");
    await page.getByRole("button", { name: "重置密码", exact: true }).click();
    await page.getByLabel("新密码", { exact: false }).fill("sensitive-reset-password");
    await page.getByRole("button", { name: "确认重置", exact: true }).click();
    await expect(page.getByLabel("初始密码", { exact: false })).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "停用", exact: true }).click();
    await expect(page.getByText("已停用", { exact: true })).toBeVisible();
    const commands = mutations.filter(value => value.path.startsWith("/api/admin/access/"));
    assert.equal(commands.length, 3);
    assert.ok(commands.every(value => value.csrf === "admin-csrf" && value.origin === web.origin));
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state })), /sensitive-|fixture-password|admin-csrf|session-\d/);
    await page.locator("aside").getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    assert.equal((await ctx.cookies()).some(cookie => cookie.name === "aihot_admin"), false);
    assert.equal((await ctx.cookies()).some(cookie => cookie.name === "aihot_member"), true);
  } finally { await ctx.close(); }
});


test("a delayed business response cannot repopulate a revoked document", async () => {
  const ctx = await context(chrome);
  try {
    const page = await login(ctx);
    const pending = page.evaluate(async () => {
      try {
        const result = await fetch("/api/site/delayed").then(response => response.json());
        document.body.append(result.content);
        return "rendered";
      } catch { return "blocked"; }
    }).catch(() => "document replaced");
    await expect.poll(() => !!releaseDelayed).toBe(true);
    sessions.clear();
    releaseDelayed!(); releaseDelayed = null;
    assert.notEqual(await pending, "rendered");
    await expect(page.getByText("登录工作空间", { exact: true })).toBeVisible();
    assert.doesNotMatch(await page.locator("body").innerText(), /late-private-content|成员甲/);
  } finally { releaseDelayed?.(); releaseDelayed = null; await ctx.close(); }
});

test("offline history restoration never reveals a hidden private document", async () => {
  const ctx = await context(chrome);
  try {
    const page = await login(ctx);
    await page.locator('aside a[href="/all"]').click();
    await expect(page.getByRole("region", { name: "当前成员" })).toContainText("成员甲");
    sessions.clear();
    await ctx.setOffline(true);
    await page.goBack({ waitUntil: "commit" }).catch(() => {});
    await expect(page.getByRole("region", { name: "当前成员" })).not.toBeVisible();
    await ctx.setOffline(false);
    await page.goto(web.origin + "/");
    await expect(page.getByText("登录工作空间", { exact: true })).toBeVisible();
  } finally { await ctx.close(); }
});
