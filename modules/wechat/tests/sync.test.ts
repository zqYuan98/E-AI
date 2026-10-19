// 公众号接入：第一次见到的公众号建成信源、这一批按存量归档；之后的新文章正常进入处理，正文用订阅里的全文；
// 暂停的公众号不再收新文章。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sourceIdFor, syncWechatFeed } from "../backend/sync.ts";

const T = tag();
const account = `电力测试号 ${T}`;
const body = `<p>${"国网某省电力公司上线输电线路智能巡检大模型，覆盖全部 500 千伏线路。".repeat(12)}</p>`;
let items: unknown[] = [];
let server: http.Server;
let url = "";

before(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/feed+json");
    res.end(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feeds/all.json`;
});
after(async () => {
  server.close();
  await stopBoss();
  await closeDb();
});

const item = (n: number, hoursAgo: number) => ({
  id: `${T}-${n}`, url: `https://mp.weixin.qq.com/s?__biz=${T}&mid=${n}&idx=1&sn=x`, title: `智能巡检文章 ${n} ${T}`,
  content_html: body, date_published: new Date(Date.now() - hoursAgo * 3600_000).toISOString(), authors: [{ name: account }],
});

test("a new account becomes an editorial source and its first batch is archived as baseline", async () => {
  items = [item(1, 2), item(2, 3)];
  const r = await syncWechatFeed(url);
  assert.equal(r.newSources, 1);
  assert.equal(r.created, 2);
  const [source] = await sql<{ name: string; kind: string; participation_mode: string; tier: string }[]>`
    SELECT name, kind, participation_mode, tier FROM sources WHERE id = ${sourceIdFor(account)}`;
  assert.deepEqual(source, { name: account, kind: "external", participation_mode: "editorial", tier: "T2" });
  const rows = await sql<{ backfill: boolean; body_status: string }[]>`SELECT backfill, body_status FROM articles WHERE source_id = ${sourceIdFor(account)}`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((a) => a.backfill), "the first batch of a new account does not count as today's news");
  assert.ok(rows.every((a) => a.body_status === "ok"), "the feed's full text is the body");
});

test("later articles of a known account are processed as news, and a paused account takes none", async () => {
  items = [item(1, 2), item(2, 3), item(3, 1)];
  const r = await syncWechatFeed(url);
  assert.equal(r.created, 1, "only the new article is created");
  const [fresh] = await sql<{ backfill: boolean }[]>`SELECT backfill FROM articles WHERE url LIKE ${`%mid=3%`} AND source_id = ${sourceIdFor(account)}`;
  assert.equal(fresh!.backfill, false);

  await sql`UPDATE sources SET enabled = false WHERE id = ${sourceIdFor(account)}`;
  items = [item(4, 0.5)];
  assert.equal((await syncWechatFeed(url)).created, 0);
});
