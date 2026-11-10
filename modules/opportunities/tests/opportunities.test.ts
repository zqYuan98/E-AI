// 项目商机：采集服务发现的公告第一轮只入库不推送；之后的新公告取附件、拆项目、按业务口径筛（排除词直接无关，
// 其余交给模型；模型出错时按关键词记待确认），对得上的推到钉钉群一次且只一次，每日汇总列 3 天内截止的。
// 采集服务、模型和钉钉都是本地替身，不访问外部服务。
import { pointModels, Reply, stub } from "../../../tests/setup.ts";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { passwordLogin, sessionPrincipal } from "@aihot/backend/admin/auth";
import { buildApp } from "../../../apps/api/src/app.ts";
import { access } from "../../access/server.ts";
import { opportunities } from "../server.ts";
import { discoverCycle, processCycle } from "../backend/run.ts";
import { formatCeiling, pushDigest } from "../backend/push.ts";
import { deadlineAt, isExpired, packageLabel } from "../backend/store.ts";
import { DEFAULT_PROFILE, matchKeywords, validateProfile } from "../backend/profile.ts";
import type { FetcherItem, FetcherNotice, FetcherResult } from "../types.ts";

const TOKEN = "fetcher-test-token-0123456789abcdef";
const URL_OF = (id: string) => `https://ecp.sgcc.com.cn/ecp2.0/portal/#/doc/doci-bid/${id}_2018032900295987`;
const notice = (id: string, title: string): FetcherNotice => ({
  source: "ecp", external_id: `${id}_2018032900295987`, url: URL_OF(id), title, category: "procurement", buyer: "国网示例省电力有限公司物资公司",
  batch: `B${id}`, published: "2099-01-01", metadata: { procurement_file_deadline: "2099-01-05 09:00:00", opening_time: "2099-01-10 09:00:00" },
});
const item = (pkg: string, project_name: string, scope: string, extra: Partial<FetcherItem> = {}): FetcherItem => ({
  batch: "", section: "S-5000", section_name: "零星项目-服务", package: pkg, subpackage: "/", package_name: project_name, project_name,
  buyer: "国网示例供电公司", location: "示例市", scope, qualifications: "/", personnel: "/", performance: "具有同类服务业绩", ceiling: "29.7",
  ceiling_kind: "amount_wan", budget: "", pricing: "总价报价", warnings: [], evidence: [{ file: "需求一览表.xlsx", sheet: "零星项目-服务", row: 4 }], ...extra,
});
const ITEMS = [
  item("包1", "示例供电公司营业厅视频监控系统设备运维服务", "负责营业厅视频监控系统设备运维"),
  item("包2", "示例供电公司食堂餐饮服务", "职工食堂餐饮"),
  item("包3", "示例变电站导线拉力试验技术服务", "导线拉力试验"),
  item("包4", "示例数据分析平台开发", "开发数据分析平台", { ceiling: "0.98", ceiling_kind: "percent" }),
];

// 采集服务替身：/discover 返回 listed，/fetch 按 failures 失败或返回附件解析结果。
let listed: FetcherNotice[] = [];
const failures = new Map<string, { status: number; code: string }>();
const fetched: string[] = [];
const fetcher = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end("{}"); }
    if (req.url === "/discover") return res.end(JSON.stringify({ notices: JSON.parse(body).source === "ecp" ? listed : [] }));
    const url = JSON.parse(body).url as string;
    fetched.push(url);
    const fail = failures.get(url);
    if (fail) { res.statusCode = fail.status; return res.end(JSON.stringify({ error: { code: fail.code, message: "替身失败", retryable: fail.status >= 500 } })); }
    const n = listed.find((x) => x.url === url)!;
    // 采购内容带上批次号：不同公告的项目文字不同（相同的文字会复用已有的模型结果，不再调用）。
    const items = ITEMS.map((i) => ({ ...i, scope: `${i.scope}（${n.batch}）` }));
    const result: FetcherResult = { notice: { ...n, title: `${n.title}（详情）` }, sha256: "a".repeat(64), complete: true, warnings: [], items };
    res.end(JSON.stringify(result));
  });
});
await new Promise<void>((resolve) => fetcher.listen(0, "127.0.0.1", resolve));

