// 政策文件的导入：读原文页正文，存成“政策规划·手动收录”信源的资料，再用模型抽取入库。后台“政策库管理”登记网址，
// worker 每分钟处理几条（processImports）；命令行脚本 scripts/import.ts 直接调用同一套。
import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { readable } from "@aihot/backend/content/extract";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@aihot/backend/providers/receipts";
import { POLICY_TAG, readDocument, storeDocument } from "./extract.ts";

export const MANUAL_SOURCE = "policy-manual";
const BATCH = 3;

function safeReadable(html: string, url: string) {
  try {
    return readable(html, url);
  } catch {
    return null;
  }
}

/** 正文提取认不出的政府网页（中国政府网政策库等）：按常见的正文容器取。 */
function fromContainer(html: string, url: string) {
  const $ = cheerio.load(html);
  for (const sel of ["#UCAP-CONTENT", ".pages_content", ".TRS_Editor", "#zoom", ".article-content", "article"]) {
    const el = $(sel).first();
    const text = el.text().replace(/\s+/g, " ").trim();
    if (text.length >= 200) return { html: sanitizeBody(el.html() ?? "", url), text, images: [], via: "readability" as const, publishedAt: null };
  }
  return null;
}

export async function ensureManualSource() {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
    VALUES (${MANUAL_SOURCE}, '政策规划·手动收录', 'external', '{}'::jsonb, 'T1', 'isolated', 1440, true, 'ok', ${[POLICY_TAG]})
    ON CONFLICT (id) DO NOTHING`;
}

/** 抓一个原文网址存成资料；读不到正文时抛出原因。 */
export async function fetchMaterial(url: string): Promise<string> {
  const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
  if (res.status !== 200) throw new Error(`原文页返回 HTTP ${res.status}`);
  const html = res.text();
  const body = safeReadable(html, res.url) ?? fromContainer(html, res.url);
  if (!body) throw new Error("页面里找不到正文（可能要登录、是图片或附件）");
  const $ = cheerio.load(html);
  const title = ($("h1").first().text() || $('meta[property="og:title"]').attr("content") || $("title").text()).replace(/\s+/g, " ").trim().slice(0, 200);
  await ensureManualSource();
  const { articleId } = await upsertMaterial({
    sourceId: MANUAL_SOURCE, url, title, bodyHtml: body.html, bodyText: body.text, bodyStatus: "ok", via: "import",
    publishedAt: body.publishedAt ?? null, backfill: "reported-backfill",
  });
  return articleId;
}

/** 读一篇已存的资料并入库；返回文件 id（不是政策规划文件时为 null）。 */
export async function extractArticle(articleId: string): Promise<number | null> {
  const [a] = await sql<{ title: string; body_text: string | null; published_at: Date | null; source_name: string }[]>`
    SELECT a.title, a.body_text, a.published_at, s.name AS source_name FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a?.body_text) throw new Error("这篇资料没有正文");
  const { out, receiptId } = await readDocument({ id: articleId, title: a.title, body_text: a.body_text, source_name: a.source_name, published_at: a.published_at });
  return storeDocument(articleId, a.title, out, receiptId);
}

/** 后台登记导入：去掉重复和已在处理的网址；已经入库过的网址也重新抽取（换了提示词或模型时用）。 */
export async function enqueueImports(urls: string[], actor: string): Promise<{ queued: number; skipped: number }> {
  const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/.test(u)))].slice(0, 200);
  let queued = 0;
  for (const url of clean) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO policy_imports (url, requested_by)
      SELECT ${url}, ${actor} WHERE NOT EXISTS (SELECT 1 FROM policy_imports WHERE url = ${url} AND status = 'pending')
      RETURNING id`;
    if (row) queued += 1;
  }
  return { queued, skipped: urls.length - queued };
}

/** 后台“重新抽取”一份文件：它的每篇资料各登记一条，不再抓原文。 */
export async function enqueueReextract(docId: number, actor: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO policy_imports (url, article_id, requested_by)
    SELECT a.url, a.id, ${actor} FROM policy_links l JOIN articles a ON a.id = l.article_id
    WHERE l.doc_id = ${docId} AND NOT EXISTS (SELECT 1 FROM policy_imports p WHERE p.article_id = a.id AND p.status = 'pending')
    RETURNING id`;
  return rows.length;
}

/** 定时任务：每分钟处理几条登记的导入。模型调用关着或暂停时不做；服务拒绝、熔断时留到下次。 */
export async function processImports(): Promise<{ done: number; failed: number }> {
  if (!(await modelCallsOn())) return { done: 0, failed: 0 };
  const rows = await sql<{ id: number; url: string; article_id: string | null }[]>`
    SELECT id, url, article_id FROM policy_imports WHERE status = 'pending' ORDER BY id LIMIT ${BATCH}`;
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const articleId = r.article_id ?? (await fetchMaterial(r.url));
      const docId = await extractArticle(articleId);
      await sql`UPDATE policy_imports SET status = ${docId ? "document" : "not_document"}, article_id = ${articleId}, doc_id = ${docId}, error = NULL, updated_at = now() WHERE id = ${r.id}`;
      done += 1;
    } catch (error) {
      if (error instanceof ProviderRejectedError || error instanceof BudgetExceededError || error instanceof ReceiptBusyError) break;
      failed += 1;
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      await sql`UPDATE policy_imports SET status = 'failed', error = ${message}, updated_at = now() WHERE id = ${r.id}`;
      console.error(JSON.stringify({ level: "warn", msg: "policy import failed", url: r.url, err: logError(error) }));
    }
  }
  return { done, failed };
}

/** 首批种子（seeds.txt）里的网址，后台一键填入。 */
export function seedUrls(): string[] {
  return readFileSync(new URL("../seeds.txt", import.meta.url), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
}
