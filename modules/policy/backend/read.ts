// 政策规划库的读取：列表（带筛选）、关键目标对照表（只收写明目标年份的）、单份文件的详情和它的原文、解读、报道。
// 资料在公开层被撤回的，不出现在“相关报道”里；主资料被撤回的文件整份不出现。能在站内打开的报道给出站内地址。
import { sql } from "@aihot/backend/db";
import { listedCondition } from "@aihot/backend/publication/scope";
import { POLICY_LEVELS, POLICY_TYPES, type AiRelevance, type PolicyDocCard, type PolicyDocDetail, type PolicyLevel, type PolicyListResponse, type PolicyTarget, type PolicyTargetRow, type PolicyType } from "../types.ts";

interface DocRow {
  id: number; name: string; doc_type: PolicyType; level: PolicyLevel; issuers: string[]; doc_no: string | null; issued_on: string | null;
  summary: string; targets: PolicyTarget[]; tasks: Array<{ text: string; quote: string }>; ai_clauses: Array<{ text: string; quote: string }>;
  ai_relevance: AiRelevance; primary_article_id: string; url: string; published_at: Date | null;
}

const columns = sql`d.id, d.name, d.doc_type, d.level, d.issuers, d.doc_no, to_char(d.issued_on, 'YYYY-MM-DD') AS issued_on, d.summary, d.targets, d.tasks,
  d.ai_clauses, d.ai_relevance, d.primary_article_id, a.url, a.published_at`;

// 主资料在公开层被撤回（withdrawn）的文件不显示；只收进政策库、没有发布记录的主资料照常显示。
const visible = sql`NOT EXISTS (SELECT 1 FROM publications pv WHERE pv.article_id = d.primary_article_id AND pv.visibility = 'withdrawn')`;

function card(r: DocRow): PolicyDocCard {
  return {
    id: r.id, name: r.name, docType: r.doc_type, level: r.level, issuers: r.issuers, docNo: r.doc_no,
    date: r.issued_on ?? r.published_at?.toISOString().slice(0, 10) ?? null, summary: r.summary, aiRelevance: r.ai_relevance,
    targetCount: r.targets.length, aiClauseCount: r.ai_clauses.length,
  };
}

export interface PolicyFilters { level?: string; type?: string; ai?: string; q?: string }

export async function listPolicies(f: PolicyFilters): Promise<PolicyListResponse> {
  const level = f.level && f.level in POLICY_LEVELS ? f.level : null;
  const type = f.type && (POLICY_TYPES as readonly string[]).includes(f.type) ? f.type : null;
  const ai = f.ai === "core" ? ["core"] : f.ai === "any" ? ["core", "partial"] : null;
  const q = f.q?.trim().slice(0, 40) || null;
  const rows = await sql<DocRow[]>`
    SELECT ${columns} FROM policy_docs d JOIN articles a ON a.id = d.primary_article_id
    WHERE ${visible}
      AND (${level}::text IS NULL OR d.level = ${level})
      AND (${type}::text IS NULL OR d.doc_type = ${type})
      AND (${ai}::text[] IS NULL OR d.ai_relevance = ANY(${ai}::text[]))
      AND (${q}::text IS NULL OR strpos(d.name || ' ' || d.summary || ' ' || coalesce(d.doc_no, ''), ${q}) > 0)
    ORDER BY coalesce(d.issued_on, a.published_at::date) DESC NULLS LAST, d.id DESC
    LIMIT 300`;
  const targets: PolicyTargetRow[] = rows
    .filter((r) => r.level === "national" || r.level === "sgcc" || r.level === "csg")
    .flatMap((r) => r.targets.filter((t) => t.year).map((t) => ({ ...t, docId: r.id, docName: r.name, level: r.level })))
    .sort((a, b) => a.year!.localeCompare(b.year!));
  return { docs: rows.map(card), targets };
}

export async function loadPolicy(id: number): Promise<PolicyDocDetail | null> {
  const [r] = await sql<DocRow[]>`SELECT ${columns} FROM policy_docs d JOIN articles a ON a.id = d.primary_article_id WHERE d.id = ${id} AND ${visible}`;
  if (!r) return null;
  const now = new Date();
  const reports = await sql<{ title: string; source: string; url: string; role: string; item_id: string | null; at: Date | null }[]>`
    SELECT a.title, s.name AS source, a.url, l.role, CASE WHEN p.article_id IS NOT NULL AND ${listedCondition(now)} THEN a.id END AS item_id,
      coalesce(a.published_at, a.discovered_at) AS at
    FROM policy_links l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id
    LEFT JOIN publications p ON p.article_id = a.id
    WHERE l.doc_id = ${id} AND (p.article_id IS NULL OR p.visibility = 'public')
    ORDER BY CASE l.role WHEN 'original' THEN 0 WHEN 'interpretation' THEN 1 ELSE 2 END, at DESC
    LIMIT 30`;
  return {
    ...card(r), targets: r.targets, tasks: r.tasks, aiClauses: r.ai_clauses, url: r.url,
    reports: reports.map((x) => ({ title: x.title, source: x.source, url: x.url, role: x.role, itemId: x.item_id, at: x.at?.toISOString() ?? null })),
  };
}
