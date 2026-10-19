// 政策规划库：模型给的原话、文号、日期、发文单位要能在原文里查到，查不到的丢掉；同一份文件先来报道、
// 后来原文时，要素换成原文的，文号日期只补不丢；不是政策规划文件的资料只记一笔，不进库；列表按层级和 AI 程度筛选。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { ExtractSchema, cleanTitle, docKey, ground, isTarget, storeDocument, type Extracted } from "../backend/extract.ts";
import { listPolicies, loadPolicy } from "../backend/read.ts";

const T = tag();
const SOURCE = `policy-test-${T}`;
const BODY = "国家电网有限公司印发《关于深化推进“人工智能+”专项行动的意见》（国家电网科〔2025〕88号）。2025年12月10日发布。到2027年，智能体应用普及率超80%。加快光明电力大模型迭代升级，推进智能体在调度运行中的应用。";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags) VALUES (${SOURCE}, '国家电网', 'rss', 'T1', 'editorial', ${["政策规划"]})`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

let n = 0;
async function article(title: string, body = BODY): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/policy-${T}-${n}`, title, bodyText: body, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  return articleId;
}

const base = (over: Partial<Extracted> = {}): Extracted => ExtractSchema.parse({
  isDocument: true, role: "report", documentName: `关于深化推进“人工智能+”专项行动的意见 ${T}`, docType: "指导意见", level: "sgcc",
  issuers: ["国家电网有限公司"], docNo: "国家电网科〔2025〕88号", issuedOn: "2025-12-10", summary: "摘要",
  targets: [{ metric: "智能体应用普及率", value: "超80%", year: "2027", quote: "到2027年，智能体应用普及率超80%。" }],
  tasks: [{ text: "大模型迭代", quote: "加快光明电力大模型迭代升级" }],
  aiClauses: [{ text: "调度智能体", quote: "推进智能体在调度运行中的应用" }],
  aiRelevance: "core", ...over,
});

test("only what the original text says is kept", () => {
  const got = ground(base({
    docNo: "国家电网科〔2025〕99号", issuedOn: "2025-12-11", issuers: ["国家电网有限公司", "国家能源局", " "],
    targets: [
      { metric: "智能体应用普及率", value: "超80%", year: "2027", quote: "到2027年，智能体应用普及率超80%。" },
      { metric: "年份不在原话里", value: "超80%", year: "2030", quote: "智能体应用普及率超80%。" },
      { metric: "普及率", value: "超90%", year: "2030", quote: "到2030年，智能体应用普及率超90%。" },
      { metric: "数值不在原话里", value: "超95%", year: "2027", quote: "到2027年，智能体应用普及率超80%。" },
    ],
    tasks: [{ text: "拼接的原话", quote: "加快光明电力大模型…推进智能体" }],
  }), { title: "标题", body: BODY, source: "国家电网" });
  assert.equal(got.docNo, null, "a document number the text does not carry");
  assert.equal(got.issuedOn, null, "a date the text does not carry");
  assert.deepEqual(got.issuers, ["国家电网有限公司"], "a blank issuer is not in every source name");
  assert.deepEqual(got.targets.map((t) => [t.value, t.year]), [["超80%", "2027"], ["超80%", null]], "a year the quote does not carry");
  assert.deepEqual(got.tasks, []);
  assert.equal(got.documentName, null, "a name the text does not carry is not a merge key");
  const named = ground(base({ documentName: "《关于深化推进“人工智能+”专项行动的意见》" }), { title: "标题", body: BODY, source: "国家电网" });
  assert.equal(named.documentName, "《关于深化推进“人工智能+”专项行动的意见》");
  assert.equal(ground(base({ documentName: "工作会议" }), { title: "标题", body: `${BODY}工作会议`, source: "" }).documentName, null, "too short to tell documents apart");
  const kept = ground(base(), { title: "标题", body: BODY.replace(/\s/g, " "), source: "国家电网" });
  assert.equal(kept.docNo, "国家电网科〔2025〕88号");
  assert.equal(kept.issuedOn, "2025-12-10", "a date written 2025年12月10日 in the text");
});

