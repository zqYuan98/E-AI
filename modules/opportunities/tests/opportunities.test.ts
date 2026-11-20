// 投标商机：采集服务发现的公告第一轮只入库不推送；之后的新公告取附件、拆项目、按业务口径筛（排除词直接无关，
// 其余交给模型；模型出错时按关键词记待确认），从公告正文抽出预算、时间和资格业绩要求（原话核对不上的去掉），
// 每个项目的资质、业绩、人员要求和后台“我司资质”逐条比对出匹配度；早晚两期信息表把每个群还没收到过的项目推一次且只一次
// （各群按自己选的方向和平台，@ 关注这些方向的提醒人），并提醒 48 小时内截止的。
// 其他招采平台的资料一条一个项目、按平台分开，结果类公告不收。
// 采集服务、模型和钉钉都是本地替身，不访问外部服务。
import { pointModels, Reply, stub } from "../../../tests/setup.ts";
import { createServer } from "node:http";
import { inflateRawSync } from "node:zlib";
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
import { formatCeiling, pushSheet, sheetSlot, sitePage } from "../backend/push.ts";
import { appliesTo, isBoilerplate, itemRequirements, splitCombined, summarize } from "../backend/requirements.ts";
import { deadlineAt, isExpired, packageLabel, platformOf } from "../backend/store.ts";
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

