// 招采公告的抽取：把招采信源（标签“招标”“中标”“招标计划”）的资料登记下来，含关注词的交给模型抽取要素，
// 结果原样存下，天枢按 seq 增量拉取（feed.ts），在天枢那边核对原话、按公司条件初筛。
// 关注词由天枢按商务管理员维护的条件清单推过来（settings 的 tenders.watch）；没有关注词时只登记不抽取，不花钱。
import { sql, type Tx } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@aihot/backend/providers/receipts";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import { ExtractSchema, type Extracted } from "./schema.ts";

/** 信源打了其中一个标签，它的资料都登记。 */
export const TENDER_TAGS = ["招标", "中标", "招标计划"];
/** 只登记最近这么多天发现的资料（第一次启用时不回溯更早的）。 */
const TRACK_DAYS = 30;
const MAX_BODY = 30_000;
const BATCH = 20;
const MAX_ATTEMPTS = 3;
const WATCH_KEY = "tenders.watch";

/** 登记时的输入快照；抽取和 feed 都只读这一版，不拼接实时文章和旧结果。 */
export interface NoticeInput {
  title: string; url: string; excerpt: string | null; body_text: string | null; body_html: string | null; body_status: string;
  published_at: number | null; discovered_at: number; source_name: string; tags: string[];
}

interface Candidate {
  id: string; seq: string; input_hash: string; input: NoticeInput;
}

// PostgreSQL nextval 不随事务回滚，也不按提交排序。worker 和 API/watch 都会写游标，
// 必须在取 seq 前串行化短写事务，避免大 seq 先提交后让下游漏过小 seq；不持锁调模型。
function writeNotices<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('tenders.notices'))`;
    return fn(tx);
  }) as Promise<T>;
}

export async function watchKeywords(): Promise<string[]> {
  const [row] = await sql<{ value: { keywords?: unknown } }[]>`SELECT value FROM settings WHERE key = ${WATCH_KEY}`;
  const list = row?.value?.keywords;
  return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string" && k.trim() !== "") : [];
}

/** 天枢推来新的关注词：存下，近期因不含关注词跳过的资料重新排队。 */
export async function setWatchKeywords(input: unknown): Promise<{ keywords: number; requeued: number }> {
  const raw = (input as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(raw) || raw.length > 500) throw Object.assign(new Error("keywords 要是最多 500 个词的数组"), { statusCode: 400 });
  const keywords = [...new Set(raw.map((k) => String(k).trim()).filter((k) => k.length >= 2 && k.length <= 30))];
  return writeNotices(async (tx) => {
    await tx`INSERT INTO settings (key, value) VALUES (${WATCH_KEY}, ${tx.json({ keywords, updatedAt: new Date().toISOString() } as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    const requeued = await tx`
      UPDATE tender_notices SET status = 'pending', extraction = NULL, receipt_id = NULL, attempts = 0, checked_at = NULL,
        seq = nextval(pg_get_serial_sequence('tender_notices', 'seq'))
      WHERE status = 'skipped' AND created_at > now() - make_interval(days => ${TRACK_DAYS}) RETURNING article_id`;
    return { keywords: keywords.length, requeued: requeued.length };
  });
}

function currentInput(tx: Tx) {
  return tx`jsonb_build_object(
    'title', a.title, 'url', a.url, 'excerpt', a.excerpt, 'body_text', a.body_text, 'body_html', a.body_html,
    'body_status', a.body_status, 'published_at', extract(epoch FROM a.published_at) * 1000,
    'discovered_at', extract(epoch FROM a.discovered_at) * 1000, 'source_name', s.name, 'tags', s.tags)`;
}

/** 登记近期招采资料；已登记的继续追踪修订，包括晚到的正文和 HTML 附件。 */
export async function track(): Promise<number> {
  return writeNotices(async (tx) => {
    const rows = await tx`
      INSERT INTO tender_notices (article_id, input)
      SELECT a.id, ${currentInput(tx)}
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE (s.tags && ${TENDER_TAGS}::text[] AND a.discovered_at > now() - make_interval(days => ${TRACK_DAYS}))
        OR EXISTS (SELECT 1 FROM tender_notices t WHERE t.article_id = a.id)
      ON CONFLICT (article_id) DO UPDATE SET input = EXCLUDED.input,
        status = 'pending', extraction = NULL, receipt_id = NULL, attempts = 0, checked_at = NULL,
        seq = EXCLUDED.seq
      WHERE tender_notices.input IS DISTINCT FROM EXCLUDED.input
      RETURNING article_id`;
    return rows.length;
  });
}