// 模型替身：数据分析平台“待确认”、视频监控“相关”、其余“无关”；modelDown 时返回 503。
let modelDown = false;
const prompts: string[] = [];
const model = await stub(async (_hit, req) => {
  if (modelDown) return new Reply(503, { error: { message: "down" } });
  const user = JSON.parse(req.body).messages.at(-1).content as string;
  prompts.push(user);
  const items = [...user.matchAll(/#(\d+) 项目：(.+)/g)].map(([, n, name]) => ({
    n: Number(n),
    verdict: name!.includes("视频监控") ? "相关" : name!.includes("数据分析") ? "待确认" : "无关",
    line: name!.includes("视频监控") ? "智能运检与监测" : name!.includes("数据分析") ? "数字化与信息系统" : "",
    why: name!.includes("视频监控") ? "主体是视频监控系统运维" : "主体不是业务方向",
  }));
  return { id: "stub", choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
pointModels(model.url, ["deepseek-flash"]);
process.env.OPPORTUNITIES_MODEL = "deepseek-flash";
process.env.OPPORTUNITIES_FETCHER_URL = `http://127.0.0.1:${(fetcher.address() as { port: number }).port}`;
process.env.OPPORTUNITIES_FETCHER_TOKEN = TOKEN;
process.env.DINGTALK_ROBOT_WEBHOOK = "https://oapi.dingtalk.com/robot/send?access_token=abcdef0123456789abcdef0123";
process.env.DINGTALK_ROBOT_SECRET = "SEC-test-secret";
process.env.DINGTALK_PUSH_ENABLED = "true";

// 钉钉替身：截下发往 oapi.dingtalk.com 的请求，其余照常。
const sent: Array<{ url: string; title: string; text: string }> = [];
let dingtalk: "ok" | "reject" | "offline" = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://oapi.dingtalk.com/")) return realFetch(input, init);
  if (dingtalk === "offline") throw new TypeError("fetch failed");
  const body = JSON.parse(String(init?.body)) as { markdown: { title: string; text: string } };
  sent.push({ url, title: body.markdown.title, text: body.markdown.text });
  return Response.json(dingtalk === "ok" ? { errcode: 0, errmsg: "ok" } : { errcode: 310000, errmsg: "sign not match" });
}) as typeof fetch;

config.siteUrl = "https://inside.invalid";
config.adminPassword = "test-only admin password 123";
installModules([access, opportunities]);
const app = await buildApp();
let adminCookie = "";
let adminCsrf = "";

before(async () => {
  const { token } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  adminCookie = `aihot_admin=${token}`;
  adminCsrf = (await sessionPrincipal(adminCookie))!.csrf;
});
beforeEach(() => { modelDown = false; dingtalk = "ok"; });
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await model.close();
  await new Promise((resolve) => fetcher.close(resolve));
  await stopBoss();
  await closeDb();
  installModules([]);
});

const verdicts = async (id: string) => Object.fromEntries((await sql<{ package: string; verdict: string; matched_by: string }[]>`
  SELECT package, verdict, matched_by FROM opp_items WHERE notice_id = ${id} ORDER BY ordinal`).map((r) => [r.package, `${r.verdict}/${r.matched_by}`]));

test("the first round is stored and screened but never pushed; later notices are pushed once with the facts that matter", async () => {
  listed = [notice("1001", "存量批次")];
  await discoverCycle();
  const [first] = await sql<{ backfill: boolean; status: string; screened: boolean }[]>`SELECT backfill, status, screened FROM opp_notices WHERE id = 'ecp-1001_2018032900295987'`;
  assert.deepEqual(first, { backfill: true, status: "parsed", screened: true });
  assert.equal(sent.length, 0, "the backlog found on the first round is not pushed");

  listed = [notice("1002", "新批次"), ...listed];
  await discoverCycle();
  assert.deepEqual(await verdicts("ecp-1002_2018032900295987"), {
    包1: "relevant/model", 包2: "irrelevant/exclude", 包3: "irrelevant/model", 包4: "maybe/model",
  });
  assert.ok(!prompts.some((p) => p.includes("食堂")), "excluded projects never reach the model");
  assert.equal(sent.length, 1);
  const msg = sent[0]!;
  assert.match(msg.url, /&timestamp=\d+&sign=/);
  assert.match(msg.title, /^国网商机｜示例供电公司营业厅视频监控系统设备运维服务等 2 项$/);
  for (const fact of ["1 个相关项目，1 个待确认", "新批次（详情）", "采购文件获取截止：**2099-01-05 09:00:00**", "开标：2099-01-10 09:00:00",
    "限价 29.7 万元", "折扣率 98%", "（待确认）", "智能运检与监测：主体是视频监控系统运维", "业绩要求：具有同类服务业绩",
    "https://inside.invalid/opportunities/ecp-1002_2018032900295987"]) assert.ok(msg.text.includes(fact), fact);
  assert.ok(!msg.text.includes("食堂") && !msg.text.includes("导线"), "irrelevant projects are not pushed");

  await discoverCycle();
  await processCycle();
  assert.equal(sent.length, 1, "a notice is pushed only once");
  assert.equal(fetched.filter((u) => u === URL_OF("1002")).length, 1, "an attachment is fetched once");
});

