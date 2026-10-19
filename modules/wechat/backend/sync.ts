// 读一份 JSON Feed（https://www.jsonfeed.org/version/1.1/），按作者（公众号名）分到各自的 external 信源。
// 第一次见到的公众号：新建信源（默认进精选，分级 WECHAT_DEFAULT_TIER，默认 T2），这一批按存量归档，不进“今天”。
import { createHash } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { collapseWhitespace, stripTags } from "@aihot/backend/lib/text";

export const feedUrl = () => process.env.WECHAT_FEED_URL?.trim() || null;

interface FeedItem {
  id?: string;
  url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  date_published?: string;
  date_modified?: string;
  authors?: Array<{ name?: string }>;
  author?: { name?: string };
}

/** 信源 id 只由公众号名决定：同一个号换了订阅服务也还是同一个信源。 */
export function sourceIdFor(account: string): string {
  return `wechat-${createHash("sha256").update(account).digest("hex").slice(0, 12)}`;
}

export function accountOf(item: FeedItem): string | null {
  const name = item.authors?.[0]?.name ?? item.author?.name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : null;
}

export async function syncWechatFeed(url = feedUrl()): Promise<{ accounts: number; received: number; created: number; newSources: number }> {
  if (!url) return { accounts: 0, received: 0, created: 0, newSources: 0 };
  const res = await fetch(url, { headers: { accept: "application/feed+json, application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`wechat feed HTTP ${res.status}`);
  const feed = (await res.json()) as { items?: FeedItem[] };
  const items = Array.isArray(feed.items) ? feed.items : [];
  const tier = process.env.WECHAT_DEFAULT_TIER?.trim() || "T2";

  const byAccount = new Map<string, FeedItem[]>();
  for (const it of items) {
    const account = accountOf(it);
    if (!account || typeof it.url !== "string" || typeof it.title !== "string" || !it.title.trim()) continue;
    byAccount.set(account, [...(byAccount.get(account) ?? []), it]);
  }

  let created = 0;
  let newSources = 0;
  for (const [account, list] of byAccount) {
    const id = sourceIdFor(account);
    const inserted = await sql`
      INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags)
      VALUES (${id}, ${account}, 'external', ${sql.json({ via: "wechat" })}, ${tier}, 'editorial', 30, true, 'ok', ${["公众号"]})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    const fresh = inserted.length > 0;
    if (fresh) newSources += 1;
    const [source] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = ${id}`;
    if (!source?.enabled) continue;

    for (const it of list) {
      const raw = it.content_html ?? "";
      const bodyHtml = raw ? sanitizeBody(raw, it.url) : null;
      const bodyText = bodyHtml ? collapseWhitespace(stripTags(bodyHtml)) : it.content_text ? collapseWhitespace(it.content_text) : null;
      const published = it.date_published ? new Date(it.date_published) : null;
      const r = await upsertMaterial({
        sourceId: id,
        url: it.url!,
        title: collapseWhitespace(it.title!),
        author: account,
        publishedAt: published && Number.isFinite(published.getTime()) ? published : null,
        excerpt: it.summary ? collapseWhitespace(it.summary).slice(0, 2000) : null,
        bodyHtml: bodyText && bodyText.length > 280 ? bodyHtml : null,
        bodyText: bodyText && bodyText.length > 280 ? bodyText : null,
        bodyStatus: bodyText && bodyText.length > 280 ? "ok" : "pending",
        via: "ingest",
        backfill: fresh ? "reported-baseline" : null,
      });
      if (r.created) created += 1;
      if (r.created || r.revised || r.processingNeeded) await queueProcessing(r.articleId);
    }
    await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now() WHERE id = ${id}`;
  }
  return { accounts: byAccount.size, received: items.length, created, newSources };
}
