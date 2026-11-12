// 项目商机的存取：采集服务发现的公告、附件拆出的项目、页面和后台读的形状。时间、金额照抄来源原文。
import { sql } from "@aihot/backend/db";
import { beijingAt } from "@aihot/contracts/time";
import { SOURCE_NAMES } from "../types.ts";
import type {
  CeilingKind, FetcherNotice, FetcherResult, NoticeDetails, OpportunityCard, OpportunityItem, OpportunityListResponse,
  OpportunityNotice, OpportunityNoticeDetail, SourceKey, Verdict,
} from "../types.ts";

const PAGE = 30;
/** 失败后半小时再试，再失败两小时后再试，第 3 次失败后不再自动试。 */
export const MAX_ATTEMPTS = 3;

export const noticeId = (n: Pick<FetcherNotice, "source" | "external_id">) => `${n.source}-${n.external_id}`;

interface NoticeRow {
  id: string; source: SourceKey; category: string; url: string; title: string; batch: string; buyer: string; published: string;
  file_deadline: string; opening_time: string; status: string; error: string; attempts: number; item_count: number;
  package_count: number; warnings: string[]; screened: boolean; backfill: boolean; discovered_at: Date; pushed_at: Date | null;
  source_name: string; details: NoticeDetails | null;
}

/** 国网两个平台用代码里的名称，其他招采平台用信源名。 */
export const sourceName = (n: { source: SourceKey; source_name: string }) => n.source_name || SOURCE_NAMES[n.source] || n.source;

/** 截止看采购文件获取截止；来源没写时看公告正文里抽出的投标（响应）截止。 */
export const deadlineOf = (n: { file_deadline: string; details: NoticeDetails | null }) =>
  n.file_deadline || n.details?.times.bidDeadline || n.details?.times.signupDeadline || "";

export interface ItemRow {
  id: string; notice_id: string; ordinal: number; section: string; section_name: string; package: string; subpackage: string;
  package_name: string; project_name: string; buyer: string; location: string; scope: string; qualifications: string;
  personnel: string; performance: string; ceiling: string; ceiling_kind: string; budget: string; pricing: string;
  evidence: Array<{ file: string; sheet: string; row: number }>; verdict: Verdict; line: string; reason: string; matched_by: string;
}

/** 来源写的“2026-11-13 09:00:00”按北京时间读；读不出的当作没有截止。 */
export function deadlineAt(text: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text.trim());
  if (!m) return null;
  const at = beijingAt(m[1]!, `${m[2] ?? "23"}:${m[3] ?? "59"}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function isExpired(fileDeadline: string, now = new Date()): boolean {
  const at = deadlineAt(fileDeadline);
  return at !== null && at.getTime() < now.getTime();
}

const meaningful = (s: string) => s.trim() !== "" && s.trim() !== "/";

export function packageLabel(i: Pick<ItemRow, "section" | "section_name" | "package" | "subpackage">): string {
  return [i.section_name || i.section, i.package, meaningful(i.subpackage) ? `子包 ${i.subpackage}` : ""].filter(meaningful).join(" · ");
}

/** 列表发现的公告：新的入库；已有的不动（详情里取到的字段更准）。第一轮的存量标 backfill，不实时推送。 */
export async function upsertDiscovered(notices: FetcherNotice[], backfill: boolean): Promise<number> {
  let added = 0;
  for (const n of notices) {
    const rows = await sql`
      INSERT INTO opp_notices (id, source, category, url, title, batch, buyer, published, backfill)
      VALUES (${noticeId(n)}, ${n.source}, ${n.category}, ${n.url}, ${n.title}, ${n.batch}, ${n.buyer}, ${n.published}, ${backfill})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    added += rows.length;
  }
  return added;
}

