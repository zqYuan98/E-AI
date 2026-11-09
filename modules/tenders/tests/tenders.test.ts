// 招采公告抽取：只登记招采信源的资料；含关注词的才交给模型，其余跳过；天枢按 seq 增量拉取，
// 内部接口只认令牌，成员会话打不开，令牌没配时接口不存在。
import { gate, pointModels, stub } from "../../../tests/setup.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { buildApp } from "../../../apps/api/src/app.ts";
import { access } from "../../access/server.ts";
import { tenders } from "../server.ts";
import { extractPending, setWatchKeywords, track } from "../backend/extract.ts";
import { attachmentsOf, feedPage } from "../backend/feed.ts";

const T = randomUUID();
const TENDER_SOURCE = `tender-test-${T}`;
const OTHER_SOURCE = `tender-other-${T}`;
const TOKEN = `t${"0123456789abcdef".repeat(3)}`;

const EXTRACTION = {
  kind: "招标公告",
  projectName: { value: "示例变电站布控球采购", quote: "示例变电站布控球采购" },
  projectCode: null, buyer: null, agency: null, region: { value: { province: "云南", city: null }, quote: "云南" },
  budgetWan: { value: "不是数字", quote: "预算" }, // 格式不对：只把这个字段置空
  allowsConsortium: null,
  times: { docObtainStart: null, docObtainEnd: null, signupDeadline: null, bidDeadline: { value: "2026-12-01 09:30", quote: "2026年12月1日9时30分" }, opening: null },
  lots: [{ no: "包1", name: "布控球", quote: "包1：布控球", scope: null, budgetWan: null, deliveryPlace: null, deliveryPeriod: null }, { broken: true }],
  requirements: [],
  detailsInDocuments: true,
};

