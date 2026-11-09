// 给天枢的内部接口：按 seq 增量取招采资料（文字、附件链接、抽取结果），以及天枢推来的关注词。
// 只给带令牌的调用方（TENDERS_FEED_TOKEN），不进公开读取层；文字只在公司内部系统之间传，不对外展示。
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "@aihot/backend/db";
import { noticeText, TENDER_TAGS, watchKeywords, type NoticeInput } from "./extract.ts";
import type { Extracted } from "./schema.ts";

const PLACEHOLDER = /^(|changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i;

/** 令牌没配（或是占位值、短于 32 位）时接口不开放。 */
export function feedToken(): string | null {
  const t = process.env.TENDERS_FEED_TOKEN?.trim() ?? "";
  return PLACEHOLDER.test(t) || t.length < 32 ? null : t;
}

export function authorized(req: FastifyRequest): boolean {
  const expected = feedToken();
  if (!expected) return false;
  const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface FeedItem {
  /** 增量游标：资料登记、抽取完成、跳过、失败时都会变大。 */
  seq: string;
  articleId: string;
  url: string;
  title: string;
  source: string;
  sourceTags: string[];
  publishedAt: Date | null;
  discoveredAt: Date;
  /** pending 等待抽取；skipped 不含关注词；done 已抽取；failed 抽取失败（会重试）。 */
  status: "pending" | "skipped" | "done" | "failed";
  /** 是否取得了公告正文；没有时 text 只有标题和摘要。 */
  hasBody: boolean;
  /** 和交给模型的是同一份文字，天枢用它核对原话。 */
  text: string;
  attachments: Array<{ name: string; url: string }>;
  extraction: Extracted | null;
}

const FILE = /\.(pdf|docx?|xlsx?|zip|rar|7z|wps|et)(?:$|[?#])/i;

/** 正文里指向附件的链接（招标文件、清单等）；只给链接，不下载。 */
export function attachmentsOf(html: string | null, base: string): Array<{ name: string; url: string }> {
  if (!html) return [];
  const out = new Map<string, { name: string; url: string }>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try { url = new URL(m[1]!.replace(/&amp;/g, "&"), base).toString(); } catch { continue; }
    if (!/^https?:/.test(url)) continue;
    let name = m[2]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!FILE.test(url) && !/附件|招标文件|采购文件|清单/.test(name)) continue;
    if (!name) {
      name = url.split("/").pop() || "附件";
      try { name = decodeURIComponent(name); } catch { /* 非法百分号保留原文件名，不阻断整页。 */ }
    }
    out.set(url, { name, url });
  }
  return [...out.values()].slice(0, 30);
}

export const FEED_LIMIT = 50;

export async function feedPage(after: string, limit: number): Promise<{ items: FeedItem[]; next: string }> {
  const rows = await sql<Array<{
    seq: string; status: FeedItem["status"]; extraction: Extracted | null; article_id: string; input: NoticeInput;
  }>>`
    SELECT t.seq::text, t.status, t.extraction, t.article_id, t.input
    FROM tender_notices t JOIN articles a ON a.id = t.article_id JOIN sources s ON s.id = a.source_id
    WHERE t.seq > ${after}::bigint AND t.input IS NOT NULL
    ORDER BY t.seq
    LIMIT ${limit}`;
  return {
    items: rows.map((r) => ({
      seq: r.seq, articleId: r.article_id, url: r.input.url, title: r.input.title, source: r.input.source_name, sourceTags: r.input.tags,
      publishedAt: r.input.published_at === null ? null : new Date(r.input.published_at), discoveredAt: new Date(r.input.discovered_at),
      status: r.status, hasBody: r.input.body_status === "ok",
      text: noticeText(r.input), attachments: attachmentsOf(r.input.body_html, r.input.url), extraction: r.status === "done" ? r.extraction : null,
    })),
    next: rows.length ? rows[rows.length - 1]!.seq : after,
  };
}

/** 运行状况：给天枢后台看（登记了多少、抽了多少、关注词几个、哪些信源在供数）。 */
export async function feedStatus() {
  const counts = await sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM tender_notices GROUP BY status`;
  const sources = await sql<{ name: string; enabled: boolean; articles: number; latest: Date | null }[]>`
    SELECT s.name, s.enabled, count(a.id)::int AS articles, max(a.discovered_at) AS latest
    FROM sources s LEFT JOIN articles a ON a.source_id = s.id AND a.discovered_at > now() - interval '30 days'
    WHERE s.tags && ${TENDER_TAGS}::text[]
    GROUP BY s.id ORDER BY s.name`;
  return {
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    keywords: (await watchKeywords()).length,
    sources,
  };
}