test("a report then the original: one document, the original's fields, the number kept", async () => {
  const report = await article(`国网深化推进人工智能+专项行动 ${T}`);
  const named = BODY.replace("专项行动的意见》", `专项行动的意见 ${T}》`);
  const docId = await storeDocument(report, "报道标题", ground(base({ summary: "报道摘要", docNo: "国家电网科〔2025〕88号" }), { title: "", body: named, source: "" }), null);
  const original = await article(`关于深化推进人工智能+专项行动的意见 ${T}`);
  const again = await storeDocument(original, "原文标题", { ...base({ role: "original", summary: "原文摘要", documentName: `《关于深化推进“人工智能+”专项行动的意见 ${T}》` }), docNo: null }, null);
  assert.equal(again, docId, "the same document under its name with or without 书名号");
  const doc = await loadPolicy(docId!);
  assert.equal(doc!.summary, "原文摘要");
  assert.equal(doc!.docNo, "国家电网科〔2025〕88号", "a number found earlier is not lost");
  assert.deepEqual(doc!.reports.map((r) => r.role), ["original", "report"]);
  const later = await article(`又一篇报道 ${T}`);
  await storeDocument(later, "又一篇", base({ summary: "后来的报道摘要" }), null);
  assert.equal((await loadPolicy(docId!))!.summary, "原文摘要", "a report does not replace the original's fields");
});

test("not a document: recorded once, nothing in the library; lists filter by level and AI", async () => {
  const news = await article(`保供电新闻 ${T}`, "国庆期间保供电工作平稳。");
  assert.equal(await storeDocument(news, "保供电新闻", null, null), null);
  assert.equal((await sql`SELECT outcome FROM policy_links WHERE article_id = ${news}`)[0]!.outcome, "not_document");
  const csg = await article(`南网规划 ${T}`);
  await storeDocument(csg, "南网规划", base({ documentName: `南网数字电网规划 ${T}`, level: "csg", aiRelevance: "none", targets: [] }), null);
  const names = async (f: Parameters<typeof listPolicies>[0]) => (await listPolicies(f)).docs.map((d) => d.name).filter((x) => x.includes(T));
  assert.deepEqual(await names({ level: "csg" }), [`南网数字电网规划 ${T}`]);
  assert.ok(!(await names({ ai: "any" })).includes(`南网数字电网规划 ${T}`));
  assert.ok((await listPolicies({})).targets.some((t) => t.value === "超80%"), "the national and grid targets table");
  assert.equal(docKey("《A·B 规划》"), docKey("AB规划"));
  assert.equal(docKey("国家发展改革委 国家能源局关于推进“人工智能+”能源高质量发展的实施意见"), docKey("关于推进“人工智能+”能源高质量发展的实施意见"));
  assert.equal(docKey("四部门印发《关于促进人工智能与能源双向赋能的行动方案》的通知"), docKey("关于促进人工智能与能源双向赋能的行动方案"));
});

test("targets have numbers; deadlines are not targets; the grid named decides the level; site suffixes are dropped", () => {
  assert.ok(isTarget({ metric: "智能体应用普及率", value: "超80%" }));
  assert.ok(isTarget({ metric: "专业大模型", value: "五个以上" }));
  assert.ok(!isTarget({ metric: "专用技术水平", value: "世界领先水平" }));
  assert.ok(!isTarget({ metric: "推荐材料报送截止时间", value: "2026年11月16日前" }));
  const csg = ground(base({ level: "sgcc", documentName: null, issuers: [] }), { title: "南方电网以人工智能驱动“六网”协同探路", body: BODY, source: "中国能源新闻网" });
  assert.equal(csg.level, "csg");
  assert.equal(cleanTitle("南方电网以人工智能驱动“六网”协同探路--中国能源新闻网"), "南方电网以人工智能驱动“六网”协同探路");
  assert.equal(cleanTitle("以算电协同赋能新型能源体系---国家能源局"), "以算电协同赋能新型能源体系");
  assert.equal(cleanTitle("南方电网人工智能赋能新型电力系统高质量发展——中国新闻网・广东"), "南方电网人工智能赋能新型电力系统高质量发展");
});
