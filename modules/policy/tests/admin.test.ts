// 政策库管理：隐藏、删除、重新抽取和网址导入；一篇资料换了文件时，旧文件没有资料就删掉，有的话换主资料。
import { pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { ExtractSchema, storeDocument, type Extracted } from "../backend/extract.ts";
import { listPolicies } from "../backend/read.ts";
import { deleteDoc, importUrls, policyAdmin, reextractDoc, retryImport, setDocHidden } from "../backend/admin.ts";
import { enqueueImports, processImports } from "../backend/import.ts";
import { policy } from "../server.ts";

installModules([policy]);
const T = tag();
const SOURCE = `policy-admin-${T}`;
const BODY = `国家电网有限公司印发《关于推进电力人工智能应用的实施意见 ${T}》。到2027年，智能巡检覆盖率达到90%。推进调度智能体应用。`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags) VALUES (${SOURCE}, '国家电网', 'rss', 'T1', 'editorial', ${["政策规划"]})`;
});
after(async () => { await stopBoss(); await closeDb(); installModules([]); });

let n = 0;
async function article(title: string, body = BODY): Promise<string> {
  n += 1;
  return (await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/policy-admin-${T}-${n}`, title, bodyText: body, bodyStatus: "ok", via: "fetch", publishedAt: new Date() })).articleId;
}
const doc = (name: string, over: Partial<Extracted> = {}): Extracted => ExtractSchema.parse({
  isDocument: true, role: "original", documentName: name, docType: "指导意见", level: "sgcc", issuers: [], docNo: null, issuedOn: null, summary: "摘要",
  targets: [], tasks: [], aiClauses: [], aiRelevance: "core", ...over,
});
const listed = async () => (await listPolicies({})).docs.map((d) => d.id);

test("an article moved to another document leaves no orphan; the one left keeps its other articles", async () => {
  const a = await article(`甲 ${T}`);
  const b = await article(`乙 ${T}`);
  const first = (await storeDocument(a, "甲", doc(`第一份文件 ${T}`), null))!;
  assert.equal(await storeDocument(b, "乙", doc(`第一份文件 ${T}`, { role: "report" }), null), first);
  const second = (await storeDocument(a, "甲", doc(`第二份文件 ${T}`), null))!;
  assert.notEqual(second, first);
  const [kept] = await sql<{ primary_article_id: string }[]>`SELECT primary_article_id FROM policy_docs WHERE id = ${first}`;
  assert.equal(kept!.primary_article_id, b, "the first document now rests on its remaining article");
  await storeDocument(b, "乙", null, null);
  assert.equal((await sql`SELECT 1 FROM policy_docs WHERE id = ${first}`).length, 0, "no articles left: removed");
});

test("hidden documents leave the library and come back; deleted ones stay excluded", async () => {
  const a = await article(`丙 ${T}`);
  const id = (await storeDocument(a, "丙", doc(`第三份文件 ${T}`), null))!;
  assert.ok((await listed()).includes(id));
  await assert.rejects(setDocHidden(id, true, " ", "test"), /reason/);
  await setDocHidden(id, true, "抽取有误", "test");
  assert.ok(!(await listed()).includes(id));
  assert.ok((await policyAdmin()).docs.find((d) => d.id === id)!.hidden, "the admin still sees it");
  await setDocHidden(id, false, "恢复", "test");
  assert.ok((await listed()).includes(id));

  await deleteDoc(id, "与本站无关", "test");
  assert.equal((await sql`SELECT 1 FROM policy_docs WHERE id = ${id}`).length, 0);
  assert.equal((await sql<{ outcome: string }[]>`SELECT outcome FROM policy_links WHERE article_id = ${a}`)[0]!.outcome, "excluded");
  const audit = await sql<{ action: string }[]>`SELECT action FROM audit_log WHERE subject = ${`policy:${id}`} ORDER BY id`;
  assert.deepEqual(audit.map((r) => r.action), ["policy.hide", "policy.show", "policy.delete"]);
});

test("imports are queued once, processed by the worker with the model, and failures can be retried", async () => {
  const answer = { isDocument: true, role: "original", documentName: `关于推进电力人工智能应用的实施意见 ${T}`, docType: "指导意见", level: "sgcc", issuers: ["国家电网有限公司"],
    docNo: null, issuedOn: null, summary: "推进电力人工智能应用。", targets: [{ metric: "智能巡检覆盖率", value: "达到90%", year: "2027", quote: "到2027年，智能巡检覆盖率达到90%。" }],
    tasks: [], aiClauses: [{ text: "调度智能体", quote: "推进调度智能体应用" }], aiRelevance: "core" };
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  process.env.POLICY_MODEL = "deepseek-flash";
  pointModels(provider.url, ["deepseek-flash"]);
  try {
    // A re-extraction runs on stored articles, without fetching the page again.
    const a = await article(`丁 ${T}`);
    const id = (await storeDocument(a, "丁", doc(`第四份文件 ${T}`), null))!;
    await assert.rejects(reextractDoc(id, " ", "test"), /reason/);
    assert.deepEqual(await reextractDoc(id, "新提示词", "test"), { id, queued: 1 });
    await assert.rejects(reextractDoc(id, "again", "test"), /排队/, "not queued twice");
    assert.deepEqual(await processImports(), { done: 1, failed: 0 });
    const [row] = await sql<{ status: string; doc_id: number }[]>`SELECT status, doc_id FROM policy_imports WHERE article_id = ${a}`;
    assert.equal(row!.status, "document");
    const [stored] = await sql<{ name: string; ai_clauses: unknown[] }[]>`SELECT name, ai_clauses FROM policy_docs WHERE id = ${row!.doc_id}`;
    assert.equal(stored!.name, `关于推进电力人工智能应用的实施意见 ${T}`);
    assert.equal(stored!.ai_clauses.length, 1);
    assert.equal((await sql`SELECT 1 FROM policy_docs WHERE id = ${id}`).length, 0, "the old name's document had nothing left");

    // Pasted URLs: duplicates and junk are dropped; a page the guard refuses fails with its reason and can be retried.
    assert.deepEqual(await enqueueImports(["http://127.0.0.1:9/a", "http://127.0.0.1:9/a", "not a url"], "test"), { queued: 1, skipped: 2 });
    await assert.rejects(importUrls({ urls: "nothing here" }, "test"), /网址/);
    assert.deepEqual(await processImports(), { done: 0, failed: 1 });
    const failed = (await policyAdmin()).imports.find((i) => i.url === "http://127.0.0.1:9/a")!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error);
    await retryImport(failed.id, "test");
    await assert.rejects(retryImport(failed.id, "test"), /失败/);
    assert.ok((await policyAdmin()).seeds > 10, "the bundled seed list");
  } finally {
    delete process.env.POLICY_MODEL;
    await provider.close();
  }
});
