// 定时把“招采申报”类资料认一遍（extract.ts）：新发布的、正文改过的、规则升级后旧的。只读库里已有的正文，
// 不联网、不调模型；认的结果存进 tender_facts，列表页和条目页只读这张表。
import { sql } from "@aihot/backend/db";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { EXTRACTOR_VERSION, extractTender } from "./extract.ts";

/** 本站“招采申报”这一类的 key（industry/taxonomy.ts）；行业包里没有这一类时，这个模块什么也不做。 */
export const CATEGORY = "procurement";
export const CATEGORY_KNOWN = (CATEGORY_KEYS as readonly string[]).includes(CATEGORY);

interface Pending {
  article_id: string;
  title: string;
  text: string | null;
  revision: number;
  published_at: Date | null;
  source_name: string;
  tags: string[];
}

/** 认一批（新的在前）；返回认了几篇。一次最多 limit 篇，剩下的下一轮接着认。 */
export async function extractPending(limit = 300): Promise<{ extracted: number }> {
  if (!CATEGORY_KNOWN) return { extracted: 0 };
  const rows = await sql<Pending[]>`
    SELECT p.article_id, a.title, coalesce(a.body_text, a.excerpt) AS text, a.revision, a.published_at, s.name AS source_name, p.tags
    FROM publications p
    JOIN articles a ON a.id = p.article_id
    JOIN sources s ON s.id = p.source_id
    LEFT JOIN tender_facts t ON t.article_id = p.article_id
    WHERE p.category = ${CATEGORY}
      AND (t.article_id IS NULL OR t.revision <> a.revision OR t.version <> ${EXTRACTOR_VERSION})
    ORDER BY p.timeline_at DESC, p.article_id
    LIMIT ${limit}`;
  for (const r of rows) {
    // The article's own title, not the rewritten one: notice wording ("中标结果公告") decides the stage.
    const facts = extractTender({ title: r.title, text: r.text, sourceName: r.source_name, tags: r.tags, publishedAt: r.published_at });
    await sql`
      INSERT INTO tender_facts (article_id, revision, version, stage, region, deadline_at, facts, extracted_at)
      VALUES (${r.article_id}, ${r.revision}, ${EXTRACTOR_VERSION}, ${facts.stage}, ${facts.region}, ${facts.deadline?.value ?? null}, ${sql.json(facts as never)}, now())
      ON CONFLICT (article_id) DO UPDATE SET
        revision = EXCLUDED.revision, version = EXCLUDED.version, stage = EXCLUDED.stage, region = EXCLUDED.region,
        deadline_at = EXCLUDED.deadline_at, facts = EXCLUDED.facts, extracted_at = now()`;
  }
  return { extracted: rows.length };
}
