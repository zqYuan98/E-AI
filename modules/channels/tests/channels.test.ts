// 频道：一次按几类读“全部动态”；行业热点的自动话题按最近一周的用量（加上比前一周多出的部分）排，只算频道收的几类；
// 后台改的标题、介绍和筛选项要过校验、记审计，可以恢复默认，固定写进筛选项的话题不再作为自动话题重复出现。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadPool } from "@aihot/backend/publication/pool";
import { readTrendingTags } from "@aihot/backend/publication/trending";
import { CHANNEL_KEYS, CHANNELS, invalidText } from "../channels.ts";
import { ChannelError, channelView, resetChannel, saveChannel } from "../backend/settings.ts";
import { buildApp } from "../../../apps/api/src/app.ts";

const T = tag();
const SOURCE = `channels-${T}`;
const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000 - 3600_000);
let n = 0;
async function report(category: string, tags: string[], at: Date) {
  const id = `${T}-${++n}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, published_at)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.org/${id}`}, ${`${T} ${category} ${n}`}, ${at}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, published_at, sort_at,
      eligible, selected, visible_after, visibility, tags, category, search_text)
    VALUES (${id}, ${`${T} ${category} ${n}`}, ${SOURCE}, 'news', ${`https://example.org/${id}`}, ${at}, ${at}, ${at}, ${at},
      true, false, ${at}, 'public', ${[T, ...tags]}, ${category}, ${`${T} ${category} ${n}`})`;
}

const rising = `${T}-rising`, steady = `${T}-steady`, rare = `${T}-rare`, tenderOnly = `${T}-tender`;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Channel fixture', 'rss', 'T2')`;
  for (let i = 0; i < 3; i++) await report("applications", [rising], daysAgo(1));
  for (let i = 0; i < 4; i++) await report("models", [steady], daysAgo(2));
  for (let i = 0; i < 4; i++) await report("compute", [steady], daysAgo(9));
  await report("research", [rare], daysAgo(1));
  for (let i = 0; i < 5; i++) await report("procurement", [tenderOnly, rising], daysAgo(1));
  // A topic tag of the pack that the channel does not pin, for its automatic topics.
  for (let i = 0; i < 2; i++) await report("applications", ["虚拟电厂"], daysAgo(1));
});
after(async () => { await stopBoss(); await closeDb(); });

test("a channel reads several categories at once, and the API refuses a category the site does not have", async () => {
  const trends = CHANNELS.trends.categories;
  const pool = await loadPool({ channel: "all", category: null, categories: trends, tag: T, now });
  assert.equal(pool.items.length, 3 + 4 + 4 + 1 + 2);
  assert.ok(pool.items.every((i) => (trends as readonly string[]).includes(i.category!)));
  const app = await buildApp();
  try {
    assert.equal((await app.inject(`/api/site/pool?categories=${trends.join(",")}&tag=${encodeURIComponent(T)}`)).json().items.length, 14);
    assert.equal((await app.inject("/api/site/pool?categories=applications,nope")).statusCode, 400);
  } finally { await app.close(); }
});

test("automatic topics rank last week's use plus its rise, within the channel's categories only", async () => {
  const topics = await readTrendingTags({ categories: CHANNELS.trends.categories, tags: [rising, steady, rare, tenderOnly], limit: 8 }, now);
  // rising: 3 last week, none before (3 + 3); steady: 4 and 4 (4 + 0); rare: under two uses; tenders are another channel's.
  assert.deepEqual(topics.map((t) => [t.tag, t.recent, t.before]), [[rising, 3, 0], [steady, 4, 4]]);
});

test("the defaults are valid, and the admin's changes are checked, audited and can be undone", async () => {
  for (const key of CHANNEL_KEYS) assert.equal(invalidText(CHANNELS[key].defaults), null, key);
  const text = { title: "招标与商机", lead: "改过的介绍", rows: [{ label: "地区", chips: [{ label: "云南", q: "云南" }, { label: "边缘计算", tag: "边缘计算" }] }] };
  await assert.rejects(saveChannel("tenders", { ...text, rows: [{ label: "x", chips: [{ label: "y", tag: "不存在的标签" }] }] }, "试", "test"), ChannelError);
  await assert.rejects(saveChannel("tenders", { ...text, rows: [{ label: "x", chips: [{ label: "y", tag: "智能体", q: "智能体" }] }] }, "试", "test"), ChannelError);
  await assert.rejects(saveChannel("tenders", text, " ", "test"), /原因/);

  await saveChannel("tenders", text, "按地区看", "test");
  const view = await channelView("tenders");
  assert.deepEqual([view.title, view.lead, view.rows], [text.title, text.lead, text.rows]);
  assert.deepEqual(view.topics, [], "only 行业热点 has automatic topics");
  const [entry] = await sql<{ action: string; reason: string }[]>`SELECT action, reason FROM audit_log WHERE subject = 'channel:tenders' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([entry!.action, entry!.reason], ["channels.save", "按地区看"]);

  await resetChannel("tenders", "恢复", "test");
  assert.deepEqual((await channelView("tenders")).title, CHANNELS.tenders.defaults.title);
});

test("a topic pinned in a row is not offered again among the automatic ones", async () => {
  assert.ok((await channelView("trends")).topics.some((t) => t.tag === "虚拟电厂"));
  const pinned = "虚拟电厂";
  await saveChannel("trends", { ...CHANNELS.trends.defaults, rows: [{ label: "主题", chips: [{ label: pinned, tag: pinned }] }] }, "固定话题", "test");
  assert.ok(!(await channelView("trends")).topics.some((t) => t.tag === pinned));
  await resetChannel("trends", "恢复", "test");
});
