// 政策规划库的入库：从已抓到正文的资料里挑出候选（政策规划类信源的全部资料，以及标题像正式文件的资料），
// 让模型判断是不是政策规划类文件并抽取要素，再逐项回原文核对：原话、文号、日期、发文单位在正文里找不到的一律不存。
// 同一份文件的原文、解读和报道归到一行；先到的报道、后到的原文，要素换成从原文抽的。
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@aihot/backend/providers/receipts";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import { POLICY_LEVELS, POLICY_TYPES } from "../types.ts";

/** 信源打了这个标签，它的资料都送去判断；其他信源只送标题像正式文件的。 */
export const POLICY_TAG = "政策规划";
const DOC_TITLE = "(规划|行动方案|实施意见|指导意见|行动计划|管理办法|管理规定|白皮书|专项行动|工作要点)";
const MAX_BODY = 24_000;
const BATCH = 30;
const MAX_ATTEMPTS = 3;

const Quote = z.string().max(400);
export const ExtractSchema = z.object({
  isDocument: z.boolean(),
  role: z.enum(["original", "interpretation", "report"]).nullable().catch(null),
  documentName: z.string().max(200).nullable().catch(null),
  docType: z.enum(POLICY_TYPES).catch("其他"),
  level: z.enum(Object.keys(POLICY_LEVELS) as [keyof typeof POLICY_LEVELS]).catch("other"),
  issuers: z.array(z.string().max(60)).max(8).catch([]),
  docNo: z.string().max(60).nullable().catch(null),
  issuedOn: z.string().nullable().catch(null),
  summary: z.string().max(600).catch(""),
  targets: z.array(z.object({ metric: z.string().max(80), value: z.string().max(60), year: z.string().max(10).nullable().catch(null), quote: Quote })).max(12).catch([]),
  tasks: z.array(z.object({ text: z.string().max(80), quote: Quote })).max(12).catch([]),
  aiClauses: z.array(z.object({ text: z.string().max(80), quote: Quote })).max(12).catch([]),
  aiRelevance: z.enum(["core", "partial", "none"]).catch("none"),
});
export type Extracted = z.infer<typeof ExtractSchema>;

interface Candidate { id: string; title: string; url: string; body_text: string; published_at: Date | null; source_name: string; attempts: number }

/** 比较用：去掉空白和常见的全半角差异。 */
export const squash = (s: string) => s.replace(/\s+/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",").toLowerCase();

/**
 * 文件名作为合并依据：“某某印发《X》的通知”取 X，“某某部门关于……”从“关于”取起（同一份文件有的写发文单位、有的不写），
 * 再去掉书名号、标点和空白。
 */