let answer: (body: string) => unknown = () => EXTRACTION;
const model = await stub(async (_hit, req) => ({ id: "stub", choices: [{ message: { content: JSON.stringify(await answer(req.body)) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
process.env.TENDERS_MODEL = "deepseek-flash";
pointModels(model.url, ["deepseek-flash"]);
process.env.TENDERS_FEED_TOKEN = TOKEN;
installModules([access, tenders]);
const app = await buildApp();

let ids: Record<string, string> = {};
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at) VALUES
    (${TENDER_SOURCE}, '示例招采平台', 'rss', 'T1', 'editorial', ${["招标", "云南"]}, '2100-01-01'),
    (${OTHER_SOURCE}, '示例新闻', 'rss', 'T1', 'editorial', ${["国网"]}, '2100-01-01')`;
  const add = async (sourceId: string, n: string, title: string, bodyText: string, bodyHtml?: string) =>
    (await upsertMaterial({ sourceId, url: `https://example.com/tender-${T}-${n}`, title, bodyText, bodyHtml, bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-12-01T00:00:00Z") })).articleId;
  ids = {
    hit: await add(TENDER_SOURCE, "1", "示例变电站布控球采购招标公告", "包1：布控球。投标截止2026年12月1日9时30分。", '<p>包1：布控球</p><a href="/files/招标文件.pdf">招标文件</a>'),
    miss: await add(TENDER_SOURCE, "2", "示例办公家具采购招标公告", "采购办公桌椅一批。"),
    news: await add(OTHER_SOURCE, "3", "示例新闻提到布控球", "布控球在现场的应用。"),
  };
});
after(async () => {
  await app.close();
  await model.close();
  await stopBoss();
  await closeDb();
});

const call = (method: "GET" | "PUT", url: string, payload?: object, token: string | null = TOKEN) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function feedAll() {
  const items: Array<Record<string, unknown>> = [];
  let after = "0";
  for (;;) {
    const page = (await call("GET", `/api/internal/tenders/feed?after=${after}&limit=2`)).json() as { items: Array<Record<string, unknown>>; next: string };
    if (!page.items.length) return { items, after };
    items.push(...page.items);
    after = page.next;
  }
}

test("内部接口只认令牌：没有、错的令牌进不来；没配令牌时接口不存在", async () => {
  assert.equal((await call("GET", "/api/internal/tenders/feed", undefined, null)).statusCode, 401);
  assert.equal((await call("GET", "/api/internal/tenders/feed", undefined, `${TOKEN}x`)).statusCode, 401);
  assert.equal((await call("GET", "/api/internal/tenders/status")).statusCode, 200);
  process.env.TENDERS_FEED_TOKEN = "changeme";
  try {
    assert.equal((await call("GET", "/api/internal/tenders/feed", undefined, "changeme")).statusCode, 404);
  } finally {
    process.env.TENDERS_FEED_TOKEN = TOKEN;
  }
});

test("没有关注词时只登记不抽取；有了以后只抽含关注词的", async () => {
  await track();
  const registered = await feedPage("0", 50);
  assert.equal(registered.items.find((i) => i.articleId === ids.hit)!.status, "pending");
  const first = await extractPending();
  assert.equal(model.hits(), 0, "没有关注词，不调模型");
  assert.equal(first.skipped, 2);
  const skipped = await feedPage(registered.next, 50);
  assert.deepEqual(skipped.items.map((i) => i.status), ["skipped", "skipped"], "pending → skipped 会再次出现在增量里");
  const statusOf = async (id: string) => (await sql<{ status: string }[]>`SELECT status FROM tender_notices WHERE article_id = ${id}`)[0]?.status;
  assert.equal(await statusOf(ids.hit!), "skipped");
  assert.equal(await statusOf(ids.news!), undefined, "不是招采信源的资料不登记");

  const watch = await call("PUT", "/api/internal/tenders/watch", { keywords: ["布控球", " ", "布控球", "x"] });
  assert.equal(watch.statusCode, 200);
  assert.equal(watch.json().keywords, 1, "去重，去掉太短的词");
  assert.ok(watch.json().requeued >= 2, "跳过的重新排队");
  const pending = await feedPage(skipped.next, 50);
  assert.deepEqual(pending.items.map((i) => i.status), ["pending", "pending"], "skipped → pending 也推进游标");

  await extractPending();
  assert.equal(model.hits(), 1, "只有含关注词的那篇调了模型");
  assert.equal(await statusOf(ids.hit!), "done");
  assert.equal(await statusOf(ids.miss!), "skipped");
});

test("增量拉取：按 seq 分页，抽取完成的带结果；格式不对的字段置空，坏掉的标包丢掉", async () => {
  const { items, after } = await feedAll();
  const mine = items.filter((i) => [ids.hit, ids.miss].includes(i.articleId as string));
  assert.equal(mine.length, 2);
  const hit = mine.find((i) => i.articleId === ids.hit)!;
  assert.equal(hit.status, "done");
  assert.equal(hit.hasBody, true);
  assert.match(String(hit.text), /投标截止2026年12月1日9时30分/);
  assert.deepEqual(hit.attachments, [{ name: "招标文件", url: "https://example.com/files/%E6%8B%9B%E6%A0%87%E6%96%87%E4%BB%B6.pdf" }]);
  const x = hit.extraction as typeof EXTRACTION;
  assert.equal(x.budgetWan, null);
  assert.equal(x.lots.length, 1);
  assert.equal(x.times.bidDeadline?.value, "2026-12-01 09:30");
  assert.equal(mine.find((i) => i.articleId === ids.miss)!.extraction, null);
  assert.deepEqual((await call("GET", `/api/internal/tenders/feed?after=${after}`)).json().items, [], "拉到头了");

  // 重新抽取会让它在增量里再出现一次
  await sql`UPDATE articles SET title = title || '（修订）' WHERE id = ${ids.hit}`;
  await extractPending();
  const again = (await call("GET", `/api/internal/tenders/feed?after=${after}`)).json().items as Array<{ articleId: string }>;
  assert.deepEqual(again.map((i) => i.articleId), [ids.hit]);
});

test("附件链接：认文件后缀和“附件”“招标文件”这类文字，相对地址补全", () => {
  const html = '<a href="a.pdf">一</a><a href="/x?id=1&amp;t=2">附件1：报价清单</a><a href="https://example.com/news">新闻</a><a href="javascript:void(0)">附件</a><a href="bad%ZZ.pdf"></a><a href="bad%E4.pdf"><span></span></a><a href="%E6%B8%85%E5%8D%95.pdf"></a>';
  assert.deepEqual(attachmentsOf(html, "https://example.com/p/1.html"), [
    { name: "一", url: "https://example.com/p/a.pdf" },
    { name: "附件1：报价清单", url: "https://example.com/x?id=1&t=2" },
    { name: "bad%ZZ.pdf", url: "https://example.com/p/bad%ZZ.pdf" },
    { name: "bad%E4.pdf", url: "https://example.com/p/bad%E4.pdf" },
    { name: "清单.pdf", url: "https://example.com/p/%E6%B8%85%E5%8D%95.pdf" },
  ]);
});

async function addNotice(title: string, bodyText: string | null = null) {
  return (await upsertMaterial({
    sourceId: TENDER_SOURCE, url: `https://example.com/tenders/${randomUUID()}`, title,
    bodyText, bodyStatus: bodyText ? "ok" : "none", via: "fetch", publishedAt: new Date("2026-12-01T00:00:00Z"),
  })).articleId;
}

const notice = async (id: string) => (await feedPage("0", 50)).items.find((i) => i.articleId === id)!;

async function assertReset(id: string) {
  const [row] = await sql`SELECT status, extraction, receipt_id, attempts, checked_at FROM tender_notices WHERE article_id = ${id}`;
  assert.deepEqual({ ...row }, { status: "pending", extraction: null, receipt_id: null, attempts: 0, checked_at: null });
}

test("晚到正文让 skipped 重新排队并抽取；输入未变不重复登记", async () => {
  const id = await addNotice("晚到正文的采购公告");
  await extractPending();
  const before = await notice(id);
  assert.equal(before.status, "skipped");
  assert.equal(before.hasBody, false);
  const hits = model.hits();
  await sql`UPDATE articles SET body_text = '正文补全：布控球采购', body_status = 'ok' WHERE id = ${id}`;
  assert.equal(await track(), 1);
  await assertReset(id);
  const pending = (await feedPage(before.seq, 50)).items.find((i) => i.articleId === id)!;
  assert.equal(pending.status, "pending");
  assert.match(pending.text, /正文补全：布控球采购/);
  await extractPending();
  assert.equal(model.hits(), hits + 1);
  assert.equal((await notice(id)).status, "done");
  assert.equal(await track(), 0);
  const done = await notice(id);
  await extractPending();
  assert.equal((await notice(id)).seq, done.seq, "未变的 done 不重写游标");
  assert.equal(model.hits(), hits + 1);
});

test("正文、HTML 附件、标题和 body_status 修订均重新抽取；feed 不混合新输入和旧抽取", async () => {
  const id = await addNotice("布控球版本追踪公告");
  await extractPending();
  assert.equal((await notice(id)).status, "done");
  const changes = [
    () => sql`UPDATE articles SET body_text = '版本二：布控球的晚到正文', body_status = 'ok' WHERE id = ${id}`,
    () => sql`UPDATE articles SET body_html = '<a href="/bad%ZZ.pdf"></a><a href="/valid.pdf">清单</a>' WHERE id = ${id}`,
    () => sql`UPDATE articles SET title = '布控球修订后的公告标题' WHERE id = ${id}`,
    () => sql`UPDATE articles SET body_status = 'unconfirmed' WHERE id = ${id}`,
  ];
  for (const change of changes) {
    const old = await notice(id);
    const hits = model.hits();
    await change();
    assert.deepEqual(await notice(id), old, "尚未登记时继续给旧版证据和旧版结果");
    await track();
    await assertReset(id);
    const pending = (await feedPage(old.seq, 50)).items.find((i) => i.articleId === id)!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.extraction, null);
    assert.ok(BigInt(pending.seq) > BigInt(old.seq));
    await extractPending();
    const done = await notice(id);
    assert.equal(done.status, "done");
    assert.equal(done.text, pending.text);
    assert.deepEqual(done.attachments, pending.attachments);
    assert.equal(model.hits(), hits + 1, "HTML 或 body_status 变更也使用新版本回执");
  }
  const response = await call("GET", "/api/internal/tenders/feed?limit=50");
  assert.equal(response.statusCode, 200, "非法百分号附件不阻断整页");
  const item = response.json().items.find((i: { articleId: string }) => i.articleId === id);
  assert.deepEqual(item.attachments, [
    { name: "bad%ZZ.pdf", url: "https://example.com/bad%ZZ.pdf" },
    { name: "清单", url: "https://example.com/valid.pdf" },
  ]);
});

test("失败及再次失败推进游标；失败次数耗尽后输入修订清空失败状态", async () => {
  const id = await addNotice("布控球失败测试公告");
  await track();
  let cursor = (await feedPage("0", 50)).next;
  answer = () => ({});
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await extractPending();
      const page = await feedPage(cursor, 50);
      const failed = page.items.find((i) => i.articleId === id)!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.extraction, null);
      const [row] = await sql`SELECT attempts FROM tender_notices WHERE article_id = ${id}`;
      assert.equal(row!.attempts, attempt);
      cursor = page.next;
      await sql`UPDATE tender_notices SET checked_at = '-infinity'::timestamptz WHERE article_id = ${id}`;
    }
    await sql`UPDATE tender_notices SET attempts = 3 WHERE article_id = ${id}`;
    const hits = model.hits();
    await extractPending();
    assert.equal(model.hits(), hits, "耗尽后不重试旧版本");
  } finally {
    answer = () => EXTRACTION;
  }
  await sql`UPDATE articles SET title = title || '（修订后）' WHERE id = ${id}`;
  await track();
  await assertReset(id);
  assert.equal((await feedPage(cursor, 50)).items.find((i) => i.articleId === id)!.status, "pending");
  await extractPending();
  assert.equal((await notice(id)).status, "done");
});