test("when the model is down a notice waits for it; after 6 hours names hitting a keyword are pushed as 待确认", async () => {
  modelDown = true;
  listed = [notice("2001", "模型不可用时的批次"), ...listed];
  const before = sent.length;
  await discoverCycle();
  const [waiting] = await sql<{ screened: boolean; screen_failures: number }[]>`SELECT screened, screen_failures FROM opp_notices WHERE id = 'ecp-2001_2018032900295987'`;
  assert.deepEqual(waiting, { screened: false, screen_failures: 1 });
  assert.equal(sent.length, before, "nothing is pushed while waiting for the model");

  await sql`UPDATE opp_notices SET fetched_at = now() - interval '7 hours' WHERE id = 'ecp-2001_2018032900295987'`;
  await processCycle();
  assert.deepEqual(await verdicts("ecp-2001_2018032900295987"), {
    包1: "maybe/keyword", 包2: "irrelevant/exclude", 包3: "irrelevant/keyword", 包4: "maybe/keyword",
  });
  const msg = sent.at(-1)!;
  assert.match(msg.text, /2 个待确认项目/);
  assert.match(msg.text, /关键词命中：视频监控（未经模型判断）/);
});

test("a keyword only in the procurement content is not enough without the model", () => {
  const p = validateProfile({ lines: [{ name: "信息设备", keywords: ["交换机"] }], exclude: [] });
  const m = matchKeywords(p, { project_name: "供电所弱电布线及设备间环境治理", package_name: "", scope: "更换交换机" });
  assert.equal(m.lines.length, 1);
  assert.equal(m.nameLines.length, 0);
});

test("attachment failures are classified: no public file is not retried, a network failure is retried later", async () => {
  listed = [notice("3001", "没有公开附件"), notice("3002", "网络出错"), ...listed];
  failures.set(URL_OF("3001"), { status: 422, code: "no_attachment" });
  failures.set(URL_OF("3002"), { status: 502, code: "network" });
  await discoverCycle();
  const rows = await sql<{ id: string; status: string; attempts: number; due: boolean }[]>`
    SELECT id, status, attempts, next_attempt_at > now() AS due FROM opp_notices WHERE id IN ('ecp-3001_2018032900295987', 'ecp-3002_2018032900295987') ORDER BY id`;
  const byId = Object.fromEntries(rows.map((r) => [r.id.slice(4, 8), r]));
  // 新的先取：3002 先失败（网络），本轮就停下，3001 留到下一轮。
  assert.equal(byId["3002"]!.status, "failed");
  assert.equal(byId["3002"]!.due, true, "retried after a while, not immediately");
  assert.equal(byId["3001"]!.status, "pending", "a network failure stops this round instead of hammering the source");
  failures.delete(URL_OF("3002"));
  await processCycle();
  const [after3001] = await sql<{ status: string }[]>`SELECT status FROM opp_notices WHERE id = 'ecp-3001_2018032900295987'`;
  assert.equal(after3001!.status, "no_file");
});

test("a rejected push is retried, a push of unknown outcome is not", async () => {
  dingtalk = "reject";
  listed = [notice("4001", "推送被拒"), ...listed];
  await discoverCycle();
  const [rejected] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = 'notice:ecp-4001_2018032900295987'`;
  assert.deepEqual(rejected, { status: "failed", attempts: 1 });
  dingtalk = "ok";
  await processCycle();
  const [retried] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = 'notice:ecp-4001_2018032900295987'`;
  assert.deepEqual(retried, { status: "sent", attempts: 2 });

  dingtalk = "offline";
  listed = [notice("4002", "推送结果不明"), ...listed];
  await discoverCycle();
  dingtalk = "ok";
  const before = sent.length;
  await processCycle();
  const [unknown] = await sql<{ status: string }[]>`SELECT status FROM opp_pushes WHERE key = 'notice:ecp-4002_2018032900295987'`;
  assert.equal(unknown!.status, "unknown");
  assert.equal(sent.length, before, "an outcome we cannot know is not resent");
});

