// 研报库：逐篇校验导入（不合格的说明原因，其余照存），同一链接或研报编号再导入是更新；列表按关键词和主题筛选，
// 隐藏的不出现；成员只能读，不能导入。
import { tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { deleteReport, importReports, listReports, loadReport, researchAdmin, setReportHidden } from "../backend/store.ts";
import { research } from "../server.ts";

const T = tag();
const report = (n: number, over: Record<string, unknown> = {}) => ({
  title: `电力大模型研究 ${n} ${T}`, institution: "某研究院", date: "2026-10-15", url: `https://www.djyanbao.com/report/${T}-${n}`,
  summary: `第 ${n} 篇：虚拟电厂与算电协同的摘要 ${T}`, points: [{ text: "调节能力目标", quote: "到2030年，虚拟电厂调节能力达到5000万千瓦以上" }],
  topics: ["虚拟电厂", "电力大模型"], ...over,
});
after(async () => { await stopBoss(); await closeDb(); installModules([]); });

test("each report is checked on its own; the same link or report id updates instead of adding", async () => {
  const result = await importReports([
    report(1),
    report(2, { djId: `dj-${T}-2` }),
    { ...report(3), url: "not a url" },
    { ...report(4), points: [{ text: "整段搬运", quote: "长".repeat(201) }] },
    { ...report(5), extra: 1 },
    { title: "x" },
  ], "test");
  assert.equal(result.created, 2);
  assert.deepEqual(result.errors.map((e) => [e.index, e.message.split(":")[0]]), [[2, "url"], [3, "points.0.quote"], [4, "item"], [5, "title"]]);

  const again = await importReports([report(1, { summary: `改过的摘要 ${T}` }), report(2, { djId: `dj-${T}-2`, url: `https://www.djyanbao.com/report/${T}-2-moved` })], "test");
  assert.deepEqual([again.created, again.updated], [0, 2]);
  const rows = (await researchAdmin()).reports.filter((r) => r.title.includes(T));
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.url.endsWith(`${T}-2-moved`)), "the report id finds a report whose link changed");
  await assert.rejects(importReports({ not: "a list" }, "test"), /数组/);
  await assert.rejects(importReports([], "test"), /1–200/);
});

test("the list searches titles, summaries and points, filters by topic, and leaves hidden reports out", async () => {
  const titles = async (f: Parameters<typeof listReports>[0]) => (await listReports(f)).reports.map((r) => r.title).filter((t) => t.includes(T));
  assert.equal((await titles({})).length, 2);
  assert.equal((await titles({ q: "改过的摘要" })).length, 1);
  assert.equal((await titles({ q: "5000万千瓦" })).length, 2, "a point's quote is searchable");
  assert.equal((await titles({ topic: "虚拟电厂" })).length, 2);
  assert.equal((await titles({ topic: "储能" })).length, 0);
  assert.ok((await listReports({})).topics.some((t) => t.topic === "虚拟电厂" && t.count >= 2));

  const [first] = (await researchAdmin()).reports.filter((r) => r.title.includes(T));
  const detail = await loadReport(first!.id);
  assert.deepEqual(detail!.points, [{ text: "调节能力目标", quote: "到2030年，虚拟电厂调节能力达到5000万千瓦以上" }]);
  await assert.rejects(setReportHidden(first!.id, true, " ", "test"), /reason/);
  await setReportHidden(first!.id, true, "重复", "test");
  assert.equal(await loadReport(first!.id), null);
  assert.equal((await titles({})).length, 1);
  await deleteReport(first!.id, "录错了", "test");
  assert.equal((await researchAdmin()).reports.some((r) => r.id === first!.id), false);
  const audit = await sql<{ action: string }[]>`SELECT action FROM audit_log WHERE subject = ${`research:${first!.id}`} ORDER BY id`;
  assert.deepEqual(audit.map((a) => a.action), ["research.hide", "research.delete"]);
});

test("research reads need a session, and only the admin imports", async () => {
  const { buildApp } = await import("../../../apps/api/src/app.ts");
  const { access } = await import("../../access/server.ts");
  const { createMember, loginMember } = await import("../../access/backend/members.ts");
  installModules([access, research]);
  const app = await buildApp();
  try {
    assert.equal((await app.inject({ url: "/api/site/research" })).statusCode, 401);
    const username = `reader-${T}`.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    await createMember({ username, password: "member password 123", name: "读者" }, "test");
    const token = await loginMember(username, "member password 123");
    const cookie = `aihot_member=${token}`;
    const read = await app.inject({ url: "/api/site/research", headers: { cookie } });
    assert.equal(read.statusCode, 200);
    assert.ok(read.json().reports.some((r: { title: string }) => r.title.includes(T)));
    const session = (await app.inject({ url: "/api/access/session", headers: { cookie } })).json();
    const write = await app.inject({ method: "POST", url: "/api/admin/research/import", headers: { cookie, origin: config.siteUrl, "x-csrf-token": session.csrf }, payload: { reports: [report(9)] } });
    assert.ok([401, 403].includes(write.statusCode), `a member cannot import (${write.statusCode})`);
    assert.equal((await app.inject({ url: "/api/v1/research" })).statusCode, 401, "not on the public interface");
  } finally {
    await app.close();
  }
});
