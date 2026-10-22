// Topic tags gaining attention: how many listed reports used each over the last seven days, against the
// seven before. The site's channels name their automatic topics from it; no model is called.
import type { CategoryKey } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { cachedByKey } from "../lib/cache.ts";
import { categoriesCondition } from "./items.ts";
import { listedCondition } from "./scope.ts";

export interface TrendingTag {
  tag: string;
  /** Listed reports with the tag in the last seven days. */
  recent: number;
  /** The same in the seven days before. */
  before: number;
}

const WEEK_MS = 7 * 86400_000;
/** Fewer uses than this in the last week is no topic yet. */
const MIN_RECENT = 2;

export interface TrendingQuery {
  categories: readonly CategoryKey[];
  /** The tags that may become topics (the pack's topic tags). */
  tags: readonly string[];
  limit: number;
}

/** The tags used most in the last week, a rise over the week before counting once more; ties by name. */
export async function readTrendingTags(q: TrendingQuery, now = new Date()): Promise<TrendingTag[]> {
  if (!q.tags.length) return [];
  const rows = await sql<TrendingTag[]>`
    SELECT t AS tag,
      count(*) FILTER (WHERE p.timeline_at > ${new Date(now.getTime() - WEEK_MS)})::int AS recent,
      count(*) FILTER (WHERE p.timeline_at <= ${new Date(now.getTime() - WEEK_MS)})::int AS before
    FROM publications p CROSS JOIN LATERAL unnest(p.tags) t
    WHERE ${listedCondition(now)} ${categoriesCondition(q.categories)}
      AND p.timeline_at > ${new Date(now.getTime() - 2 * WEEK_MS)} AND t = ANY(${q.tags as string[]})
    GROUP BY t`;
  const score = (r: TrendingTag) => r.recent + Math.max(0, r.recent - r.before);
  return rows.filter((r) => r.recent >= MIN_RECENT)
    .sort((a, b) => score(b) - score(a) || b.recent - a.recent || a.tag.localeCompare(b.tag))
    .slice(0, q.limit);
}

/** The same, kept an hour: readers' pages read it, and topics need not move faster than that. */
export const loadTrendingTags = cachedByKey(
  (q: TrendingQuery) => JSON.stringify([q.categories, q.tags, q.limit]),
  (q: TrendingQuery) => readTrendingTags(q),
  { freshMs: 3600_000, maxStaleMs: 3600_000, maxKeys: 20 },
);
