// 后台“政策库管理”：导入网址、看导入结果；文件的隐藏、删除和重新抽取。每次改动写审计记录。
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { POLICY_LEVELS } from "../types.ts";
import { enqueueImports, enqueueReextract, seedUrls } from "./import.ts";

export interface AdminPolicyDoc {
  id: number; name: string; level: string; levelLabel: string; docType: string; docNo: string | null; date: string | null;
  aiRelevance: string; targets: number; aiClauses: number; links: number; hidden: boolean; updatedAt: Date;
}
export interface AdminPolicyImport { id: number; url: string; status: string; docId: number | null; docName: string | null; error: string | null; requestedBy: string; updatedAt: Date }

export async function policyAdmin() {
  const docs = await sql<{ id: number; name: string; level: string; doc_type: string; doc_no: string | null; date: string | null; ai_relevance: string; targets: number; ai_clauses: number; links: number; hidden: boolean; updated_at: Date }[]>`
    SELECT d.id, d.name, d.level, d.doc_type, d.doc_no, to_char(coalesce(d.issued_on, a.published_at::date), 'YYYY-MM-DD') AS date, d.ai_relevance,
           jsonb_array_length(d.targets) AS targets, jsonb_array_length(d.ai_clauses) AS ai_clauses,
           (SELECT count(*)::int FROM policy_links l WHERE l.doc_id = d.id) AS links, d.hidden, d.updated_at
    FROM policy_docs d LEFT JOIN articles a ON a.id = d.primary_article_id
    ORDER BY coalesce(d.issued_on, a.published_at::date) DESC NULLS LAST, d.id DESC LIMIT 500`;
  const imports = await sql<{ id: number; url: string; status: string; doc_id: number | null; doc_name: string | null; error: string | null; requested_by: string; updated_at: Date }[]>`
    SELECT p.id, p.url, p.status, p.doc_id, d.name AS doc_name, p.error, p.requested_by, p.updated_at
    FROM policy_imports p LEFT JOIN policy_docs d ON d.id = p.doc_id ORDER BY p.id DESC LIMIT 100`;
  const [counts] = await sql<{ pending: number; failed: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM policy_imports`;
  return {
    docs: docs.map((d): AdminPolicyDoc => ({
      id: d.id, name: d.name, level: d.level, levelLabel: POLICY_LEVELS[d.level as keyof typeof POLICY_LEVELS] ?? d.level, docType: d.doc_type, docNo: d.doc_no, date: d.date,
      aiRelevance: d.ai_relevance, targets: d.targets, aiClauses: d.ai_clauses, links: d.links, hidden: d.hidden, updatedAt: d.updated_at,
    })),
    imports: imports.map((p): AdminPolicyImport => ({ id: p.id, url: p.url, status: p.status, docId: p.doc_id, docName: p.doc_name, error: p.error, requestedBy: p.requested_by, updatedAt: p.updated_at })),
    pending: counts!.pending,
    failed: counts!.failed,
    seeds: seedUrls().length,
  };
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const needReason = (reason: string) => { if (!reason.trim()) throw bad("a reason is required"); };

export async function importUrls(input: { urls?: unknown; seeds?: unknown }, actor: string) {
  const urls = input.seeds === true ? seedUrls() : Array.isArray(input.urls) ? input.urls.map(String) : String(input.urls ?? "").split(/\s+/);
  if (!urls.some((u) => /^https?:\/\//.test(u.trim()))) throw bad("没有可导入的网址（每行一个 http(s) 网址）");
  const result = await enqueueImports(urls, actor);
  await audit(actor, "policy.import", "policy:imports", null, null, { queued: result.queued, seeds: input.seeds === true });
  return result;
}

/** 失败的导入再试一次。 */
export async function retryImport(id: number, actor: string) {
  const [row] = await sql<{ id: number }[]>`UPDATE policy_imports SET status = 'pending', error = NULL, requested_by = ${actor}, updated_at = now() WHERE id = ${id} AND status = 'failed' RETURNING id`;
  if (!row) throw bad("只有失败的导入可以重试");
  return { id };
}

export async function setDocHidden(id: number, hidden: boolean, reason: string, actor: string) {
  needReason(reason);
  const [row] = await sql<{ name: string }[]>`UPDATE policy_docs SET hidden = ${hidden}, updated_at = now() WHERE id = ${id} RETURNING name`;
  if (!row) throw bad("文件不存在");
  await audit(actor, hidden ? "policy.hide" : "policy.show", `policy:${id}`, reason, { hidden: !hidden }, { hidden, name: row.name });
  return { id, hidden };
}

/** 删除一份文件：它的资料记为“已排除”，定时抽取不会再把它们收回来。 */
export async function deleteDoc(id: number, reason: string, actor: string) {
  needReason(reason);
  const removed = await sql.begin(async (tx) => {
    await tx`UPDATE policy_links SET outcome = 'excluded', doc_id = NULL, role = NULL, checked_at = now() WHERE doc_id = ${id}`;
    const [doc] = await tx<{ name: string }[]>`DELETE FROM policy_docs WHERE id = ${id} RETURNING name`;
    return doc;
  });
  if (!removed) throw bad("文件不存在");
  await audit(actor, "policy.delete", `policy:${id}`, reason, { name: removed.name }, null);
  return { id };
}

export async function reextractDoc(id: number, reason: string, actor: string) {
  needReason(reason);
  const queued = await enqueueReextract(id, actor);
  if (!queued) throw bad("这份文件没有可以重新抽取的资料，或已经在排队");
  await audit(actor, "policy.reextract", `policy:${id}`, reason, null, { queued });
  return { id, queued };
}