// 模型替身：筛选时数据分析平台“待确认”、视频监控“相关”、其余“无关”；抽要素时给出 DETAILS（其中两条原话编造或对不上）；
// 比对资质时资质“满足”、业绩“需核实”、人员“不满足”。modelDown 时返回 503。
let modelDown = false;
const prompts: string[] = [];
const answer = (content: unknown) => ({ id: "stub", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const model = await stub(async (_hit, req) => {
  if (modelDown) return new Reply(503, { error: { message: "down" } });
  const user = JSON.parse(req.body).messages.at(-1).content as string;
  prompts.push(user);
  if (user.includes("【公告】")) return answer(DETAILS);
  if (user.includes("【我司资质】")) {
    const [ours, projects] = user.split("【项目】\n") as [string, string];
    const entities = ours.split(/\n\n(?=主体\d+：)/).slice(1).map((b) => ({ n: Number(/^主体(\d+)：/.exec(b)![1]), text: b }));
    const having = (word: string) => entities.filter((e) => e.text.includes(word)).map((e) => e.n);
    return answer({ items: projects.split(/\n\n(?=#\d+ 项目：)/).map((b) => ({
      n: Number(/^#(\d+)/.exec(b)![1]),
      checks: [...b.matchAll(/^(\d+)\. \[(资质|业绩|人员)\]/gm)].map(([, r, kind]) => kind === "资质"
        ? { r: Number(r), met: having("专业承包一级"), unmet: having("专业承包二级"), note: "博创有电子与智能化一级" }
        : { r: Number(r), met: [], unmet: [], note: "清单未列同类业绩" }),
    })) });
  }
  const items = [...user.matchAll(/#(\d+) 项目：(.+)/g)].map(([, n, name]) => ({
    n: Number(n),
    verdict: name!.includes("视频监控") ? "相关" : name!.includes("数据分析") ? "待确认" : "无关",
    line: name!.includes("视频监控") ? "智能运检与监测" : name!.includes("数据分析") ? "数字化与信息系统" : "",
    why: name!.includes("视频监控") ? "主体是视频监控系统运维" : "主体不是业务方向",
  }));
  return answer({ items });
});
pointModels(model.url, ["deepseek-flash"]);
process.env.OPPORTUNITIES_MODEL = "deepseek-flash";
process.env.OPPORTUNITIES_FETCHER_URL = `http://127.0.0.1:${(fetcher.address() as { port: number }).port}`;
process.env.OPPORTUNITIES_FETCHER_TOKEN = TOKEN;
process.env.DINGTALK_PUSH_ENABLED = "true";
const ROBOT = (token: string) => `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
const MAIN_TOKEN = "abcdef0123456789abcdef0123";

const ms = (d: string) => new Date(`${d}T00:00:00+08:00`).getTime();
const YIDA_RECORDS = [
  { formInstanceId: "FINST-1", formData: { selectField_kind: "资质", textField_name: "电子与智能化工程专业承包一级", selectField_company: "安徽博创信息科技有限公司", cascadeDateField_valid: [ms("2025-01-01"), ms("2099-12-31")] } },
  { formInstanceId: "FINST-2", formData: { selectField_kind: "资质", textField_name: "电子与智能化工程专业承包二级", selectField_company: "安徽博诺思信息科技有限公司", cascadeDateField_valid: [ms("2025-01-01"), ms("2099-12-31")] } },
  { formInstanceId: "FINST-3", formData: { selectField_kind: "资质", textField_name: "CMMI3级", selectField_company: "安徽博创信息科技有限公司", cascadeDateField_valid: [ms("2017-01-01"), ms("2020-01-01")] } },
  { formInstanceId: "FINST-4", formData: { selectField_kind: "荣誉", textField_name: "高新技术企业", selectField_company: "安徽博诺思信息科技有限公司" } },
];
const yidaCalls: string[] = [];
function yida(url: string, init?: RequestInit): Response {
  const path = new URL(url).pathname;
  yidaCalls.push(path);
  if (path === "/v1.0/oauth2/accessToken") return Response.json({ accessToken: "yida-test-token", expireIn: 7200 });
  if ((init?.headers as Record<string, string>)["x-acs-dingtalk-access-token"] !== "yida-test-token") return Response.json({ code: "InvalidAuthentication" }, { status: 401 });
  if (path === "/v1.0/yida/forms/formFields") {
    return Response.json({ result: [{ fieldId: "selectField_kind", label: { zh_CN: "类型" } }, { fieldId: "textField_name", label: "资质/荣誉名称" },
      { fieldId: "selectField_company", label: "所属公司" }, { fieldId: "cascadeDateField_valid", label: JSON.stringify({ zh_CN: "有效期", type: "i18n" }) }] });
  }
  const body = JSON.parse(String(init?.body)) as { systemToken: string; formUuid: string; currentPage: number };
  assert.deepEqual([body.systemToken, body.formUuid], ["yida-system-token", "FORM-TEST"]);
  return Response.json({ totalCount: YIDA_RECORDS.length, currentPage: body.currentPage, data: body.currentPage === 1 ? YIDA_RECORDS : [] });
}

// 钉钉替身：截下发往 oapi.dingtalk.com 的请求，其余照常。
const sent: Array<{ url: string; title: string; text: string; at: string[] }> = [];
let dingtalk: "ok" | "reject" | "offline" = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.dingtalk.com/")) return yida(url, init);
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
/** 每次推信息表用不同的一期（2090 年起每天早间一期），各期的防重复记录互不干扰。 */
let day = 0;
const nextSlot = () => new Date(Date.UTC(2090, 0, 1 + day++, 1, 0));

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

/** 从导出的 .xlsx（zip）里取出一个文件的文字。 */
function unzipText(buf: Buffer, name: string): string {
  for (let p = 0; p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50;) {
    const size = buf.readUInt32LE(p + 18), nameLen = buf.readUInt16LE(p + 26), extra = buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extra;
    if (buf.toString("utf8", p + 30, p + 30 + nameLen) === name) return inflateRawSync(buf.subarray(start, start + size)).toString("utf8");
    p = start + size;
  }
  throw new Error(`${name} is not in the file`);
}

const verdicts = async (id: string) => Object.fromEntries((await sql<{ package: string; verdict: string; matched_by: string }[]>`
  SELECT package, verdict, matched_by FROM opp_items WHERE notice_id = ${id} ORDER BY ordinal`).map((r) => [r.package, `${r.verdict}/${r.matched_by}`]));

test("the first round is stored and screened but never pushed; later notices go into the next sheet once, with the same facts for every project", async () => {
  listed = [notice("1001", "存量批次")];
  await discoverCycle();
  const [first] = await sql<{ backfill: boolean; status: string; screened: boolean }[]>`SELECT backfill, status, screened FROM opp_notices WHERE id = 'ecp-1001_2018032900295987'`;
  assert.deepEqual(first, { backfill: true, status: "parsed", screened: true });

  listed = [notice("1002", "新批次"), ...listed];
  await discoverCycle();
  assert.deepEqual(await verdicts("ecp-1002_2018032900295987"), {
    包1: "relevant/model", 包2: "irrelevant/exclude", 包3: "irrelevant/model", 包4: "maybe/model",
  });
  assert.ok(!prompts.some((p) => p.includes("食堂")), "excluded projects never reach the model");
  assert.equal(sent.length, 0, "nothing is pushed between the morning and evening sheets");

  const slot = nextSlot();
  assert.deepEqual(await pushSheet(slot), { [main]: "sent" });
  assert.equal(sent.length, 1);
  const msg = sent[0]!;
  assert.match(msg.url, /&timestamp=\d+&sign=/);
  assert.equal(msg.title, "盲投信息表 2090-01-01 早间（2 项）");
  for (const fact of ["新筛出 **2** 个项目（相关 1，待确认 1）", "**1. [示例供电公司营业厅视频监控系统设备运维服务](", "**2. [示例数据分析平台开发](",
    "（待确认）", "采购人：国网示例供电公司 ｜ 地区：示例市 ｜ 限价：29.7 万元", "限价：折扣率 98%", "时间：获取截止 01-05 09:00 ｜ 投标截止 01-08 09:30",
    "资质：电子与智能化工程专业承包二级及以上资质", "业绩：具有同类服务业绩；近三年不少于2个视频监控系统运维业绩", "人员：公告未写明",
    "匹配度：没有我司资质 ｜ 国网电子商务平台",
    sitePage(`/opportunities?sheet=${encodeURIComponent(`${main}:sheet:2090-01-01:am`)}`),
    "dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Finside.invalid%2Fopportunities%2Fecp-1002_2018032900295987%23item-"]) assert.ok(msg.text.includes(fact), fact);
  assert.ok(!msg.text.includes("食堂") && !msg.text.includes("导线"), "irrelevant projects are not pushed");
  assert.ok(!msg.text.includes("项目经理"), "details whose quote is not in the notice are dropped");
  assert.ok(!msg.text.includes("主体是视频监控系统运维"), "the screening reason is not shown");
  assert.ok(!msg.text.includes("ecp-1001_"), "the backlog found on the first round is not pushed");
  assert.deepEqual(await pushSheet(slot), { skipped: "nothing due" }, "one sheet per group per slot");

  await discoverCycle();
  await processCycle();
  assert.equal(fetched.filter((u) => u === URL_OF("1002")).length, 1, "an attachment is fetched once");
  await pushSheet(nextSlot());
  assert.match(sent.at(-1)!.text, /上次推送以来没有新筛出的项目/, "a notice is listed in one sheet only");
  assert.deepEqual(sent.at(-1)!.at, [], "an empty sheet @s nobody");
});

test("when the model is down a notice waits for it; after 6 hours names hitting a keyword come as 待确认", async () => {
  modelDown = true;
  listed = [notice("2001", "模型不可用时的批次"), ...listed];
  await discoverCycle();
  const [waiting] = await sql<{ screened: boolean; screen_failures: number }[]>`SELECT screened, screen_failures FROM opp_notices WHERE id = 'ecp-2001_2018032900295987'`;
  assert.deepEqual(waiting, { screened: false, screen_failures: 1 });
  await pushSheet(nextSlot());
  assert.ok(!sent.at(-1)!.text.includes("ecp-2001_"), "a notice waiting for the model is not in the sheet");

  await sql`UPDATE opp_notices SET fetched_at = now() - interval '7 hours' WHERE id = 'ecp-2001_2018032900295987'`;
  await processCycle();
  assert.deepEqual(await verdicts("ecp-2001_2018032900295987"), {
    包1: "maybe/keyword", 包2: "irrelevant/exclude", 包3: "irrelevant/keyword", 包4: "maybe/keyword",
  });
  await pushSheet(nextSlot());
  assert.match(sent.at(-1)!.text, /新筛出 \*\*2\*\* 个项目（相关 0，待确认 2）/);
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

test("a rejected sheet is retried within its slot, a sheet of unknown outcome is not; what was not delivered rolls into the next one", async () => {
  dingtalk = "reject";
  listed = [notice("4001", "推送被拒"), ...listed];
  await discoverCycle();
  const rejectedSlot = nextSlot();
  const key = `${main}:sheet:${sheetSlot(rejectedSlot).date}:am`;
  assert.deepEqual(await pushSheet(rejectedSlot), { [main]: "failed" });
  const [rejected] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = ${key}`;
  assert.deepEqual(rejected, { status: "failed", attempts: 1 });
  assert.equal((await sql`SELECT 1 FROM opp_pushes WHERE key = ${`${main}:notice:ecp-4001_2018032900295987`}`).length, 0, "not delivered yet");
  dingtalk = "ok";
  assert.deepEqual(await pushSheet(rejectedSlot, { retry: true }), { [main]: "sent" });
  const [retried] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM opp_pushes WHERE key = ${key}`;
  assert.deepEqual(retried, { status: "sent", attempts: 2 });
  assert.ok(sent.at(-1)!.text.includes("ecp-4001_"));
  assert.deepEqual(await pushSheet(rejectedSlot, { retry: true }), { skipped: "nothing due" }, "a sent sheet is not retried");

  dingtalk = "offline";
  listed = [notice("4002", "推送结果不明"), ...listed];
  await discoverCycle();
  const unknownSlot = nextSlot();
  assert.deepEqual(await pushSheet(unknownSlot), { [main]: "unknown" });
  dingtalk = "ok";
  const before = sent.length;
  assert.deepEqual(await pushSheet(unknownSlot, { retry: true }), { skipped: "nothing due" });
  assert.equal(sent.length, before, "an outcome we cannot know is not resent");
  await pushSheet(nextSlot());
  assert.ok(!sent.at(-1)!.text.includes("ecp-4002_"), "a notice that may have arrived is not listed again");
});

test("tender notices from other platforms join as one project each, split by platform: results are skipped, screened in a batch, 待确认 stays in the list", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at) VALUES
    ('opp-csg-tender', '南方电网供应链·招标公告', 'rss', 'T1', 'editorial', ${["招标", "南网"]}, '2100-01-01'),
    ('opp-csg-result', '南方电网供应链·中标候选人公示', 'rss', 'T1', 'editorial', ${["中标", "南网"]}, '2100-01-01'),
    ('opp-pc-tender', '中国电建阳光采购网·招采公告', 'rss', 'T1', 'editorial', ${["招标", "中国电建"]}, '2100-01-01')`;
  const add = async (sourceId: string, n: string, title: string, bodyText: string) =>
    (await upsertMaterial({ sourceId, url: `https://example.com/opp-${n}`, title, bodyText, bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
  const backlog = await add("opp-csg-tender", "0", "示例供电局存量视频监控项目招标公告", TEXT);
  await processCycle();
  const [first] = await sql<{ backfill: boolean; screened: boolean }[]>`SELECT backfill, screened FROM opp_notices WHERE id = ${`web-${backlog}`}`;
  assert.deepEqual(first, { backfill: true, screened: true }, "what is already there the first time is stored, not pushed");

  const prompted = prompts.length;
  const ids = {
    hit: await add("opp-csg-tender", "1", "示例供电局视频监控平台采购项目招标公告", TEXT),
    maybe: await add("opp-csg-tender", "2", "示例供电局数据分析平台采购公告", "采购数据分析平台一套。"),
    excluded: await add("opp-csg-tender", "3", "示例供电局办公楼保洁服务招标公告", "保洁服务。"),
    result: await add("opp-csg-tender", "4", "示例供电局视频监控平台采购项目中标结果公告", "中标人：某公司。"),
    candidates: await add("opp-csg-result", "5", "示例视频监控项目中标候选人公示", "第一中标候选人：某公司。"),
    powerchina: await add("opp-pc-tender", "6", "某电建工程视频监控系统采购公告", TEXT),
  };
  await processCycle();
  const rows = await sql<{ id: string; verdict: string; matched_by: string }[]>`
    SELECT n.id, i.verdict, i.matched_by FROM opp_notices n JOIN opp_items i ON i.notice_id = n.id WHERE n.source = 'web' AND NOT n.backfill`;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, `${r.verdict}/${r.matched_by}`])), {
    [`web-${ids.hit}`]: "relevant/model", [`web-${ids.maybe}`]: "maybe/model", [`web-${ids.excluded}`]: "irrelevant/exclude",
    [`web-${ids.powerchina}`]: "relevant/model",
  }, "results and candidate lists are not opportunities");
  assert.equal(prompts.slice(prompted).filter((p) => p.includes("#2 项目：") && !p.includes("【我司资质】")).length, 1, "the platforms' items are screened in one batch");

  await pushSheet(nextSlot());
  const msg = sent.at(-1)!;
  for (const fact of ["示例供电局视频监控平台采购项目招标公告", "某电建工程视频监控系统采购公告", "南方电网供应链·招标公告", "中国电建阳光采购网·招采公告",
    "投标截止 01-08 09:30", "限价：预算 120 万元", "资质：电子与智能化工程专业承包二级及以上资质", sitePage(`/opportunities/web-${ids.hit}#item-`).replace(/&pc_slide=true$/, "")]) {
    assert.ok(msg.text.includes(fact), fact);
  }
  assert.ok(!msg.text.includes("数据分析平台采购公告"), "待确认 from other platforms waits for the list");

  const list = (await app.inject({ url: `/api/site/opportunities?source=${encodeURIComponent("南方电网供应链")}`, headers: { cookie: adminCookie } })).json();
  assert.deepEqual(list.items.map((i: { noticeId: string }) => i.noticeId).sort(), [`web-${ids.hit}`, `web-${ids.maybe}`, `web-${backlog}`].sort(), "one platform only");
  assert.deepEqual(list.platforms[0], { key: "ecp", label: "国网电子商务平台" }, "SGCC first");
  for (const p of ["南方电网供应链", "中国电建阳光采购网"]) assert.ok(list.platforms.some((x: { key: string; label: string }) => x.key === p && x.label === p), p);
  const card = list.items.find((i: { noticeId: string }) => i.noticeId === `web-${ids.hit}`);
  assert.deepEqual([card.sourceName, card.platform, card.bidDeadline, card.noticeBudget], ["南方电网供应链·招标公告", "南方电网供应链", "2099-01-08 09:30", "120 万元"]);
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

