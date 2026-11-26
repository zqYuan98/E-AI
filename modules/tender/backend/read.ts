// 招采申报列表：公开层里“招采申报”类、现在仍公开的资料（publication/scope.ts listedCondition），配上认出来的要素。
// 可投标、申报通知按截止时间由近到远，已截止的默认不列（可以切出来看）；结果、前期和其他按发布时间新的在前。
import { sql } from "@aihot/backend/db";
import { listedCondition } from "@aihot/backend/publication/scope";
import { publicSourceName } from "@aihot/backend/publication/rules";
import { FOCUS, FOCUS_REGIONS, VIEWS, type TenderFacts, type TenderListResponse, type TenderRow, type TenderStage, type TenderView } from "../types.ts";
import { CATEGORY, CATEGORY_KNOWN } from "./store.ts";

const STAGES: Record<TenderView, readonly TenderStage[]> = {
  open: ["tender", "change"], result: ["candidate", "award", "ended"], early: ["early", "plan"], call: ["call"], other: [],
};
/** 没认出截止时间的招标公告，发布这么多天以内的还算可投标。 */
const UNKNOWN_OPEN_DAYS = 21;
/** 各视图往回看多少天。 */
const WINDOW_DAYS = 90;
const PAGE = 200;
const DAY = 86_400_000;

export interface TenderFilters { view?: string; region?: string; q?: string; past?: string }

interface Row {
  id: string; title: string; url: string; source_name: string; published_at: Date | null; timeline_at: Date; selected: boolean;
  facts: TenderFacts;
}

export async function listTenders(f: TenderFilters, now = new Date()): Promise<TenderListResponse> {
  const view: TenderView = (VIEWS as readonly string[]).includes(f.view ?? "") ? f.view as TenderView : "open";
  const region = f.region === FOCUS ? FOCUS : f.region?.trim().slice(0, 12) || null;
  const q = f.q?.trim().slice(0, 40) || null;
  const past = f.past === "1";
  const empty: TenderListResponse = { view, region, q, past, views: VIEWS.map((key) => ({ key, count: 0 })), regions: [], rows: [], hiddenPast: 0, now: now.toISOString() };
  if (!CATEGORY_KNOWN) return empty;

  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const unknownSince = new Date(now.getTime() - UNKNOWN_OPEN_DAYS * DAY);
  const at = sql`coalesce(p.published_at, p.discovered_at)`;
  // Still open: the deadline is ahead, or none was found on a notice recent enough to be running.
  const open = sql`(t.deadline_at >= ${now} OR (t.deadline_at IS NULL AND ${at} >= ${unknownSince}))`;
  const inView = (v: TenderView) => (v === "other" ? sql`t.stage IS NULL` : sql`t.stage IN ${sql(STAGES[v] as string[])}`);
  const timed = (v: TenderView) => v === "open" || v === "call";
  const regionCondition = region === FOCUS ? sql`AND t.region IN ${sql(FOCUS_REGIONS as string[])}` : region ? sql`AND t.region = ${region}` : sql``;
  const qCondition = q
    ? sql`AND strpos(p.title || ' ' || coalesce(p.original_title, '') || ' ' || coalesce(t.facts->>'purchaser', '') || ' ' || coalesce(t.facts->>'winner', '') || ' ' || coalesce(t.facts->>'agent', ''), ${q}) > 0`
    : sql``;
  const base = sql`
    FROM publications p
    JOIN sources s ON s.id = p.source_id
    JOIN tender_facts t ON t.article_id = p.article_id
    WHERE ${listedCondition(now)} AND p.category = ${CATEGORY} AND ${at} >= ${since}`;

  const [counts] = await sql<Array<Record<TenderView, number> & { past: number }>>`
    SELECT
      count(*) FILTER (WHERE ${inView("open")} AND ${open})::int AS open,
      count(*) FILTER (WHERE ${inView("result")})::int AS result,
      count(*) FILTER (WHERE ${inView("early")})::int AS early,
      count(*) FILTER (WHERE ${inView("call")} AND ${open})::int AS call,
      count(*) FILTER (WHERE ${inView("other")})::int AS other,
      count(*) FILTER (WHERE ${inView(view)} AND NOT ${open})::int AS past
    ${base} ${regionCondition} ${qCondition}`;
  const regions = await sql<Array<{ region: string; count: number }>>`
    SELECT t.region, count(*)::int AS count ${base} AND ${inView(view)} ${timed(view) && !past ? sql`AND ${open}` : sql``} AND t.region IS NOT NULL ${qCondition}
    GROUP BY t.region`;
  const order = timed(view)
    ? sql`ORDER BY ${open} DESC, CASE WHEN ${open} THEN t.deadline_at END ASC NULLS LAST, CASE WHEN NOT ${open} THEN t.deadline_at END DESC NULLS LAST, ${at} DESC, p.article_id`
    : sql`ORDER BY ${at} DESC, p.article_id`;
  const rows = await sql<Row[]>`
    SELECT p.article_id AS id, p.title, p.url, s.name AS source_name, p.published_at, p.timeline_at, p.selected, t.facts
    ${base} AND ${inView(view)} ${timed(view) && !past ? sql`AND ${open}` : sql``} ${regionCondition} ${qCondition}
    ${order}
    LIMIT ${PAGE}`;

  const focus = new Set(FOCUS_REGIONS);
  return {
    ...empty,
    views: VIEWS.map((key) => ({ key, count: counts?.[key] ?? 0 })),
    regions: regions.map((r) => ({ region: r.region, count: r.count })).sort((a, b) => Number(focus.has(b.region)) - Number(focus.has(a.region)) || b.count - a.count || a.region.localeCompare(b.region, "zh")),
    rows: rows.map((r): TenderRow => ({
      id: r.id, title: r.title, url: r.url, source: publicSourceName(r.source_name),
      publishedAt: r.published_at?.toISOString() ?? null, timelineAt: r.timeline_at.toISOString(), selected: r.selected, facts: r.facts,
    })),
    hiddenPast: timed(view) && !past ? counts?.past ?? 0 : 0,
  };
}

/** 一篇资料认出来的要素（条目页用），只在它仍在公开列表里、属于招采申报类时给出。 */
export async function tenderFactsFor(articleId: string, now = new Date()): Promise<TenderFacts | null> {
  if (!CATEGORY_KNOWN) return null;
  const [row] = await sql<Array<{ facts: TenderFacts }>>`
    SELECT t.facts FROM publications p JOIN tender_facts t ON t.article_id = p.article_id
    WHERE p.article_id = ${articleId} AND p.category = ${CATEGORY} AND ${listedCondition(now)}`;
  return row?.facts ?? null;
}
