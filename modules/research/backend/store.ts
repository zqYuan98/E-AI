// 研报库的存取：批量导入（后台粘贴 JSON 或单篇填写）、站内列表与详情、后台的隐藏和删除。每次改动写审计记录。
// 只存元数据、摘要和带原话的要点；摘录有长度上限，不存全文和 PDF。
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import type { ResearchCard, ResearchDetail, ResearchListResponse, ResearchPoint } from "../types.ts";

const text = (max: number) => z.string().trim().max(max);
/** 一篇待导入的研报；同一个链接（或研报编号）再导入就是更新。 */
const Item = z.object({
  title: text(300).min(2),
  institution: text(100).default(""),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "date: YYYY-MM-DD").nullable().optional(),
  url: z.string().trim().url().refine((u) => /^https?:\/\//.test(u), "url must be http(s)"),
  summary: text(800).default(""),
  // 原话是研报里的一句摘录，限长：只引用，不搬运全文。
  points: z.array(z.object({ text: text(120).min(2), quote: text(200).min(4) })).max(12).default([]),
  topics: z.array(text(20).min(1)).max(6).default([]),
  djId: text(80).min(1).nullable().optional(),
}).strict();
export type ResearchImportItem = z.infer<typeof Item>;

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** 批量导入：每篇单独校验，不合格的记下原因，其余照常保存。 */
export async function importReports(raw: unknown, actor: string): Promise<{ created: number; updated: number; errors: Array<{ index: number; title: string | null; message: string }> }> {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { reports?: unknown }).reports) ? (raw as { reports: unknown[] }).reports : null;
  if (!list) throw bad("要导入的是一个 JSON 数组，每个元素是一篇研报");
  if (list.length === 0 || list.length > 200) throw bad("每次导入 1–200 篇");
  let created = 0;
  let updated = 0;
  const errors: Array<{ index: number; title: string | null; message: string }> = [];
  for (const [index, entry] of list.entries()) {
    const parsed = Item.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const title = entry && typeof entry === "object" && typeof (entry as { title?: unknown }).title === "string" ? (entry as { title: string }).title.slice(0, 80) : null;
      errors.push({ index, title, message: `${issue.path.join(".") || "item"}: ${issue.message}` });
      continue;
    }
    const r = parsed.data;
    const topics = [...new Set(r.topics)];
    // 研报编号相同、或链接相同，都是同一篇。
    const [existing] = await sql<{ id: number }[]>`
      SELECT id FROM research_reports WHERE url = ${r.url} OR (${r.djId ?? null}::text IS NOT NULL AND dj_id = ${r.djId ?? null}) LIMIT 1`;
    if (existing) {
      await sql`UPDATE research_reports SET title = ${r.title}, institution = ${r.institution}, published_on = ${r.date ?? null}, url = ${r.url},
        dj_id = coalesce(${r.djId ?? null}, dj_id), summary = ${r.summary}, points = ${sql.json(r.points as never)}, topics = ${topics}, updated_at = now()
        WHERE id = ${existing.id}`;
      updated += 1;
    } else {
      await sql`INSERT INTO research_reports (dj_id, url, title, institution, published_on, summary, points, topics, created_by)
        VALUES (${r.djId ?? null}, ${r.url}, ${r.title}, ${r.institution}, ${r.date ?? null}, ${r.summary}, ${sql.json(r.points as never)}, ${topics}, ${actor})`;
      created += 1;
    }
  }
  if (created || updated) await audit(actor, "research.import", "research:import", null, null, { created, updated, rejected: errors.length });
  return { created, updated, errors };
}

interface Row { id: number; title: string; institution: string; date: string | null; summary: string; topics: string[]; points: ResearchPoint[]; url: string; hidden: boolean }
const columns = sql`id, title, institution, to_char(published_on, 'YYYY-MM-DD') AS date, summary, topics, points, url, hidden`;
const card = (r: Row): ResearchCard => ({ id: r.id, title: r.title, institution: r.institution, date: r.date, summary: r.summary, topics: r.topics, pointCount: r.points.length });

export async function listReports(f: { q?: string; topic?: string }): Promise<ResearchListResponse> {
  const q = f.q?.trim().slice(0, 40) || null;
  const topic = f.topic?.trim().slice(0, 20) || null;
  const rows = await sql<Row[]>`
    SELECT ${columns} FROM research_reports
    WHERE NOT hidden
      AND (${topic}::text IS NULL OR ${topic} = ANY(topics))
      AND (${q}::text IS NULL OR strpos(title || ' ' || institution || ' ' || summary || ' ' || points::text, ${q}) > 0)
    ORDER BY published_on DESC NULLS LAST, id DESC LIMIT 300`;
  const topics = await sql<{ topic: string; count: number }[]>`
    SELECT t AS topic, count(*)::int AS count FROM research_reports, unnest(topics) AS t WHERE NOT hidden GROUP BY t ORDER BY 2 DESC, 1 LIMIT 30`;
  return { reports: rows.map(card), topics };
}

export async function loadReport(id: number): Promise<ResearchDetail | null> {
  const [r] = await sql<Row[]>`SELECT ${columns} FROM research_reports WHERE id = ${id} AND NOT hidden`;
  return r ? { ...card(r), url: r.url, points: r.points } : null;
}

export async function researchAdmin() {
  const rows = await sql<(Row & { created_by: string; updated_at: Date })[]>`
    SELECT ${columns}, created_by, updated_at FROM research_reports ORDER BY published_on DESC NULLS LAST, id DESC LIMIT 500`;
  return { reports: rows.map((r) => ({ ...card(r), url: r.url, hidden: r.hidden, createdBy: r.created_by, updatedAt: r.updated_at })) };
}

export async function setReportHidden(id: number, hidden: boolean, reason: string, actor: string) {
  if (!reason.trim()) throw bad("a reason is required");
  const [row] = await sql<{ title: string }[]>`UPDATE research_reports SET hidden = ${hidden}, updated_at = now() WHERE id = ${id} RETURNING title`;
  if (!row) throw bad("研报不存在");
  await audit(actor, hidden ? "research.hide" : "research.show", `research:${id}`, reason, { hidden: !hidden }, { hidden, title: row.title });
  return { id, hidden };
}

export async function deleteReport(id: number, reason: string, actor: string) {
  if (!reason.trim()) throw bad("a reason is required");
  const [row] = await sql<{ title: string }[]>`DELETE FROM research_reports WHERE id = ${id} RETURNING title`;
  if (!row) throw bad("研报不存在");
  await audit(actor, "research.delete", `research:${id}`, reason, { title: row.title }, null);
  return { id };
}
