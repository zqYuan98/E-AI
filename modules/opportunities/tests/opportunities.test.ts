// 投标商机：采集服务发现的公告第一轮只入库不推送；之后的新公告取附件、拆项目、按业务口径筛（排除词直接无关，
// 其余交给模型；模型出错时按关键词记待确认），从公告正文抽出预算、时间和资格业绩要求（原话核对不上的去掉），
// 对得上的推到每个要它的钉钉群一次且只一次（各群按自己选的方向和来源，@ 关注这些方向的提醒人），每日汇总列 3 天内截止的。
// 其他招采平台的资料一条一个项目，结果类公告不收。
// 采集服务、模型和钉钉都是本地替身，不访问外部服务。
import { pointModels, Reply, stub } from "../../../tests/setup.ts";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { passwordLogin, sessionPrincipal } from "@aihot/backend/admin/auth";
import { buildApp } from "../../../apps/api/src/app.ts";
import { access } from "../../access/server.ts";
import { opportunities } from "../server.ts";
import { discoverCycle, processCycle } from "../backend/run.ts";
import { formatCeiling, pushDigest, sitePage } from "../backend/push.ts";
import { deadlineAt, isExpired, packageLabel } from "../backend/store.ts";
import { verified } from "../backend/details.ts";
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
/** 公告正文：要素抽取的原话都要在这里面找得到。 */
const TEXT = "视觉及环境采集系统框架采购，含图像识别算法与视频分析平台部署。本次招标预算金额为人民币120万元。"
  + "投标人须具备电子与智能化工程专业承包二级及以上资质。投标人近三年具有不少于2个视频监控系统运维业绩。"
  + "投标文件递交截止时间为2099年1月8日9时30分。本次招标不接受联合体投标。";
const q = <T,>(value: T, quote: string) => ({ value, quote });
const requirement = (kind: string, text: string, quote: string) => ({ kind, text, quote, lots: null, qualification: null, performance: null });
/** 抽要素的模型回答：报名截止的原话是开标那句（日期对不上），项目经理那条原话是编的，两项都该去掉。 */
const DETAILS = {
  kind: "招标公告", projectName: null, projectCode: null, buyer: null, agency: null, region: null,
  budgetWan: q(120, "本次招标预算金额为人民币120万元"),
  allowsConsortium: q(false, "本次招标不接受联合体投标"),
  times: {
    docObtainStart: null, docObtainEnd: null,
    signupDeadline: q("2099-01-07 17:00", "投标文件递交截止时间为2099年1月8日9时30分"),
    bidDeadline: q("2099-01-08 09:30", "投标文件递交截止时间为2099年1月8日9时30分"),
    opening: null,
  },
  lots: [],
  requirements: [
    requirement("qualification", "电子与智能化工程专业承包二级及以上资质", "投标人须具备电子与智能化工程专业承包二级及以上资质"),
    requirement("performance", "近三年不少于2个视频监控系统运维业绩", "投标人近三年具有不少于2个视频监控系统运维业绩"),
    requirement("personnel", "项目经理须具备一级建造师证书", "项目经理须具备一级建造师证书"),
  ],
  detailsInDocuments: false,
};
const ITEMS = [
  item("包1", "示例供电公司营业厅视频监控系统设备运维服务", "负责营业厅视频监控系统设备运维"),
  item("包2", "示例供电公司食堂餐饮服务", "职工食堂餐饮"),
  item("包3", "示例变电站导线拉力试验技术服务", "导线拉力试验"),
  item("包4", "示例数据分析平台开发", "开发数据分析平台", { ceiling: "0.98", ceiling_kind: "percent" }),
];

// 采集服务替身：/discover 返回 listed，/fetch 按 failures 失败或返回附件解析结果。
let listed: FetcherNotice[] = [];
const failures = new Map<string, { status: number; code: string }>();
/** 附件里只有 Word 公告、没有需求表的公告。 */
const wordOnly = new Set<string>();
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
    const items = wordOnly.has(url) ? [] : ITEMS.map((i) => ({ ...i, scope: `${i.scope}（${n.batch}）` }));
    const result: FetcherResult = { notice: { ...n, title: `${n.title}（详情）` }, sha256: "a".repeat(64), complete: true, warnings: [], items,
      text: TEXT };
    res.end(JSON.stringify(result));
  });
});
await new Promise<void>((resolve) => fetcher.listen(0, "127.0.0.1", resolve));

