// 招采申报：定时认要素只认招采类、改过正文会重认；列表只列公开的，可投标按截止排、已截止默认收起；条目页带上要素。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { extractPending } from "../backend/store.ts";
import { listTenders, tenderFactsFor } from "../backend/read.ts";
import { tender } from "../server.ts";

installModules([tender]);
const T = tag();
const SOURCE = `tender-${T}`;
const DAY = 86_400_000;
const now = new Date();
/** “2026年12月3日 9时30分”, Beijing time, `days` from now. */
function cn(days: number): string {
  const d = new Date(now.getTime() + days * DAY + 8 * 3600_000);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 9时30分`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${SOURCE}, '宁夏公共资源交易', 'web_list', 'T1', 'editorial')`;
});
after(async () => { await stopBoss(); await closeDb(); installModules([]); });

async function notice(key: string, title: string, body: string, opts: { category?: string; publishedDaysAgo?: number; visibility?: string } = {}): Promise<string> {
  const id = `${SOURCE}-${key}`;
  const at = new Date(now.getTime() - (opts.publishedDaysAgo ?? 0) * DAY);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, timeline_at, discovered_at)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${title}, ${body}, 'ok', ${at}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, published_at, timeline_at, discovered_at, sort_at, eligible, channel, category, visibility)
    VALUES (${id}, ${SOURCE}, ${title}, '摘要', ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at}, true, 'news', ${opts.category ?? "procurement"}, ${opts.visibility ?? "public"})`;
  return id;
}

let open = "", soon = "", expired = "", award = "", other = "", withdrawn = "";

test("定时认要素：只认招采申报类；正文改过（版本变了）会重新认", async () => {
  open = await notice("open", `银川供电公司布控球采购项目招标公告 ${T}`, `招标人：国网宁夏电力有限公司银川供电公司 投标截止时间：${cn(10)} 预算金额：120万元`);
  soon = await notice("soon", `石嘴山变电站智慧工地采购公告 ${T}`, `采购人：国网宁夏电力有限公司石嘴山供电公司 响应文件提交截止时间：${cn(2)} 预算金额（元）：860000`);
  expired = await notice("expired", `吴忠边缘计算终端采购招标公告 ${T}`, `招标人：吴忠市某某有限公司 投标截止时间：${cn(-10)}`, { publishedDaysAgo: 20 });
  award = await notice("award", `近电预警装置采购中标结果公告 ${T}`, `中标人名称：宁夏某某科技有限公司 中标金额：45.6万元 招标人：国网甘肃省电力公司`, { publishedDaysAgo: 3 });
  other = await notice("other", `国网发布电力大模型 ${T}`, `投标截止时间：${cn(5)}`, { category: "models" });
  withdrawn = await notice("withdrawn", `已撤回的招标公告 ${T}`, `投标截止时间：${cn(5)}`, { visibility: "withdrawn" });

  while ((await extractPending(50)).extracted > 0) { /* drain */ }
  const rows = await sql<{ article_id: string; stage: string | null; region: string | null }[]>`SELECT article_id, stage, region FROM tender_facts WHERE article_id LIKE ${`${SOURCE}-%`}`;
  const byId = new Map(rows.map((r) => [r.article_id, r]));
  assert.ok(!byId.has(other), "其他类别的资料不认");
  assert.equal(byId.get(open)?.stage, "tender");
  assert.equal(byId.get(open)?.region, "宁夏");
  assert.equal(byId.get(award)?.stage, "award");
  assert.equal((await extractPending(50)).extracted, 0, "认过的、没变的不再认");

  await sql`UPDATE articles SET revision = revision + 1, body_text = ${`招标人：国网宁夏电力有限公司银川供电公司 投标截止时间：${cn(12)} 预算金额：150万元`} WHERE id = ${open}`;
  assert.equal((await extractPending(50)).extracted, 1, "改过正文的重新认");
  const facts = await tenderFactsFor(open);
  assert.equal(facts?.amount?.value, 1_500_000);
});

test("可投标：只列公开的、没截止的，截止早的在前；已截止的默认收起，切出来排在后面", async () => {
  const list = await listTenders({ q: T });
  assert.equal(list.view, "open");
  assert.deepEqual(list.rows.map((r) => r.id), [soon, open], "两天后截止的排在前面");
  assert.equal(list.hiddenPast, 1);
  assert.ok(!list.rows.some((r) => r.id === withdrawn), "撤回的不列");
  assert.equal(list.views.find((v) => v.key === "open")?.count, 2);
  assert.equal(list.views.find((v) => v.key === "result")?.count, 1);

  const all = await listTenders({ q: T, past: "1" });
  assert.deepEqual(all.rows.map((r) => r.id), [soon, open, expired]);
  assert.equal(all.hiddenPast, 0);
});

test("结果、地区（重点省份一起选）和关键词", async () => {
  const results = await listTenders({ q: T, view: "result" });
  assert.deepEqual(results.rows.map((r) => r.id), [award]);
  assert.equal(results.rows[0]!.facts.winner, "宁夏某某科技有限公司");
  assert.equal(results.rows[0]!.facts.amount?.value, 456000);

  const focus = await listTenders({ q: T, region: "focus" });
  assert.deepEqual(focus.rows.map((r) => r.id), [soon, open]);
  const elsewhere = await listTenders({ q: T, region: "广东" });
  assert.deepEqual(elsewhere.rows, []);
  const regions = await listTenders({ q: T });
  assert.deepEqual(regions.regions, [{ region: "宁夏", count: 2 }]);

  const byPurchaser = await listTenders({ q: "石嘴山供电公司" });
  assert.ok(byPurchaser.rows.some((r) => r.id === soon), "按采购人也能搜到");
});

test("条目页：招采类公开条目带上“标讯要素”，撤回的和别的类别不带", async () => {
  const found = await loadItemDetail(open);
  assert.equal(found.kind, "found");
  const part = found.kind === "found" ? (found.item.modules?.tender as { deadline: unknown } | undefined) : undefined;
  assert.ok(part?.deadline, "条目页拿到了截止时间");
  assert.equal(await tenderFactsFor(withdrawn), null);
  assert.equal(await tenderFactsFor(other), null);
  await sql`UPDATE publications SET category = 'industry' WHERE article_id = ${soon}`;
  assert.equal(await tenderFactsFor(soon), null, "改了类别就不再当标讯展示");
});

test("改了标签（或信源名）会重新认：阶段跟着变", async () => {
  const id = await notice("retag", `关于开展数字化能力建设工作的通知 ${T}`, `请各单位于${cn(8).replace(/ 9时30分$/, "")}前报送材料。`);
  while ((await extractPending(50)).extracted > 0) { /* drain */ }
  const before = await sql<{ stage: string | null }[]>`SELECT stage FROM tender_facts WHERE article_id = ${id}`;
  assert.equal(before[0]?.stage, null);
  await sql`UPDATE publications SET tags = ${["申报通知"]} WHERE article_id = ${id}`;
  assert.equal((await extractPending(50)).extracted, 1, "标签变了，重新认");
  const after = await sql<{ stage: string | null }[]>`SELECT stage FROM tender_facts WHERE article_id = ${id}`;
  assert.equal(after[0]?.stage, "call");
});

test("已截止的另列一页：没截止的占满一页时，展开后照样看得到已截止的", async () => {
  const key = `bulk-${T}`;
  const at = new Date();
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, timeline_at, discovered_at)
    SELECT ${key} || '-' || i, ${SOURCE}, ${key} || '-' || i, 'https://example.org/' || ${key} || '-' || i, ${key} || ' 招标公告 ' || i, '正文', 'ok', ${at}, ${at}, ${at}
    FROM generate_series(1, 201) AS i`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, published_at, timeline_at, discovered_at, sort_at, eligible, channel, category)
    SELECT id, source_id, title, '摘要', url, published_at, timeline_at, discovered_at, timeline_at, true, 'news', 'procurement' FROM articles WHERE id LIKE ${`${key}-%`}`;
  const deadline = (days: number) => ({ deadline: { value: new Date(at.getTime() + days * DAY).toISOString(), day: false, label: "投标截止", quote: "投标截止时间" } });
  await sql`INSERT INTO tender_facts (article_id, revision, version, basis, stage, region, deadline_at, facts)
    SELECT id, 1, 999, 'fixed', 'tender', NULL, ${new Date(at.getTime() + 5 * DAY)}, ${sql.json({ stage: "tender", ...deadline(5), signup: null, amount: null, purchaser: null, agent: null, winner: null, projectNo: null, region: null } as never)}
    FROM articles WHERE id LIKE ${`${key}-%`} AND id <> ${`${key}-201`}`;
  await sql`INSERT INTO tender_facts (article_id, revision, version, basis, stage, region, deadline_at, facts)
    VALUES (${`${key}-201`}, 1, 999, 'fixed', 'tender', NULL, ${new Date(at.getTime() - DAY)}, ${sql.json({ stage: "tender", ...deadline(-1), signup: null, amount: null, purchaser: null, agent: null, winner: null, projectNo: null, region: null } as never)})`;
  const closed = await listTenders({ q: key });
  assert.equal(closed.rows.length, 200);
  assert.equal(closed.hiddenPast, 1);
  const shown = await listTenders({ q: key, past: "1" });
  assert.ok(shown.rows.some((r) => r.id === `${key}-201`), "展开后看得到那一条已截止的");
});

test("重复的查询参数取第一个，和网页一致，不报错", async () => {
  const list = await listTenders({ q: [T, "另一个词"], region: ["宁夏", "广东"], view: ["open", "result"] });
  assert.equal(list.q, T);
  assert.equal(list.region, "宁夏");
  assert.equal(list.view, "open");
});