test("模型在途时修订输入：旧成功和旧失败都不能覆盖新版本", async () => {
  for (const staleOutput of [EXTRACTION, {}]) {
    const id = await addNotice(`布控球在途修订 ${randomUUID()}`, "旧版正文");
    const entered = gate();
    const release = gate();
    answer = async () => { entered.open(); await release.promise; return staleOutput; };
    const running = extractPending();
    try {
      await entered.promise;
      await sql`UPDATE articles SET body_text = '修订版正文：布控球' WHERE id = ${id}`;
      await track(); // 必须能在模型未返回时完成：模型调用不占模块写锁。
      const current = await notice(id);
      await assertReset(id);
      release.open();
      await running;
      assert.deepEqual(await notice(id), current, "旧成功/失败都不修改新版状态及游标");
      await assertReset(id);
    } finally {
      release.open();
      await running;
      answer = () => EXTRACTION;
    }
    await extractPending();
    assert.equal((await notice(id)).status, "done");
  }
});

test("文章已修订但尚未 track 时，旧模型结果也不落库", async () => {
  const id = await addNotice("布控球待登记修订公告", "旧输入");
  const entered = gate();
  const release = gate();
  answer = async () => { entered.open(); await release.promise; return EXTRACTION; };
  const running = extractPending();
  try {
    await entered.promise;
    const old = await notice(id);
    await sql`UPDATE articles SET body_text = '布控球待登记的新输入' WHERE id = ${id}`;
    release.open();
    await running;
    assert.deepEqual(await notice(id), old, "未登记修订也会阻止旧任务提交");
    await assertReset(id);
  } finally {
    release.open();
    await running;
    answer = () => EXTRACTION;
  }
  await extractPending();
  const latest = await notice(id);
  assert.equal(latest.status, "done");
  assert.match(latest.text, /待登记的新输入/);
});