export function docKey(name: string): string {
  const inner = /印发《([^》]+)》/.exec(name)?.[1];
  const core = inner ?? (name.includes("关于") ? name.slice(name.indexOf("关于")) : name);
  return squash(core).replace(/[《》<>"'()\[\]【】、，,。.:：;；·\-—_]/g, "");
}

/** 把模型的抽取结果对回原文：找不到原话的条目丢掉，文号、日期、发文单位不在原文里就置空。 */
export function ground(out: Extracted, material: { title: string; body: string; source: string }): Extracted {
  const text = squash(`${material.title}\n${material.body}`);
  // 文件名是合并依据：它的核心（docKey 取的那一段）要在原文里、且不短于 6 个字（“工作会议”这类泛称分不开文件），
  // 否则编出来或太泛的名字会把不同文件合成一份；不满足就按单篇资料建档。
  const bare = (s: string) => squash(s).replace(/[《》<>"'()\[\]【】、，,。.:：;；·\-—_]/g, "");
  const nameFound = !!out.documentName?.trim() && docKey(out.documentName).length >= 6 && bare(text).includes(docKey(out.documentName));
  const has = (s: string | null | undefined) => !!s && squash(s).length >= 2 && text.includes(squash(s));
  const quoted = (q: string) => squash(q).length >= 6 && !/\.\.\.|…/.test(q) && text.includes(squash(q));
  const date = (() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(out.issuedOn ?? "");
    if (!m) return null;
    const [y, mo, d] = [m[1]!, String(Number(m[2])), String(Number(m[3]))];
    const forms = [`${y}年${mo}月${d}日`, `${y}-${m[2]}-${m[3]}`, `${y}.${m[2]}.${m[3]}`, `${y}/${m[2]}/${m[3]}`, `${y}年${m[2]}月${m[3]}日`];
    return forms.some((f) => text.includes(squash(f))) ? out.issuedOn : null;
  })();
  return {
    ...out,
    documentName: nameFound ? out.documentName!.trim() : null,
    level: levelOf(out, material.title),
    docNo: has(out.docNo) ? out.docNo!.trim() : null,
    issuedOn: date,
    issuers: out.issuers.map((s) => s.trim()).filter((s) => s && (has(s) || squash(material.source).includes(squash(s)))).slice(0, 5),
    // 目标年份也要在原话里，否则不进按年份排的对照表（目标本身保留）。
    targets: out.targets.filter((t) => quoted(t.quote) && squash(t.quote).includes(squash(t.value)) && isTarget(t))
      .map((t) => (t.year && !squash(t.quote).includes(squash(t.year)) ? { ...t, year: null } : t)).slice(0, 8),
    tasks: out.tasks.filter((t) => quoted(t.quote)).slice(0, 8),
    aiClauses: out.aiClauses.filter((t) => quoted(t.quote)).slice(0, 8),
  };
}

/** 量化目标才进对照表：值里要有数字；申报截止、推荐名额、资格条件不算目标。 */
export function isTarget(t: { metric: string; value: string }): boolean {
  return /[0-9０-９一二三四五六七八九十百千万亿两半]/.test(t.value) && !/截止|报送|申报|推荐|名额|上传|资格|条件/.test(t.metric);
}

/** 发文主体写在文件名或发文单位里的两网，以它为准（模型常把一网的报道记到另一网）。 */
function levelOf(out: Extracted, title: string): Extracted["level"] {
  if (out.level === "national") return out.level;
  const who = `${out.documentName ?? title} ${out.issuers.join(" ")}`;
  const csg = /南方电网|南网|广东电网|广西电网|云南电网|贵州电网|海南电网|深圳供电/.test(who);
  const sgcc = /国家电网|国网/.test(who);
  if (csg && !sgcc) return "csg";
  if (sgcc && !csg) return "sgcc";
  return out.level;
}

/** 没有正式文件名的稿件用标题：去掉“--中国能源新闻网”“_某某网”这类网站后缀。 */
export const cleanTitle = (title: string) => title.replace(/\s*(?:-{2,}|——|_|\|)\s*[^-—_|]{2,20}(?:网|报|局|门户|频道|客户端)[^-—_|]{0,8}$/, "").trim();

async function candidates(): Promise<Candidate[]> {
  return sql<Candidate[]>`
    SELECT a.id, a.title, a.url, a.body_text, a.published_at, s.name AS source_name, coalesce(l.attempts, 0) AS attempts
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN policy_links l ON l.article_id = a.id
    WHERE a.body_status = 'ok' AND coalesce(a.body_text, '') <> ''
      AND (${POLICY_TAG} = ANY(s.tags) OR a.title ~ ${DOC_TITLE})
      AND (l.article_id IS NULL OR (l.outcome = 'failed' AND l.attempts < ${MAX_ATTEMPTS} AND l.checked_at < now() - interval '6 hours'))
    ORDER BY a.discovered_at DESC
    LIMIT ${BATCH}`;
}

/** 用模型读一篇资料；不是政策规划类返回 null。 */
export async function readDocument(c: Pick<Candidate, "id" | "title" | "body_text" | "source_name" | "published_at">): Promise<{ out: Extracted | null; receiptId: number }> {
  const body = c.body_text.length > MAX_BODY ? `${c.body_text.slice(0, MAX_BODY)}\n（后文未提供）` : c.body_text;
  const user = [`【来源】${c.source_name}`, `【稿件发布时间】${c.published_at?.toISOString().slice(0, 10) ?? "未知"}`, `【标题】${c.title}`, `【正文】\n${body}`].join("\n");
  const res = await chatJson({
    model: await modelFor("policy"),
    purpose: "policy_extract",
    subject: `article:${c.id}`,
    promptVersion: promptVersion("policy-extract"),
    system: promptText("policy-extract"),
    user,
    schema: ExtractSchema,
    temperature: 0.1,
    maxTokens: 3000,
  });
  if (!res.data.isDocument) return { out: null, receiptId: res.receiptId };
  return { out: ground(res.data, { title: c.title, body: c.body_text, source: c.source_name }), receiptId: res.receiptId };
}

/** 把一篇读过的资料存进库：同名文件合并，原文到了就用原文的要素。 */
export async function storeDocument(articleId: string, title: string, out: Extracted | null, receiptId: number | null): Promise<number | null> {
  return sql.begin(async (tx) => {
    if (!out) {
      const [previous] = await tx<{ doc_id: number | null }[]>`SELECT doc_id FROM policy_links WHERE article_id = ${articleId} FOR UPDATE`;
      await tx`INSERT INTO policy_links (article_id, outcome, receipt_id) VALUES (${articleId}, 'not_document', ${receiptId})
        ON CONFLICT (article_id) DO UPDATE SET outcome = 'not_document', doc_id = NULL, role = NULL, receipt_id = EXCLUDED.receipt_id, checked_at = now()`;
      if (previous?.doc_id) await releaseDocument(tx, previous.doc_id, articleId);
      return null;
    }
    const role = out.role ?? "report";
    const name = out.documentName?.trim() || cleanTitle(title);
    const key = out.documentName?.trim() ? docKey(out.documentName) : `article:${articleId}`;
    const fields = {
      name, doc_type: out.docType, level: out.level, issuers: out.issuers, doc_no: out.docNo, issued_on: out.issuedOn, summary: out.summary,
      targets: tx.json(out.targets as never), tasks: tx.json(out.tasks as never), ai_clauses: tx.json(out.aiClauses as never),
      ai_relevance: out.aiRelevance, primary_article_id: articleId, primary_role: role,
    };
    const [existing] = await tx<{ id: number; primary_role: string; doc_no: string | null; issued_on: Date | null }[]>`
      SELECT id, primary_role, doc_no, issued_on FROM policy_docs WHERE doc_key = ${key} FOR UPDATE`;
    let docId: number;
    if (!existing) {
      const [row] = await tx<{ id: number }[]>`INSERT INTO policy_docs ${tx({ doc_key: key, ...fields })} RETURNING id`;
      docId = row!.id;
    } else {
      docId = existing.id;
      // 原文胜过解读，解读胜过报道：更好的来源到了才换要素；文号和日期只补不丢。
      const rank = (r: string) => (r === "original" ? 2 : r === "interpretation" ? 1 : 0);
      if (rank(role) > rank(existing.primary_role)) {
        await tx`UPDATE policy_docs SET ${tx({ ...fields, doc_no: out.docNo ?? existing.doc_no, issued_on: out.issuedOn ?? existing.issued_on })}, updated_at = now() WHERE id = ${docId}`;
      } else if ((!existing.doc_no && out.docNo) || (!existing.issued_on && out.issuedOn)) {
        await tx`UPDATE policy_docs SET doc_no = coalesce(doc_no, ${out.docNo}), issued_on = coalesce(issued_on, ${out.issuedOn}), updated_at = now() WHERE id = ${docId}`;
      }
    }
    const [previous] = await tx<{ doc_id: number | null }[]>`SELECT doc_id FROM policy_links WHERE article_id = ${articleId} FOR UPDATE`;
    await tx`INSERT INTO policy_links (article_id, doc_id, role, outcome, receipt_id) VALUES (${articleId}, ${docId}, ${role}, 'document', ${receiptId})
      ON CONFLICT (article_id) DO UPDATE SET doc_id = EXCLUDED.doc_id, role = EXCLUDED.role, outcome = 'document', receipt_id = EXCLUDED.receipt_id, checked_at = now()`;
    if (previous?.doc_id && previous.doc_id !== docId) await releaseDocument(tx, previous.doc_id, articleId);
    return docId;
  });
}

/**
 * 一篇资料不再属于某份文件（重新抽取后换了文件、或判为不是文件）：那份文件没有别的资料就删掉，
 * 还有的话，以这篇为主资料时换成剩下里最好的一篇（原文 > 解读 > 报道）。
 */
async function releaseDocument(tx: Db, docId: number, articleId: string) {
  const [next] = await tx<{ article_id: string; role: string }[]>`
    SELECT article_id, role FROM policy_links WHERE doc_id = ${docId} AND article_id <> ${articleId}
    ORDER BY CASE role WHEN 'original' THEN 0 WHEN 'interpretation' THEN 1 ELSE 2 END, checked_at DESC LIMIT 1`;
  if (!next) await tx`DELETE FROM policy_docs WHERE id = ${docId}`;
  else await tx`UPDATE policy_docs SET primary_article_id = ${next.article_id}, primary_role = ${next.role}, updated_at = now() WHERE id = ${docId} AND primary_article_id = ${articleId}`;
}

/** 定时任务：每次处理一小批候选。模型调用关着时不做。 */
export async function extractPending(): Promise<{ checked: number; documents: number; failed: number }> {
  if (!(await modelCallsOn())) return { checked: 0, documents: 0, failed: 0 };
  let documents = 0;
  let failed = 0;
  const list = await candidates();
  for (const c of list) {
    try {
      const { out, receiptId } = await readDocument(c);
      if (await storeDocument(c.id, c.title, out, receiptId)) documents += 1;
    } catch (error) {
      // 服务拒绝（余额不足、限流）、预算熔断、回执占用：不是这篇资料的问题，整批停下，下次再来，不计失败次数。
      if (error instanceof ProviderRejectedError || error instanceof BudgetExceededError || error instanceof ReceiptBusyError) break;
      failed += 1;
      await sql`INSERT INTO policy_links (article_id, outcome, attempts) VALUES (${c.id}, 'failed', 1)
        ON CONFLICT (article_id) DO UPDATE SET outcome = 'failed', attempts = policy_links.attempts + 1, checked_at = now()`;
      console.error(JSON.stringify({ level: "warn", msg: "policy extract failed", articleId: c.id, err: logError(error) }));
    }
  }
  return { checked: list.length, documents, failed };
}

