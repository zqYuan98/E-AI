// 其他招采平台：信源里打了“招标”“招标计划”标签的资料（南网、三峡、电建、公共资源交易……），一条资料当一份公告、一个项目，
// 和国网的项目一起筛选、抽要素、推送。只收还能投的：打了“中标”标签的信源，以及标题是中标、成交、候选人公示、
// 更正、终止这类的不收。正文还在抓的等两小时，没等到就用摘要。
import { sql } from "@aihot/backend/db";

const TAGS = ["招标", "招标计划"];
const RESULT_TAGS = ["中标"];
/** 标题里出现这些词的是结果或变更公告。 */
export const NOT_OPEN = "中标|成交|候选人|结果公[告示]|废标|流标|终止|撤销|更正|澄清|变更|延期";
/** 只看最近这么多天发现的资料；第一次启用时这些都算存量，只入库、不实时推。 */
const DAYS = 7;
const MAX_TEXT = 30_000;
const BATCH = 500;

export async function trackArticles(): Promise<number> {
  const [state] = await sql<{ first: boolean }[]>`SELECT NOT EXISTS (SELECT 1 FROM opp_notices WHERE source = 'web') AS first`;
  const rows = await sql`
    WITH added AS (
      INSERT INTO opp_notices (id, source, source_name, category, url, title, published, status, doc_text, item_count, discovered_at, fetched_at, backfill)
      SELECT 'web-' || a.id, 'web', s.name, 'tender', a.url, a.title,
        coalesce(to_char(a.published_at AT TIME ZONE INTERVAL '+08:00', 'YYYY-MM-DD'), ''), 'parsed',
        left(coalesce(nullif(a.body_text, ''), a.excerpt, ''), ${MAX_TEXT}), 1, a.discovered_at, now(), ${state!.first}
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE s.tags && ${TAGS}::text[] AND NOT (s.tags && ${RESULT_TAGS}::text[])
        AND a.discovered_at > now() - make_interval(days => ${DAYS})
        AND a.title !~ ${NOT_OPEN}
        AND (a.body_status <> 'pending' OR a.discovered_at < now() - interval '2 hours')
        AND NOT EXISTS (SELECT 1 FROM opp_notices o WHERE o.id = 'web-' || a.id)
      ORDER BY a.discovered_at DESC LIMIT ${BATCH}
      ON CONFLICT (id) DO NOTHING
      RETURNING id, title, doc_text)
    INSERT INTO opp_items (notice_id, ordinal, project_name, scope)
    SELECT id, 0, title, left(doc_text, 1500) FROM added RETURNING notice_id`;
  return rows.length;
}