export async function hasNotices(source: SourceKey): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM opp_notices WHERE source = ${source} LIMIT 1`;
  return !!row;
}

/** 待取附件的公告，新的先取；失败的到点再试，最多 3 次。 */
export async function pendingNotices(limit: number): Promise<NoticeRow[]> {
  return sql<NoticeRow[]>`
    SELECT * FROM opp_notices
    WHERE (status = 'pending' OR (status = 'failed' AND attempts < ${MAX_ATTEMPTS})) AND next_attempt_at <= now()
    ORDER BY discovered_at DESC LIMIT ${limit}`;
}

/** 附件里没有需求表（只有 Word 公告）时，把整份公告当一个项目：名称用公告标题，采购内容用公告正文的开头。 */
function wholeNotice(result: FetcherResult): FetcherResult["items"] {
  const n = result.notice;
  return [{
    batch: n.batch, section: "", section_name: "", package: "", subpackage: "", package_name: "", project_name: n.title, buyer: n.buyer,
    location: "", scope: (result.text ?? "").slice(0, 1500), qualifications: "", personnel: "", performance: "", ceiling: "", ceiling_kind: "unknown",
    budget: "", pricing: "", warnings: ["附件里没有需求表，按整份公告判断"], evidence: [],
  }];
}

/** 附件解析结果落库：公告字段以详情为准，项目整批替换（重新抓取时以最新附件为准），等待筛选；公告正文留着抽要素。 */
export async function saveFetched(id: string, fetched: FetcherResult): Promise<number> {
  const result = fetched.items.length > 0 ? fetched : { ...fetched, items: wholeNotice(fetched), warnings: ["附件里没有需求表，按整份公告判断", ...fetched.warnings] };
  const n = result.notice;
  const meta = n.metadata ?? {};
  const packages = new Set(result.items.map((i) => `${i.section}\u0001${i.package}`)).size;
  await sql.begin(async (tx) => {
    await tx`UPDATE opp_notices SET title = ${n.title}, batch = ${n.batch}, buyer = ${n.buyer}, published = ${n.published},
        file_deadline = ${meta.procurement_file_deadline ?? ""}, opening_time = ${meta.opening_time ?? ""},
        status = ${result.complete ? "parsed" : "partial"}, error = '', file_sha256 = ${result.sha256},
        item_count = ${result.items.length}, package_count = ${packages}, warnings = ${tx.json(result.warnings.slice(0, 50) as never)},
        doc_text = ${result.text ?? ""}, details = NULL, details_failures = 0, screened = false, fetched_at = now()
      WHERE id = ${id}`;
    await tx`DELETE FROM opp_items WHERE notice_id = ${id}`;
    for (const [ordinal, i] of result.items.entries()) {
      const kind: CeilingKind = (["amount_wan", "amount_yuan", "percent"] as const).find((k) => k === i.ceiling_kind) ?? "unknown";
      await tx`INSERT INTO opp_items (notice_id, ordinal, section, section_name, package, subpackage, package_name, project_name, buyer,
          location, scope, qualifications, personnel, performance, ceiling, ceiling_kind, budget, pricing, evidence)
        VALUES (${id}, ${ordinal}, ${i.section}, ${i.section_name}, ${i.package}, ${i.subpackage}, ${i.package_name}, ${i.project_name || "（未写项目名称）"},
          ${i.buyer}, ${i.location}, ${i.scope}, ${i.qualifications}, ${i.personnel}, ${i.performance}, ${i.ceiling}, ${kind},
          ${i.budget}, ${i.pricing}, ${tx.json((i.evidence ?? []).slice(0, 4) as never)})`;
    }
  });
  return result.items.length;
}

/** 取附件失败：需要人工的（登录、验证、没有公开附件）不再自动试，其余按间隔重试。 */
export async function markFailed(id: string, code: string, message: string): Promise<void> {
  const status = code === "no_attachment" ? "no_file" : ["needs_login", "captcha"].includes(code) ? "blocked" : "failed";
  await sql`UPDATE opp_notices SET status = ${status}, error = ${`${code}: ${message}`.slice(0, 500)}, attempts = attempts + 1,
      next_attempt_at = now() + CASE WHEN attempts = 0 THEN interval '30 minutes' ELSE interval '2 hours' END
    WHERE id = ${id}`;
}

export async function retryNotice(id: string): Promise<boolean> {
  const rows = await sql`UPDATE opp_notices SET status = 'pending', attempts = 0, error = '', next_attempt_at = now()
    WHERE id = ${id} AND source <> 'web' AND status IN ('failed', 'blocked', 'no_file', 'partial', 'parsed') RETURNING id`;
  return rows.length > 0;
}

export async function unscreenedNotices(limit: number): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM opp_notices WHERE source <> 'web' AND status IN ('parsed', 'partial') AND NOT screened
    ORDER BY discovered_at DESC LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

export async function noticeItems(id: string): Promise<ItemRow[]> {
  return sql<ItemRow[]>`SELECT *, id::text AS id FROM opp_items WHERE notice_id = ${id} ORDER BY ordinal`;
}

export async function loadNotice(id: string): Promise<NoticeRow | null> {
  const [row] = await sql<NoticeRow[]>`SELECT * FROM opp_notices WHERE id = ${id}`;
  return row ?? null;
}

type CardRow = ItemRow & { notice_title: string; notice_url: string; source: SourceKey; source_name: string; batch: string; file_deadline: string;
  opening_time: string; discovered_at: Date; notice_buyer: string; details: NoticeDetails | null };

/** 采购内容：项目自己写的；其他平台的资料没有需求表，有标包的用标包范围。 */
function scopeOf(i: CardRow): string {
  const lots = (i.details?.lots ?? []).map((l) => [l.name, l.scope].filter(Boolean).join("：")).filter(Boolean);
  return i.source === "web" && lots.length ? lots.join("；") : i.scope;
}

function card(i: CardRow, now: Date): OpportunityCard {
  const scope = scopeOf(i);
  return {
    id: i.id, noticeId: i.notice_id, source: i.source, sourceName: sourceName(i), noticeTitle: i.notice_title, batch: i.batch,
    projectName: i.project_name, packageLabel: packageLabel(i), packageName: i.package_name, buyer: i.buyer || i.notice_buyer,
    location: i.location || i.details?.region || "",
    scopeExcerpt: scope.length > 160 ? `${scope.slice(0, 160)}…` : scope, ceiling: i.ceiling, ceilingKind: i.ceiling_kind as CeilingKind,
    verdict: i.verdict, line: i.line, reason: i.reason, fileDeadline: i.file_deadline, openingTime: i.opening_time,
    bidDeadline: i.details?.times.bidDeadline ?? "", noticeBudget: i.details?.budget ?? "",
    expired: isExpired(deadlineOf(i), now), discoveredAt: i.discovered_at.toISOString(), noticeUrl: i.notice_url,
  };
}

const VIEWS: Record<string, Verdict[]> = { focus: ["relevant", "maybe"], relevant: ["relevant"], maybe: ["maybe"], all: ["relevant", "maybe", "irrelevant"] };

export async function listOpportunities(q: { view?: string; source?: string; line?: string; q?: string; page?: number }, lines: string[], now = new Date()): Promise<OpportunityListResponse> {
  const verdicts = VIEWS[q.view ?? "focus"] ?? VIEWS.focus!;
  const source = q.source === "ecp" || q.source === "etp" || q.source === "web" ? q.source : null;
  const line = q.line && lines.includes(q.line) ? q.line : null;
  const search = (q.q ?? "").trim().slice(0, 40);
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const page = Math.max(1, Math.min(Number.isInteger(q.page) ? q.page! : 1, 1000));
  const where = sql`i.verdict = ANY(${verdicts}) AND (${source}::text IS NULL OR n.source = ${source})
    AND (${line}::text IS NULL OR i.line = ${line})
    AND (${search} = '' OR i.project_name ILIKE ${like} OR i.package_name ILIKE ${like} OR i.scope ILIKE ${like} OR i.buyer ILIKE ${like} OR n.buyer ILIKE ${like} OR n.title ILIKE ${like} OR n.source_name ILIKE ${like})`;
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id WHERE ${where}`;
  const rows = await sql<Parameters<typeof card>[0][]>`
    SELECT i.*, i.id::text AS id, n.title AS notice_title, n.url AS notice_url, n.source, n.source_name, n.batch, n.file_deadline, n.opening_time,
      n.discovered_at, n.buyer AS notice_buyer, n.details
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id WHERE ${where}
    ORDER BY n.discovered_at DESC, i.ordinal LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`;
  const total = count?.n ?? 0;
  return { items: rows.map((r) => card(r, now)), total, page, pages: Math.max(1, Math.ceil(total / PAGE)), lines };
}