test("each group gets only the directions and platforms it chose, from when it was added, and @s the people who follow them", async () => {
  const headers = adminHeaders();
  const payload = {
    name: "运检方向群", webhook: ROBOT("0123456789abcdef0123456789"), secret: "SEC-second", includeMaybe: false,
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

  listed = [notice("7001", "分群推送批次"), ...listed];
  await discoverCycle();
  const before = sent.length;
  const result = await pushSheet(nextSlot());
  assert.deepEqual(result, { [main]: "sent", [second]: "sent" });
  const mine = sent.slice(before);
  const toMain = mine.find((m) => m.url.includes(MAIN_TOKEN))!;
  const toSecond = mine.find((m) => !m.url.includes(MAIN_TOKEN))!;
  assert.ok(toMain.text.includes("ecp-7001_") && toMain.text.includes("示例数据分析平台开发"), "the group without filters also gets 待确认");
  assert.deepEqual(toMain.at, [], "a group without people @s nobody");
  assert.match(toSecond.text, /新筛出 \*\*1\*\* 个项目（相关 1）/);
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
  assert.deepEqual([shown.sent, shown.webhookHint, shown.sources], [1, "…456789", ["ecp"]]);
  assert.deepEqual(admin.json().notices.find((n: { id: string }) => n.id === "ecp-7001_2018032900295987").pushedGroups, ["商务部投标群", "运检方向群"]);

  // 修改时 Webhook 和密钥留空沿用原来的；删掉群连同它的推送记录。
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/opportunities/groups/${g!.id}`, headers,
    payload: { ...payload, name: "运检群", webhook: "", secret: "", reason: "改名" } })).statusCode, 200);
  const [kept] = await sql<{ name: string; secret: string }[]>`SELECT name, secret FROM opp_push_groups WHERE id = ${g!.id}`;
  assert.deepEqual({ ...kept }, { name: "运检群", secret: "SEC-second" });
  assert.equal((await app.inject({ method: "POST", url: `/api/admin/opportunities/groups/${g!.id}/delete`, headers, payload: { reason: "测试完" } })).statusCode, 200);
  assert.equal((await sql`SELECT 1 FROM opp_pushes WHERE key LIKE ${`${second}:%`}`).length, 0);
});

test("the sheet reminds of projects sent before whose deadline is within 48 hours", async () => {
  const now = new Date("2099-01-04T01:00:00Z");
  assert.deepEqual(await pushSheet(now), { [main]: "sent" });
  const msg = sent.at(-1)!;
  assert.match(msg.title, /^盲投信息表 2099-01-04 早间/);
  assert.ok(msg.text.includes("48 小时内截止（之前推过）"));
  assert.ok(msg.text.includes(sitePage("/opportunities/ecp-1002_2018032900295987#item-").replace(/&pc_slide=true$/, "")), "links open inside DingTalk");
});

test("qualifications sync from 宜搭; each project is matched per company and the best one is suggested, in the list, the export and the sheet page", async () => {
  const headers = adminHeaders();
  const sync = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/admin/opportunities/qualifications/sync", headers, payload: body });
  assert.equal((await sync({ dryRun: true })).statusCode, 400, "not configured yet");
  Object.assign(process.env, {
    DINGTALK_APP_KEY: "ding-test-key", DINGTALK_APP_SECRET: "ding-test-secret", YIDA_APP_TYPE: "APP_TEST",
    YIDA_SYSTEM_TOKEN: "yida-system-token", YIDA_USER_ID: "u-1", YIDA_QUALIFICATION_FORM: "FORM-TEST",
  });
  const preview = await sync({ dryRun: true });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json().fields, {
    类型: "selectField_kind（类型）", "资质/荣誉名称": "textField_name（资质/荣誉名称）", 所属公司: "selectField_company（所属公司）", 有效期: "cascadeDateField_valid（有效期）",
  });
  assert.deepEqual(preview.json().sample[0], { id: "FINST-1", company: "安徽博创信息科技有限公司", kind: "资质", name: "电子与智能化工程专业承包一级", validFrom: "2025-01-01", validTo: "2099-12-31" });
  assert.equal((await sql`SELECT 1 FROM opp_company_quals`).length, 0, "a dry run stores nothing");
  const synced = await sync({ reason: "测试" });
  assert.equal(synced.statusCode, 200, synced.body);
  assert.equal((await sql`SELECT 1 FROM opp_company_quals`).length, 4);
  assert.ok(!yidaCalls.some((c) => c.includes("save") || c.includes("update")), "only reads 宜搭");

  const save = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/admin/opportunities/company", headers, payload: body });
  assert.equal((await save({ personnel: ["高级工程师 5 人"], performance: [], other: [] })).statusCode, 400, "every line names its company");
  assert.equal((await save({ personnel: ["博创：高级工程师 5 人"], performance: [], other: [], reason: "测试" })).statusCode, 200);

  const matchPrompts = () => prompts.filter((p) => p.includes("【我司资质】"));
  for (let k = 0; k < 6; k++) await processCycle();
  assert.ok(matchPrompts().length > 0);
  const prompt = matchPrompts()[0]!;
  assert.match(prompt, /主体1：安徽博创信息科技有限公司\n资质证书：\n- 电子与智能化工程专业承包一级（有效期至 2099-12-31）\n人员证书：\n- 高级工程师 5 人/);
  assert.match(prompt, /主体2：安徽博诺思信息科技有限公司\n资质证书：\n- 电子与智能化工程专业承包二级（有效期至 2099-12-31）\n- 高新技术企业（荣誉）\n人员证书：（未填写）/);
  assert.ok(!prompt.includes("CMMI3级"), "an expired certificate does not count");
  assert.ok(prompt.includes("[资质] 电子与智能化工程专业承包二级及以上资质"));

  const listed = async () => (await app.inject({ url: "/api/site/opportunities?source=ecp", headers: { cookie: adminCookie } })).json().items
    .find((i: { noticeId: string; projectName: string }) => i.noticeId === "ecp-1002_2018032900295987" && i.projectName.includes("视频监控"));
  const card = await listed();
  assert.deepEqual(card.match, {
    company: "安徽博创信息科技有限公司", met: 1, unmet: 0, unknown: 2, level: "medium",
    entities: [{ company: "安徽博创信息科技有限公司", met: 1, unmet: 0, unknown: 2 }, { company: "安徽博诺思信息科技有限公司", met: 0, unmet: 1, unknown: 2 }],
  }, "one company's certificate never covers another; the one that falls short least is suggested");
  assert.deepEqual(card.requirements.map((r: { group: string; from: string; status: string }) => [r.group, r.from, r.status]),
    [["qualification", "notice", "met"], ["performance", "item", "unknown"], ["performance", "notice", "unknown"]]);
  const asked = matchPrompts().length;
  await processCycle();
  assert.equal(matchPrompts().length, asked, "matched projects are not asked again while our qualifications stay the same");

  const exported = await app.inject({ url: "/api/site/opportunities/export.xlsx?source=ecp", headers: { cookie: adminCookie } });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers["content-type"]), /spreadsheetml\.sheet/);
  const cells = unzipText(exported.rawPayload, "xl/worksheets/sheet1.xml");
  for (const fact of ["项目名称（点开看详情）", "[满足] 电子与智能化工程专业承包二级及以上资质", "中，建议博创（满足 1，需核实 2）", "获取 2099-01-05 09:00\n投标 2099-01-08 09:30", "<pane ySplit=\"1\""]) {
    assert.ok(cells.includes(fact), fact);
  }
  assert.ok(unzipText(exported.rawPayload, "xl/worksheets/_rels/sheet1.xml.rels").includes("https://inside.invalid/opportunities/ecp-1002_2018032900295987#item-"), "the name links to the detail page");
  const fromSheet = await app.inject({ url: `/api/site/opportunities/export.xlsx?sheet=${encodeURIComponent(`${main}:sheet:2090-01-01:am`)}`, headers: { cookie: adminCookie } });
  assert.match(String(fromSheet.headers["content-disposition"]), /filename\*=UTF-8''%E7%9B%B2%E6%8A%95%E4%BF%A1%E6%81%AF%E8%A1%A8-2090-01-01-%E6%97%A9%E9%97%B4\.xlsx/);

  const sheet = (await app.inject({ url: `/api/site/opportunities?sheet=${encodeURIComponent(`${main}:sheet:2090-01-01:am`)}`, headers: { cookie: adminCookie } })).json();
  assert.equal(sheet.sheet.title, "2090-01-01 早间信息表 · 商务部投标群");
  assert.deepEqual(sheet.items.map((i: { projectName: string }) => i.projectName), ["示例供电公司营业厅视频监控系统设备运维服务", "示例数据分析平台开发"]);
  assert.equal((await app.inject({ url: "/api/site/opportunities?sheet=g1:sheet:bad", headers: { cookie: adminCookie } })).json().items.length, 0);

  // 宜搭里改了：博诺思升到一级，同步后重新比对，两家都满足时满足多的在前。
  YIDA_RECORDS[1]!.formData.textField_name = "电子与智能化工程专业承包一级";
  assert.equal((await sync({ reason: "宜搭更新" })).statusCode, 200);
  for (let k = 0; k < 6; k++) await processCycle();
  assert.deepEqual((await listed()).match.entities.map((e: { unmet: number }) => e.unmet), [0, 0], "re-matched after the sync");
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
  assert.equal(card.platform, "ecp");
  assert.equal(card.expired, false);
  assert.equal(card.reason, undefined, "the screening reason is not shown");
  assert.deepEqual(card.requirements.map((r: { group: string }) => r.group), ["qualification", "performance", "performance"]);

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
  assert.deepEqual(admin.json().company, { personnel: ["博创：高级工程师 5 人"], performance: [], other: [] });
  assert.deepEqual(admin.json().qualifications.rows.map((q: { name: string }) => q.name).sort(),
    ["CMMI3级", "电子与智能化工程专业承包一级", "电子与智能化工程专业承包一级", "高新技术企业"].sort());
  assert.equal(admin.json().qualifications.configured, true);
  assert.ok(!admin.body.includes("yida-system-token"), "the 宜搭 secret stays in the backend");
  assert.ok(admin.json().platforms.some((p: { key: string }) => p.key === "南方电网供应链"));
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

test("requirements: a combined column is split at its 业绩 heading, notice requirements apply to their lots only, platforms come from the source name", () => {
  assert.deepEqual(splitCombined("资质要求：具备电子与智能化二级资质。业绩要求：近三年2个同类业绩"),
    { qualifications: "具备电子与智能化二级资质", performance: "近三年2个同类业绩" });
  assert.deepEqual(splitCombined("近三年业绩：不少于2个"), { qualifications: "近三年业绩：不少于2个", performance: "" }, "only a heading splits");
  assert.equal(appliesTo(["包1"], { package: "包1", package_name: "" }), true);
  assert.equal(appliesTo(["1"], { package: "包1", package_name: "" }), true);
  assert.equal(appliesTo(["包2"], { package: "包1", package_name: "" }), false);
  assert.equal(appliesTo(["包2"], { package: "", package_name: "" }), true, "a notice that is one project takes every requirement");
  const details = { requirements: [
    { kind: "qualification", text: "C资质", quote: "", lots: ["包2"] },
    { kind: "performance", text: "B业绩", quote: "", lots: [] },
    { kind: "personnel", text: "项目经理一级建造师", quote: "", lots: ["包1"] },
  ] } as unknown as Parameters<typeof itemRequirements>[1];
  const item = { package: "包1", package_name: "", qualifications: "资质要求：A资质。业绩要求：B业绩", performance: "/", personnel: "/" };
  assert.deepEqual(itemRequirements(item, details).map((r) => [r.group, r.text, r.from]),
    [["qualification", "A资质", "item"], ["performance", "B业绩", "item"], ["personnel", "项目经理一级建造师", "notice"]]);
  assert.equal(platformOf({ source: "web", source_name: "三峡集团电子采购平台·采购公告" }), "三峡集团电子采购平台");
  assert.equal(platformOf({ source: "etp", source_name: "" }), "etp");

  // 每份公告都有的套话和“见附件”的指引不列、不比；后面跟着具体资质的长句留着。
  for (const t of ["须取得国家法律、法规、规章规定的有效许可证。", "应答人须取得采购文件要求的国家强制认证证书。", "须取得专业检测机构出具的有效产品试验报告", "须取得国家授权专业检测机构或国际专业权威机构出具的产品有效试验报告。",
    "人员要求按采购公告附件需求一览表提供", "详见招标文件"]) assert.equal(isBoilerplate(t), true, t);
  for (const t of ["具有电子与智能化工程专业承包二级及以上资质", "须取得法律法规规定的有效许可证，并具有承装（修、试）电力设施许可证四级及以上资质，且近三年无重大安全事故",
    "自2021年1月1日至投标截止日，投标人须具有信息系统实施业绩。", "按招标文件要求具有电子与智能化工程专业承包二级资质"]) assert.equal(isBoilerplate(t), false, t);
  assert.deepEqual(itemRequirements({ ...item, qualifications: "须取得国家规定的有效许可证", performance: "B业绩" }, null).map((r) => [r.group, r.text]), [["performance", "B业绩"]]);
});

test("match summary: the company that falls short least is suggested, but none when all companies come out the same", () => {
  const two = (checks: Array<{ met: number[]; unmet: number[] }>) => summarize({ reqs: "x", companies: ["甲公司", "乙公司"], checks: checks.map((c) => ({ ...c, note: "" })) })!;
  assert.deepEqual([two([{ met: [1], unmet: [0] }]).company, two([{ met: [1], unmet: [0] }]).level], ["乙公司", "high"]);
  assert.deepEqual([two([{ met: [], unmet: [] }]).company, two([{ met: [], unmet: [] }]).level], ["", "unknown"], "nothing known about anyone: no suggestion");
  assert.deepEqual([two([{ met: [], unmet: [0, 1] }]).company, two([{ met: [], unmet: [0, 1] }]).level], ["", "low"], "everyone falls short");
  assert.deepEqual([two([{ met: [0, 1], unmet: [] }, { met: [], unmet: [] }]).company, two([{ met: [0, 1], unmet: [] }, { met: [], unmet: [] }]).level], ["", "medium"]);
});
