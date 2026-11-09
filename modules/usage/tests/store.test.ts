// 访问统计的存取：按北京时间分天，没人访问的日子补 0，按成员和页面汇总；过期的明细汇总成每天的总量后删除，
// 趋势里两边不重复；导出的 CSV 防公式注入，范围有上限。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { exportVisits, recordVisit, rollUpOldVisits, usageReport } from "../backend/store.ts";

after(async () => { await closeDb(); });

// 北京时间 2026-06-15 中午。
const NOW = new Date("2026-06-15T04:00:00Z");
const T = tag();
const A = { id: 9101, name: `甲${T}` };
const B = { id: 9102, name: `乙${T}` };
const visit = (path: string, title = "", device: "mobile" | "desktop" = "desktop") => ({ path, title, device });

test("a report counts Beijing days, fills quiet days with zero and names who read what", async () => {
  await recordVisit(A, visit("/story/1", "事件一（旧标题）"), new Date("2026-06-14T15:30:00Z")); // 北京 06-14 23:30
  await recordVisit(A, visit("/story/1", "事件一"), new Date("2026-06-14T16:30:00Z")); // 北京 06-15 00:30，已是下一天
  await recordVisit(A, visit("/research/2", "研报", "mobile"), new Date("2026-06-15T02:00:00Z")); // 北京 10:00
  await recordVisit(B, visit("/story/1", "事件一"), new Date("2026-06-15T03:00:00Z")); // 北京 11:00
  await recordVisit(A, visit("/about"), new Date("2026-06-11T01:00:00Z"));

  const report = await usageReport({ range: 7 }, NOW);
  assert.equal(report.today, "2026-06-15");
  assert.deepEqual(report.trend.map((d) => d.day), ["2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]);
  assert.deepEqual(report.trend.map((d) => [d.views, d.visitors]), [[0, 0], [0, 0], [1, 1], [0, 0], [0, 0], [1, 1], [3, 2]]);
  assert.deepEqual(report.totals, { views: 5, visitors: 2 });

  assert.deepEqual(report.dayMembers.map((m) => [m.name, m.views, m.pages]), [[A.name, 2, 2], [B.name, 1, 1]], "the member with most visits first");
  assert.deepEqual((await usageReport({ range: 7, member: A.id }, NOW)).timeline.map((e) => [e.path, e.title, e.device]),
    [["/story/1", "事件一", "desktop"], ["/research/2", "研报", "mobile"]]);
  assert.deepEqual((await usageReport({ range: 7, day: "2026-06-14", member: A.id }, NOW)).timeline.map((e) => e.title), ["事件一（旧标题）"]);

  const story = report.topPages.find((p) => p.path === "/story/1")!;
  assert.deepEqual([story.views, story.visitors, story.title], [3, 2, "事件一"], "the page shows its latest title");
  assert.deepEqual(report.members.map((m) => [m.name, m.views, m.days]), [[B.name, 1, 1], [A.name, 4, 3]], "the most recent visitor first");

  assert.equal((await usageReport({ range: 5 }, NOW)).range, 30, "an unknown range is 30 days");
  assert.equal((await usageReport({ range: 7, day: "2026-06-16" }, NOW)).day, "2026-06-15", "a future day is today");
  assert.equal((await usageReport({ range: 7, day: "not-a-date" }, NOW)).day, "2026-06-15");
});

test("details past 180 days become one total a day, once, and the trend does not count a day twice", async () => {
  const C = { id: 9201, name: `丙${T}` };
  const D = { id: 9202, name: `丁${T}` };
  // 今天是 06-15，明细留到 2025-12-17（含）；12-16 已过期。
  await recordVisit(C, visit("/old"), new Date("2025-12-16T02:00:00Z"));
  await recordVisit(C, visit("/old"), new Date("2025-12-16T03:00:00Z"));
  await recordVisit(D, visit("/old"), new Date("2025-12-16T04:00:00Z"));
  await recordVisit(C, visit("/edge"), new Date("2025-12-17T02:00:00Z"));

  const before = await usageReport({ range: 365 }, NOW);
  assert.deepEqual(before.trend.find((d) => d.day === "2025-12-16"), { day: "2025-12-16", views: 3, visitors: 2 });

  assert.deepEqual(await rollUpOldVisits(NOW), { usageDaysRolledUp: 1, usageVisitsRemoved: 3 });
  const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_visits WHERE day <= '2025-12-16'`;
  assert.equal(left!.n, 0);

  const after = await usageReport({ range: 365 }, NOW);
  assert.deepEqual(after.trend.find((d) => d.day === "2025-12-16"), { day: "2025-12-16", views: 3, visitors: 2 }, "the same day, now from the daily totals");
  assert.deepEqual(after.trend.find((d) => d.day === "2025-12-17"), { day: "2025-12-17", views: 1, visitors: 1 }, "the cut-off day keeps its details");
  assert.equal(after.totals.views, before.totals.views);
  assert.equal(after.topPages.some((p) => p.path === "/old"), false, "pages are known only while details are kept");

  assert.deepEqual(await rollUpOldVisits(NOW), { usageDaysRolledUp: 0, usageVisitsRemoved: 0 });
});

test("an export is a CSV that spreadsheets open as text, and its range is bounded", async () => {
  const E = { id: 9301, name: `=戊${T}` };
  await recordVisit(E, visit("/story/9", `=SUM(1,2) "引用"`, "mobile"), new Date("2026-06-13T05:20:00Z")); // 北京 13:20
  const { csv, rows, from, to } = await exportVisits("2026-06-13", "2026-06-13");
  assert.equal(csv.charCodeAt(0), 0xfeff, "a byte-order mark so Excel reads UTF-8");
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[0], "日期,时间,成员,页面,标题,设备");
  assert.equal(rows, lines.length - 1);
  assert.ok(lines.includes(`2026-06-13,13:20,'=戊${T},/story/9,"'=SUM(1,2) ""引用""",手机`), lines.join("\n"));
  assert.deepEqual([from, to], ["2026-06-13", "2026-06-13"]);

  await assert.rejects(exportVisits("2026-06-13", "2026-06-12"), /不能早于/);
  await assert.rejects(exportVisits("13/06/2026", "2026-06-13"), /YYYY-MM-DD/);
  await assert.rejects(exportVisits(undefined, undefined), /YYYY-MM-DD/);
  await assert.rejects(exportVisits("2025-12-01", "2026-06-15"), /180/);
  await exportVisits("2025-12-18", "2026-06-15");
});