function publicNotice(n: NoticeRow): OpportunityNotice {
  return {
    id: n.id, source: n.source, sourceName: sourceName(n), title: n.title, batch: n.batch, buyer: n.buyer, published: n.published, fileDeadline: n.file_deadline,
    openingTime: n.opening_time, url: n.url, status: n.status, warnings: n.warnings.slice(0, 20), itemCount: n.item_count,
    packageCount: n.package_count, discoveredAt: n.discovered_at.toISOString(), details: n.details,
  };
}

export async function noticeDetail(id: string, now = new Date()): Promise<OpportunityNoticeDetail | null> {
  const n = await loadNotice(id);
  if (!n) return null;
  const items = await noticeItems(id);
  const full = (i: ItemRow): OpportunityItem => ({
    ...card({ ...i, notice_title: n.title, notice_url: n.url, source: n.source, source_name: n.source_name, batch: n.batch,
      file_deadline: n.file_deadline, opening_time: n.opening_time, discovered_at: n.discovered_at, notice_buyer: n.buyer, details: n.details }, now),
    scope: i.scope, qualifications: i.qualifications, personnel: i.personnel, performance: i.performance, budget: i.budget,
    pricing: i.pricing, evidence: i.evidence,
  });
  return {
    notice: publicNotice(n),
    items: items.filter((i) => i.verdict === "relevant" || i.verdict === "maybe").map(full),
    others: items.filter((i) => i.verdict !== "relevant" && i.verdict !== "maybe")
      .map((i) => ({ id: i.id, projectName: i.project_name, packageLabel: packageLabel(i), verdict: i.verdict })),
  };
}