// 模型替身：筛选时数据分析平台“待确认”、视频监控“相关”、其余“无关”；抽要素时给出 DETAILS（其中两条原话编造或对不上）。
// modelDown 时返回 503。
let modelDown = false;
const prompts: string[] = [];
const model = await stub(async (_hit, req) => {
  if (modelDown) return new Reply(503, { error: { message: "down" } });
  const user = JSON.parse(req.body).messages.at(-1).content as string;
  prompts.push(user);
  if (user.includes("【公告】")) return { id: "stub", choices: [{ message: { content: JSON.stringify(DETAILS) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
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
process.env.DINGTALK_PUSH_ENABLED = "true";
const ROBOT = (token: string) => `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
const MAIN_TOKEN = "abcdef0123456789abcdef0123";

// 钉钉替身：截下发往 oapi.dingtalk.com 的请求，其余照常。
const sent: Array<{ url: string; title: string; text: string; at: string[] }> = [];
let dingtalk: "ok" | "reject" | "offline" = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://oapi.dingtalk.com/")) return realFetch(input, init);
  if (dingtalk === "offline") throw new TypeError("fetch failed");
  const body = JSON.parse(String(init?.body)) as { markdown: { title: string; text: string }; at: { atMobiles: string[] } };
  sent.push({ url, title: body.markdown.title, text: body.markdown.text, at: body.at.atMobiles });
  return Response.json(dingtalk === "ok" ? { errcode: 0, errmsg: "ok" } : { errcode: 310000, errmsg: "sign not match" });
}) as typeof fetch;

config.siteUrl = "https://inside.invalid";
config.adminPassword = "test-only admin password 123";
installModules([access, opportunities]);
const app = await buildApp();
let adminCookie = "";
let adminCsrf = "";
const adminHeaders = () => ({ cookie: adminCookie, origin: config.siteUrl, "x-csrf-token": adminCsrf });
/** 一开始就有的推送群（所有方向、所有来源、含待确认）的推送记录前缀。 */
let main = "";

before(async () => {
  const { token } = await passwordLogin(config.adminPassword!, "/admin", undefined);
  adminCookie = `aihot_admin=${token}`;
  adminCsrf = (await sessionPrincipal(adminCookie))!.csrf;
  const created = await app.inject({ method: "POST", url: "/api/admin/opportunities/groups", headers: adminHeaders(),
    payload: { name: "商务部投标群", webhook: ROBOT(MAIN_TOKEN), secret: "SEC-test-secret", reason: "测试" } });
  assert.equal(created.statusCode, 200, created.body);
  const [g] = await sql<{ id: number }[]>`SELECT id FROM opp_push_groups WHERE name = '商务部投标群'`;
  main = `g${g!.id}`;
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
  assert.match(msg.title, /^投标商机｜示例供电公司营业厅视频监控系统设备运维服务等 2 项$/);
  for (const fact of ["1 个相关项目，1 个待确认", "新批次（详情）", "国网电子商务平台", "获取截止：**2099-01-05 09:00:00**", "投标截止：**2099-01-08 09:30**",
    "开标：2099-01-10 09:00:00", "预算 120 万元", "不接受联合体", "限价 29.7 万元", "折扣率 98%", "（待确认）", "采购内容：负责营业厅视频监控系统设备运维",
    "智能运检与监测：主体是视频监控系统运维", "业绩要求：具有同类服务业绩", "**公告通用要求**", "资质：电子与智能化工程专业承包二级及以上资质",
    "业绩：近三年不少于2个视频监控系统运维业绩", "dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Finside.invalid%2Fopportunities%2Fecp-1002_2018032900295987&pc_slide=true"]) assert.ok(msg.text.includes(fact), fact);
  assert.ok(!msg.text.includes("食堂") && !msg.text.includes("导线"), "irrelevant projects are not pushed");
  assert.ok(!msg.text.includes("项目经理") && !msg.text.includes("报名截止"), "details whose quote is not in the notice are dropped");

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

test("a notice whose attachment has no demand sheet is judged as one project from its Word text", async () => {
  wordOnly.add(URL_OF("6001"));
  listed = [notice("6001", "视觉及环境采集系统框架"), ...listed];
  await discoverCycle();
  const items = await sql<{ project_name: string; scope: string; package: string }[]>`SELECT project_name, scope, package FROM opp_items WHERE notice_id = 'ecp-6001_2018032900295987'`;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.project_name, "视觉及环境采集系统框架（详情）");
  assert.match(items[0]!.scope, /图像识别算法/);
  const [n] = await sql<{ item_count: number; warnings: string[] }[]>`SELECT item_count, warnings FROM opp_notices WHERE id = 'ecp-6001_2018032900295987'`;
  assert.equal(n!.item_count, 1);
  assert.equal(n!.warnings[0], "附件里没有需求表，按整份公告判断");
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
  const [rejected] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = ${`${main}:notice:ecp-4001_2018032900295987`}`;
  assert.deepEqual(rejected, { status: "failed", attempts: 1 });
  dingtalk = "ok";
  await processCycle();
  const [retried] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = ${`${main}:notice:ecp-4001_2018032900295987`}`;
  assert.deepEqual(retried, { status: "sent", attempts: 2 });

  dingtalk = "offline";
  listed = [notice("4002", "推送结果不明"), ...listed];
  await discoverCycle();
  dingtalk = "ok";
  const before = sent.length;
  await processCycle();
  const [unknown] = await sql<{ status: string }[]>`SELECT status FROM opp_pushes WHERE key = ${`${main}:notice:ecp-4002_2018032900295987`}`;
  assert.equal(unknown!.status, "unknown");
  assert.equal(sent.length, before, "an outcome we cannot know is not resent");
});

test("tender notices from other platforms join as one project each: results are skipped, screened in a batch and pushed with their details", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at) VALUES
    ('opp-csg-tender', '南方电网供应链·招标公告', 'rss', 'T1', 'editorial', ${["招标", "南网"]}, '2100-01-01'),
    ('opp-csg-result', '南方电网供应链·中标候选人公示', 'rss', 'T1', 'editorial', ${["中标", "南网"]}, '2100-01-01')`;
  const add = async (sourceId: string, n: string, title: string, bodyText: string) =>
    (await upsertMaterial({ sourceId, url: `https://example.com/opp-${n}`, title, bodyText, bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
  const backlog = await add("opp-csg-tender", "0", "示例供电局存量视频监控项目招标公告", TEXT);
  await processCycle();
  const [first] = await sql<{ backfill: boolean; screened: boolean }[]>`SELECT backfill, screened FROM opp_notices WHERE id = ${`web-${backlog}`}`;
  assert.deepEqual(first, { backfill: true, screened: true }, "what is already there the first time is stored, not pushed");

  const before = sent.length;
  const prompted = prompts.length;
  const ids = {
    hit: await add("opp-csg-tender", "1", "示例供电局视频监控平台采购项目招标公告", TEXT),
    maybe: await add("opp-csg-tender", "2", "示例供电局数据分析平台采购公告", "采购数据分析平台一套。"),
    excluded: await add("opp-csg-tender", "3", "示例供电局办公楼保洁服务招标公告", "保洁服务。"),
    result: await add("opp-csg-tender", "4", "示例供电局视频监控平台采购项目中标结果公告", "中标人：某公司。"),
    candidates: await add("opp-csg-result", "5", "示例视频监控项目中标候选人公示", "第一中标候选人：某公司。"),
  };
  await processCycle();
  const rows = await sql<{ id: string; verdict: string; matched_by: string }[]>`
    SELECT n.id, i.verdict, i.matched_by FROM opp_notices n JOIN opp_items i ON i.notice_id = n.id WHERE n.source = 'web' AND NOT n.backfill`;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, `${r.verdict}/${r.matched_by}`])), {
    [`web-${ids.hit}`]: "relevant/model", [`web-${ids.maybe}`]: "maybe/model", [`web-${ids.excluded}`]: "irrelevant/exclude",
  }, "results and candidate lists are not opportunities");
  assert.equal(prompts.slice(prompted).filter((p) => p.includes("#2 项目：")).length, 1, "the platform's items are screened in one batch");

  assert.equal(sent.length, before + 1, "only the relevant one is pushed; 待确认 from other platforms waits for the list and digest");
  const msg = sent.at(-1)!;
  assert.equal(msg.title, "投标商机｜示例供电局视频监控平台采购项目招标公告");
  for (const fact of ["南方电网供应链·招标公告", "投标截止：**2099-01-08 09:30**", "预算 120 万元", "资质：电子与智能化工程专业承包二级及以上资质",
    `[原文](https://example.com/opp-1)`, sitePage(`/opportunities/web-${ids.hit}`)]) assert.ok(msg.text.includes(fact), fact);

  const list = (await app.inject({ url: "/api/site/opportunities?source=web", headers: { cookie: adminCookie } })).json();
  const card = list.items.find((i: { noticeId: string }) => i.noticeId === `web-${ids.hit}`);
  assert.deepEqual([card.sourceName, card.bidDeadline, card.noticeBudget], ["南方电网供应链·招标公告", "2099-01-08 09:30", "120 万元"]);
  const [n] = await sql<{ file_deadline: string }[]>`SELECT file_deadline FROM opp_notices WHERE id = ${`web-${ids.hit}`}`;
  assert.equal(n!.file_deadline, "", "a deadline the notice does not state is not invented");
});

test("only details whose quote is in the notice survive; dates and amounts must appear in their quote", () => {
  const out = structuredClone(DETAILS) as unknown as Parameters<typeof verified>[0];
  out.budgetWan = q(150, "本次招标预算金额为人民币120万元");
  const d = verified(out, `${TEXT}\n第二页`);
  assert.equal(d.budget, "", "150 is not the amount in the quote");
  assert.equal(d.times.bidDeadline, "2099-01-08 09:30");
  assert.equal(d.times.signupDeadline, "");
  assert.deepEqual(d.requirements.map((r) => r.kind), ["qualification", "performance"]);
  const yuan = verified({ ...out, budgetWan: q(120, "预算金额为人民币1,200,000元整") }, "本项目预算金额为人民币1,200,000元整。");
  assert.equal(yuan.budget, "120 万元");
});

test("each group gets only the directions and sources it chose, from when it was added, and @s the people who follow them", async () => {
  const headers = adminHeaders();
  const payload = {
    name: "运检方向群", webhook: ROBOT("0123456789abcdef0123456789"), secret: "SEC-second", includeMaybe: false, digest: false,
    lines: ["智能运检与监测"], sources: ["ecp"],
    mentions: [{ name: "张三", mobile: "13800000001", lines: ["智能运检与监测"] }, { name: "李四", mobile: "13800000002", lines: ["数字化与信息系统"] },
      { name: "王五", mobile: "13800000003", lines: [] }],
  };
  const create = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/admin/opportunities/groups", headers, payload: body });
  assert.equal((await create({ ...payload, webhook: "https://example.com/hook" })).statusCode, 400);
  assert.equal((await create({ ...payload, mentions: [{ name: "张三", mobile: "123" }] })).statusCode, 400);
  assert.equal((await create({ ...payload, reason: "测试" })).statusCode, 200);
  const [g] = await sql<{ id: number }[]>`SELECT id FROM opp_push_groups WHERE name = '运检方向群'`;
  const second = `g${g!.id}`;

  const before = sent.length;
  listed = [notice("7001", "分群推送批次"), ...listed];
  await discoverCycle();
  const mine = sent.slice(before);
  assert.equal(mine.length, 2, "one message per group that wants the notice");
  const toMain = mine.find((m) => m.url.includes(MAIN_TOKEN))!;
  const toSecond = mine.find((m) => !m.url.includes(MAIN_TOKEN))!;
  assert.match(toMain.text, /1 个相关项目，1 个待确认/);
  assert.deepEqual(toMain.at, [], "a group without people @s nobody");
  assert.match(toSecond.text, /#### 投标商机：1 个相关项目\n/);
  assert.ok(toSecond.text.includes("视频监控") && !toSecond.text.includes("数据分析"), "only the chosen direction, no 待确认");
  assert.deepEqual(toSecond.at, ["13800000001", "13800000003"], "people following that direction, and those following all");
  assert.ok(toSecond.text.endsWith("提醒：@13800000001 @13800000003"));
  const pushed = await sql<{ key: string }[]>`SELECT key FROM opp_pushes WHERE key LIKE '%:notice:ecp-7001%' AND status = 'sent'`;
  assert.deepEqual(pushed.map((p) => p.key).sort(), [`${main}:notice:ecp-7001_2018032900295987`, `${second}:notice:ecp-7001_2018032900295987`].sort());
  assert.equal((await sql`SELECT 1 FROM opp_pushes WHERE key LIKE ${`${second}:notice:ecp-1002%`}`).length, 0,
    "notices found before the group was added are not sent to it");

  const admin = await app.inject({ url: "/api/admin/opportunities", headers: { cookie: adminCookie } });
  assert.ok(!admin.body.includes("SEC-second") && !admin.body.includes("0123456789abcdef0123456789"), "webhook and secret stay in the backend");
  const shown = admin.json().groups.find((x: { name: string }) => x.name === "运检方向群");
  assert.deepEqual([shown.sent, shown.webhookHint], [1, "…456789"]);
  assert.deepEqual(admin.json().notices.find((n: { id: string }) => n.id === "ecp-7001_2018032900295987").pushedGroups, ["商务部投标群", "运检方向群"]);

  // 修改时 Webhook 和密钥留空沿用原来的；删掉群连同它的推送记录。
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/opportunities/groups/${g!.id}`, headers,
    payload: { ...payload, name: "运检群", webhook: "", secret: "", reason: "改名" } })).statusCode, 200);
  const [kept] = await sql<{ name: string; secret: string }[]>`SELECT name, secret FROM opp_push_groups WHERE id = ${g!.id}`;
  assert.deepEqual({ ...kept }, { name: "运检群", secret: "SEC-second" });
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/opportunities/groups/${g!.id}/delete`, headers, payload: { reason: "测试完" } })).statusCode, 200);
  assert.equal((await sql`SELECT 1 FROM opp_pushes WHERE key LIKE ${`${second}:%`}`).length, 0);
});