test("关注词在模型调用期间改变：旧规则不能把 pending 公告写入终态", async () => {
  await extractPending();
  const id = await addNotice("布控球关注词修订公告", "采购布控球");
  const entered = gate();
  const release = gate();
  answer = async () => { entered.open(); await release.promise; return EXTRACTION; };
  const running = extractPending();
  try {
    await entered.promise;
    const old = await notice(id);
    await setWatchKeywords({ keywords: ["临时关注词"] });
    release.open();
    await running;
    assert.deepEqual(await notice(id), old, "在途任务用旧关注词，不能改变公告状态或游标");
  } finally {
    release.open();
    await running;
    answer = () => EXTRACTION;
  }
  await extractPending();
  assert.equal((await notice(id)).status, "skipped", "下一轮按新关注词重新处理");
  await setWatchKeywords({ keywords: ["布控球"] });
  await extractPending();
});

test("迁移后的旧记录先建立快照再出 feed，已登记旧文仍跟踪修订", async () => {
  const id = await addNotice("布控球迁移前旧记录", "旧文正文");
  await sql`UPDATE articles SET discovered_at = discovered_at - interval '31 days' WHERE id = ${id}`;
  await sql`INSERT INTO tender_notices (article_id, status, extraction, attempts)
    VALUES (${id}, 'done', ${sql.json(EXTRACTION)}, 3)`;
  const before = await feedPage("0", 50);
  assert.equal(before.items.some((i) => i.articleId === id), false, "无输入快照的旧结果不与实时正文拼接");
  await track();
  await assertReset(id);
  assert.equal((await feedPage(before.next, 50)).items.find((i) => i.articleId === id)!.status, "pending");
  await extractPending();
  assert.equal((await notice(id)).status, "done");
  await sql`UPDATE articles SET body_text = '布控球旧文的晚到修订' WHERE id = ${id}`;
  await extractPending();
  const latest = await notice(id);
  assert.equal(latest.status, "done");
  assert.match(latest.text, /旧文的晚到修订/);
});

