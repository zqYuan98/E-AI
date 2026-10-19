// 手动收录政策文件（首批种子、抓不到的原文）：读原文页正文，存成“政策规划·手动收录”信源的资料，再立即抽取入库。
//   node --env-file=.env modules/policy/scripts/import.ts <原文网址> [<原文网址> ...]
//   node --env-file=.env modules/policy/scripts/import.ts --file <每行一个网址的文本文件>
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import * as cheerio from "cheerio";
import { readable } from "@aihot/backend/content/extract";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { installModules } from "@aihot/backend/modules";
import { POLICY_TAG, readDocument, storeDocument } from "../backend/extract.ts";
import { policy } from "../server.ts";

// 模型步骤“policy”由模块登记，脚本单独运行时也要先装上。
installModules([policy]);

const SOURCE = "policy-manual";

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
const args = process.argv.slice(2);
const urls = args[0] === "--file" ? readFileSync(args[1]!, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)) : args;

await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
  VALUES (${SOURCE}, '政策规划·手动收录', 'external', '{}'::jsonb, 'T1', 'isolated', 1440, true, 'ok', ${[POLICY_TAG]})
  ON CONFLICT (id) DO NOTHING`;

for (const url of urls) {
  let res: Awaited<ReturnType<typeof guardedFetch>>;
  let body: ReturnType<typeof readable> = null;
  try {
    res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    if (res.status === 200) body = safeReadable(res.text(), res.url) ?? fromContainer(res.text(), res.url);
  } catch (error) {
    console.log(JSON.stringify({ url, status: `failed: ${String(error instanceof Error ? error.message : error).slice(0, 120)}` }));
    continue;
  }
  const html = res.text();
  if (!body) { console.log(JSON.stringify({ url, status: `no-body (${res.status})` })); continue; }
  const $ = cheerio.load(html);
  const title = ($("h1").first().text() || $('meta[property="og:title"]').attr("content") || $("title").text()).replace(/\s+/g, " ").trim().slice(0, 200);
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url, title, bodyHtml: body.html, bodyText: body.text, bodyStatus: "ok", via: "import",
    publishedAt: body.publishedAt ?? null, backfill: "reported-backfill",
  });
  const [a] = await sql<{ title: string; published_at: Date | null }[]>`SELECT title, published_at FROM articles WHERE id = ${articleId}`;
  const { out, receiptId } = await readDocument({ id: articleId, title: a!.title, body_text: body.text, source_name: "政策规划·手动收录", published_at: a!.published_at });
  const docId = await storeDocument(articleId, a!.title, out, receiptId);
  console.log(JSON.stringify({ url, articleId, docId, name: out?.documentName ?? null, targets: out?.targets.length ?? 0, aiClauses: out?.aiClauses.length ?? 0 }));
}
await stopBoss();
await closeDb();