test("the daily digest lists projects whose file deadline is within 3 days, once a day", async () => {
  const id = "ecp-1002_2018032900295987";
  const now = new Date("2099-01-03T00:00:00Z");
  assert.deepEqual(await pushDigest(now), { [main]: "sent" });
  const msg = sent.at(-1)!;
  assert.match(msg.title, /^投标商机日报 2099-01-03$/);
  assert.ok(msg.text.includes("3 天内截止"));
  assert.ok(msg.text.includes(sitePage(`/opportunities/${id}#item-`).replace(/&pc_slide=true$/, "")), "links open inside DingTalk");
  assert.deepEqual(await pushDigest(now), { [main]: "skipped" }, "one digest a day");
});

test("site and admin APIs: members read the list and details, only admins change the business profile", async () => {
  const list = await app.inject({ url: "/api/site/opportunities?view=focus", headers: { cookie: adminCookie } });
  assert.equal(list.statusCode, 200, list.body);
  const body = list.json();
  assert.ok(body.items.length > 0);
  assert.ok(body.items.every((i: { verdict: string }) => i.verdict === "relevant" || i.verdict === "maybe"));
  assert.deepEqual(body.lines, DEFAULT_PROFILE.lines.map((l) => l.name));
  const card = body.items.find((i: { projectName: string; source: string }) => i.source === "ecp" && i.projectName.includes("视频监控"));
  assert.equal(card.ceilingKind, "amount_wan");
  assert.equal(card.fileDeadline, "2099-01-05 09:00:00");
  assert.equal(card.bidDeadline, "2099-01-08 09:30");
  assert.equal(card.noticeBudget, "120 万元");
  assert.equal(card.sourceName, "国网电子商务平台");
  assert.equal(card.expired, false);

  const detail = await app.inject({ url: `/api/site/opportunities/${card.noticeId}`, headers: { cookie: adminCookie } });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items.length, 2);
  assert.equal(detail.json().others.length, 2);
  assert.deepEqual(detail.json().items[0].evidence, [{ file: "需求一览表.xlsx", sheet: "零星项目-服务", row: 4 }]);
  const details = detail.json().notice.details;
  assert.deepEqual([details.budget, details.consortium, details.times.bidDeadline, details.times.signupDeadline], ["120 万元", "不接受联合体", "2099-01-08 09:30", ""]);
  assert.deepEqual(details.requirements.map((r: { kind: string }) => r.kind), ["qualification", "performance"]);
  assert.equal((await app.inject({ url: "/api/site/opportunities/ecp-missing", headers: { cookie: adminCookie } })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/site/opportunities" })).statusCode, 401, "the site is internal");

  const headers = adminHeaders();
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