/** 等正文：正文还在抓的先不抽，发现两小时后还没有正文就用标题和摘要抽。 */
async function candidates(): Promise<Candidate[]> {
  return sql<Candidate[]>`
    SELECT t.article_id AS id, t.seq::text, md5(t.input::text) AS input_hash, t.input
    FROM tender_notices t JOIN articles a ON a.id = t.article_id
    WHERE t.input IS NOT NULL
      AND (t.status = 'pending' OR (t.status = 'failed' AND t.attempts < ${MAX_ATTEMPTS} AND t.checked_at < now() - interval '6 hours'))
      AND (t.input->>'body_status' <> 'pending' OR a.discovered_at < now() - interval '2 hours')
    ORDER BY a.discovered_at DESC
    LIMIT ${BATCH}`;
}

/** 输入、关注词和领取时的状态都没变才落库；旧任务（包括失败、跳过）不能覆盖新版本。 */
async function saveResult(c: Candidate, keywords: readonly string[], status: "done" | "skipped" | "failed", out: Extracted | null = null, receiptId: number | null = null): Promise<boolean> {
  return writeNotices(async (tx) => {
    const rows = await tx`
      UPDATE tender_notices SET status = ${status}, extraction = ${out === null ? null : tx.json(out as never)}, receipt_id = ${receiptId},
        attempts = attempts + ${status === "failed" ? 1 : 0}, checked_at = now(),
        seq = nextval(pg_get_serial_sequence('tender_notices', 'seq'))
      WHERE article_id = ${c.id} AND md5(input::text) = ${c.input_hash} AND seq = ${c.seq}::bigint
        AND coalesce((SELECT value->'keywords' FROM settings WHERE key = ${WATCH_KEY}), '[]'::jsonb) = ${tx.json([...keywords])}
        AND EXISTS (SELECT 1 FROM articles a JOIN sources s ON s.id = a.source_id
          WHERE a.id = tender_notices.article_id AND ${currentInput(tx)} = tender_notices.input)
      RETURNING article_id`;
    return rows.length > 0;
  });
}

/** 关注词出现在标题、摘要或正文里（不区分全半角和大小写）。 */
export function mentions(c: Pick<NoticeInput, "title" | "excerpt" | "body_text">, keywords: readonly string[]): boolean {
  const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const text = norm(`${c.title}\n${c.excerpt ?? ""}\n${c.body_text ?? ""}`);
  return keywords.some((k) => text.includes(norm(k)));
}

/** 公告的文字：标题、摘要和正文。给模型的和天枢用来核对原话的是同一份。 */
export function noticeText(c: Pick<NoticeInput, "title" | "excerpt" | "body_text">): string {
  return [c.title, c.excerpt && !c.body_text?.includes(c.excerpt) ? c.excerpt : null, c.body_text].filter(Boolean).join("\n");
}

export async function readNotice(candidate: Candidate): Promise<{ out: Extracted; receiptId: number }> {
  const c = candidate.input;
  const text = noticeText(c);
  const body = text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n（后文未提供）` : text;
  const user = [
    `【来源】${c.source_name}`,
    `【发布时间】${c.published_at === null ? "未知" : new Date(c.published_at).toISOString()}`,
    `【原文地址】${c.url}`,
    c.body_status === "ok" ? null : "【说明】没有取得公告正文，下面只有标题和摘要。",
    `【公告】\n${body}`,
  ].filter(Boolean).join("\n");
  const res = await chatJson({
    model: await modelFor("tenders"),
    purpose: "tender_extract",
    subject: `article:${candidate.id}`,
    attemptTag: candidate.input_hash,
    promptVersion: promptVersion("tender-extract"),
    system: promptText("tender-extract"),
    user,
    schema: ExtractSchema,
    temperature: 0.1,
    maxTokens: 6000,
  });
  return { out: res.data, receiptId: res.receiptId };
}

/** 定时任务：登记新资料，再处理一小批。模型调用关着时只登记。 */
export async function extractPending(): Promise<{ tracked: number; checked: number; extracted: number; skipped: number; failed: number }> {
  const tracked = await track();
  const result = { tracked, checked: 0, extracted: 0, skipped: 0, failed: 0 };
  if (!(await modelCallsOn())) return result;
  const keywords = await watchKeywords();
  const list = await candidates();
  for (const c of list) {
    result.checked += 1;
    if (!mentions(c.input, keywords)) {
      if (await saveResult(c, keywords,"skipped")) result.skipped += 1;
      continue;
    }
    try {
      const { out, receiptId } = await readNotice(c);
      if (await saveResult(c, keywords,"done", out, receiptId)) result.extracted += 1;
    } catch (error) {
      // 服务拒绝（余额不足、限流）、预算熔断、回执占用：不是这篇的问题，整批停下，下次再来，不计失败次数。
      if (error instanceof ProviderRejectedError || error instanceof BudgetExceededError || error instanceof ReceiptBusyError) break;
      if (await saveResult(c, keywords,"failed")) result.failed += 1;
      console.error(JSON.stringify({ level: "warn", msg: "tender extract failed", articleId: c.id, err: logError(error) }));
    }
  }
  return result;
}