// 等到数据库确实出现阻塞再推进测试，不靠固定睡眠猜测两个写入方的执行顺序。
async function waitForBlocked(count: number) {
  for (let i = 0; i < 500; i++) {
    const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
    if (row!.n >= count) return;
  }
  assert.fail(`没有观察到 ${count} 个被阻塞的写入方`);
}

test("worker 与 watch 跨连接竞争：大游标不能先提交，分页追更不漏较小游标", async () => {
  const blockedId = ids.hit!;
  await sql`UPDATE articles SET title = title || '（并发修订）' WHERE id = ${blockedId}`;
  const before = await feedPage("0", 50);
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT article_id FROM tender_notices WHERE article_id = ${blockedId} FOR UPDATE`;
    locked.open();
    await release.promise;
  });
  let tracking: Promise<number> | undefined;
  let watching: ReturnType<typeof setWatchKeywords> | undefined;
  try {
    await locked.promise;
    tracking = track();
    await waitForBlocked(1);
    watching = setWatchKeywords({ keywords: ["布控球"] });
    await waitForBlocked(2);
    assert.deepEqual((await feedPage(before.next, 50)).items, [], "worker 未提交时 watch 不能抢先暴露更大 seq");
    release.open();
    await Promise.all([blocker, tracking, watching]);
    const seen: string[] = [];
    let cursor = before.next;
    for (;;) {
      const page = await feedPage(cursor, 1);
      if (!page.items.length) break;
      assert.ok(BigInt(page.next) > BigInt(cursor));
      seen.push(page.items[0]!.articleId);
      cursor = page.next;
    }
    assert.ok(seen.includes(blockedId), "worker 修订没有漏拉");
    assert.ok(seen.includes(ids.miss!), "watch 重排没有漏拉");
  } finally {
    release.open();
    await Promise.all([blocker, tracking, watching]);
  }
});

test("watch 持有未提交游标时，模型结果不能越过它先提交", async () => {
  await extractPending();
  const id = await addNotice("布控球并发完成公告", "等待模型完成");
  const entered = gate();
  const modelRelease = gate();
  const locked = gate();
  const writeRelease = gate();
  answer = async () => { entered.open(); await modelRelease.promise; return EXTRACTION; };
  const running = extractPending();
  let blocker: Promise<unknown> | undefined;
  let watching: ReturnType<typeof setWatchKeywords> | undefined;
  try {
    await entered.promise;
    const before = (await feedPage("0", 50)).next;
    blocker = sql.begin(async (tx) => {
      await tx`SELECT article_id FROM tender_notices WHERE article_id = ${ids.miss} FOR UPDATE`;
      locked.open();
      await writeRelease.promise;
    });
    await locked.promise;
    watching = setWatchKeywords({ keywords: ["布控球"] });
    await waitForBlocked(1);
    modelRelease.open();
    await waitForBlocked(2);
    assert.deepEqual((await feedPage(before, 50)).items, [], "模型结果不得以更大 seq 抢先提交");
    writeRelease.open();
    await Promise.all([blocker, watching, running]);
    const watchPage = await feedPage(before, 1);
    assert.equal(watchPage.items[0]!.articleId, ids.miss);
    assert.equal(watchPage.items[0]!.status, "pending");
    const modelPage = await feedPage(watchPage.next, 1);
    assert.equal(modelPage.items[0]!.articleId, id);
    assert.equal(modelPage.items[0]!.status, "done");
    assert.deepEqual((await feedPage(modelPage.next, 1)).items, []);
  } finally {
    writeRelease.open();
    modelRelease.open();
    await Promise.all([blocker, watching, running]);
    answer = () => EXTRACTION;
  }
});