test("the daily digest lists projects whose file deadline is within 3 days, once a day", async () => {
  const id = "ecp-1002_2018032900295987";
  const now = new Date("2099-01-03T00:00:00Z");
  const result = await pushDigest(now);
  assert.equal(result, "sent");
  const msg = sent.at(-1)!;
  assert.match(msg.title, /^国网商机日报 2099-01-03$/);
  assert.ok(msg.text.includes("3 天内采购文件获取截止"));
  assert.ok(msg.text.includes(`/opportunities/${id}#item-`));
  assert.equal(await pushDigest(now), "skipped", "one digest a day");
});

test("site and admin APIs: members read the list and details, only admins change the business profile", async () => {
  const list = await app.inject({ url: "/api/site/opportunities?view=focus", headers: { cookie: adminCookie } });
  assert.equal(list.statusCode, 200, list.body);
  const body = list.json();
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((i: { verdict: string }) => i.verdict === "relevant" || i.verdict === "maybe"));
  assert.deepEqual(body.lines, DEFAULT_PROFILE.lines.map((l) => l.name));
  const card = body.items.find((i: { projectName: string }) => i.projectName.includes("视频监控"));
  assert.equal(card.ceilingKind, "amount_wan");
  assert.equal(card.fileDeadline, "2099-01-05 09:00:00");
  assert.equal(card.expired, false);

  const detail = await app.inject({ url: `/api/site/opportunities/${card.noticeId}`, headers: { cookie: adminCookie } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items.length, 2);
  assert.equal(detail.json().others.length, 2);
  assert.deepEqual(detail.json().items[0].evidence, [{ file: "需求一览表.xlsx", sheet: "零星项目-服务", row: 4 }]);
  assert.equal((await app.inject({ url: "/api/site/opportunities/ecp-missing", headers: { cookie: adminCookie } })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/site/opportunities" })).statusCode, 401, "the site is internal");

  const headers = { cookie: adminCookie, origin: config.siteUrl, "x-csrf-token": adminCsrf };
  const bad = await app.inject({ method: "POST", url: "/api/admin/opportunities/profile", headers, payload: { lines: [{ name: "空方向", keywords: [] }], exclude: [] } });
  assert.equal(bad.statusCode, 400);
  const saved = await app.inject({ method: "POST", url: "/api/admin/opportunities/profile", headers,
    payload: { lines: [{ name: "视频", keywords: ["视频监控", "视频监控"] }], exclude: ["食堂"], reason: "测试" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().profile, { lines: [{ name: "视频", keywords: ["视频监控"] }], exclude: ["食堂"] });
  const admin = await app.inject({ url: "/api/admin/opportunities", headers: { cookie: adminCookie } });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.json().status.pushEnabled, true);
  assert.equal(admin.json().status.fetcherConfigured, true);
  const [audited] = await sql`SELECT reason FROM audit_log WHERE action = 'opportunities.profile' ORDER BY id DESC LIMIT 1`;
  assert.equal(audited!.reason, "测试");
});

test("ceilings carry their unit, deadlines read as Beijing time, keywords match whole English words only", () => {
  assert.equal(formatCeiling("29.7", "amount_wan"), "29.7 万元");
  assert.equal(formatCeiling("40000", "amount_yuan"), "40000 元");
  assert.equal(formatCeiling("0.98", "percent"), "折扣率 98%");
  assert.equal(formatCeiling("/", "amount_wan"), "");
  assert.equal(deadlineAt("2026-11-13 09:00:00")!.toISOString(), "2026-11-13T01:00:00.000Z");
  assert.equal(deadlineAt("详见公告"), null);
  assert.equal(isExpired("2026-11-13 09:00:00", new Date("2026-11-13T01:00:01Z")), true);
  assert.equal(isExpired("", new Date()), false);
  assert.equal(packageLabel({ section: "S1", section_name: "零星项目-服务", package: "包9", subpackage: "9-1" }), "零星项目-服务 · 包9 · 子包 9-1");
  const p = validateProfile({ lines: [{ name: "AI", keywords: ["AI"] }], exclude: ["食堂"] });
  assert.equal(matchKeywords(p, { project_name: "AI 质检平台", package_name: "", scope: "" }).lines.length, 1);
  assert.equal(matchKeywords(p, { project_name: "MAIN 变压器", package_name: "", scope: "" }).lines.length, 0);
  assert.equal(matchKeywords(p, { project_name: "运维", package_name: "", scope: "含食堂保障" }).excludedBy, null, "exclusion reads only names");
});