export async function recentNotices(limit = 50) {
  const rows = await sql<(NoticeRow & { relevant: number; maybe: number; pushed_groups: string[] })[]>`
    SELECT n.*, count(*) FILTER (WHERE i.verdict = 'relevant')::int AS relevant, count(*) FILTER (WHERE i.verdict = 'maybe')::int AS maybe,
      (SELECT coalesce(array_agg(g.name ORDER BY g.id), '{}') FROM opp_pushes p JOIN opp_push_groups g ON p.key = 'g' || g.id || ':notice:' || n.id
        WHERE p.status = 'sent') AS pushed_groups
    FROM opp_notices n LEFT JOIN opp_items i ON i.notice_id = n.id
    WHERE n.source <> 'web'
    GROUP BY n.id ORDER BY n.discovered_at DESC LIMIT ${limit}`;
  return rows.map((n) => ({
    id: n.id, source: n.source, title: n.title, status: n.status, error: n.error, url: n.url, itemCount: n.item_count,
    relevant: n.relevant, maybe: n.maybe, discoveredAt: n.discovered_at.toISOString(), pushedAt: n.pushed_at?.toISOString() ?? null,
    pushedGroups: n.pushed_groups, backfill: n.backfill,
  }));
}

export async function counts() {
  const [row] = await sql<{ pending: number; failed: number; relevant: number; maybe: number }[]>`
    SELECT (SELECT count(*) FROM opp_notices WHERE status = 'pending')::int AS pending,
      (SELECT count(*) FROM opp_notices WHERE status IN ('failed', 'blocked'))::int AS failed,
      (SELECT count(*) FROM opp_items WHERE verdict = 'relevant')::int AS relevant,
      (SELECT count(*) FROM opp_items WHERE verdict = 'maybe')::int AS maybe`;
  return row!;
}

/** 无关和没筛的项目只留 90 天（相关、待确认的一直留着）；没有项目的旧公告也一起删。 */
export async function retention(): Promise<Record<string, unknown>> {
  const items = await sql`DELETE FROM opp_items WHERE verdict IN ('irrelevant', 'pending') AND created_at < now() - interval '90 days'`;
  const notices = await sql`DELETE FROM opp_notices n WHERE discovered_at < now() - interval '90 days'
    AND NOT EXISTS (SELECT 1 FROM opp_items i WHERE i.notice_id = n.id)`;
  return { opportunityItemsRemoved: items.count, opportunityNoticesRemoved: notices.count };
}
