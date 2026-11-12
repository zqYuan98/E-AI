// 一轮工作：发现国网新公告 → 取附件并解析；登记其他招采平台的新资料 → 筛选 → 抽要素 → 推送。定时任务和后台“立即采集一轮”都走这里；
// worker 是单进程，同一时间只跑一轮，后到的这一轮直接跳过（下一个点会再来）。
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { logError } from "@aihot/backend/lib/log-error";
import { collectionOn } from "@aihot/backend/operations/switches";
import type { SourceKey } from "../types.ts";
import { discover, fetcherUrl, fetchNotice, FetcherError } from "./fetcher.ts";
import { trackArticles } from "./articles.ts";
import { extractDetails, MAX_DETAIL_FAILURES } from "./details.ts";
import { MAX_PUSH_ATTEMPTS, pushNotice } from "./push.ts";
import { screenNotice, screenWebItems } from "./screen.ts";
import { hasNotices, markFailed, pendingNotices, saveFetched, unscreenedNotices, upsertDiscovered } from "./store.ts";

const SOURCES: SourceKey[] = ["ecp", "etp"];
const CATEGORIES = ["procurement", "tender"] as const;
/** 每个栏目每轮看列表最前面的这么多条；两轮之间新发的公告远少于这个数。 */
const LIST_LIMIT = 20;
/** 每轮最多取几份附件（每份要开一次浏览器，几十秒）。 */
const FETCH_PER_RUN = 4;
const RUN_KEY = "opportunities.run_requested";

let running = false;

const warn = (msg: string, extra: Record<string, unknown>) => console.error(JSON.stringify({ level: "warn", msg, ...extra }));

async function discoverAll(): Promise<{ discovered: number; failed: number }> {
  let discovered = 0;
  let failed = 0;
  for (const source of SOURCES) {
    // 一个来源第一次采集时列表上已有的都是存量：入库、可查，但不实时推送。
    const backfill = !(await hasNotices(source));
    for (const category of CATEGORIES) {
      try {
        discovered += await upsertDiscovered(await discover(source, category, LIST_LIMIT), backfill);
      } catch (error) {
        failed += 1;
        warn("opportunity discovery failed", { source, category, code: error instanceof FetcherError ? error.code : "error", err: logError(error) });
        // 来源整个打不开、限流或要验证时，这个来源本轮不再试别的栏目。
        if (error instanceof FetcherError && ["network", "rate_limit", "captcha", "busy"].includes(error.code)) break;
      }
    }
  }
  return { discovered, failed };
}

async function fetchPending(): Promise<{ fetched: number; failed: number }> {
  let fetched = 0;
  let failed = 0;
  for (const n of await pendingNotices(FETCH_PER_RUN)) {
    try {
      await saveFetched(n.id, await fetchNotice(n.url));
      fetched += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof FetcherError ? error.code : "error";
      await markFailed(n.id, code, error instanceof Error ? error.message : String(error));
      warn("opportunity fetch failed", { noticeId: n.id, code, err: logError(error) });
      if (["network", "rate_limit", "captcha", "busy", "not_configured"].includes(code)) break;
    }
  }
  return { fetched, failed };
}

/** 筛选、抽要素，然后推送。推送等要素抽完；模型不行时最多等到取到附件 6 小时，不让推送一直等。 */
async function screenAndPush(): Promise<Record<string, unknown>> {
  let screened = 0;
  let pushed = 0;
  let tracked = 0;
  try {
    tracked = await trackArticles();
  } catch (error) {
    warn("opportunity article tracking failed", { err: logError(error) });
  }
  for (const id of await unscreenedNotices(10)) {
    try {
      if (!("deferred" in (await screenNotice(id)))) screened += 1;
    } catch (error) {
      warn("opportunity screen failed", { noticeId: id, err: logError(error) });
    }
  }
  let web = { screened: 0, relevant: 0, deferred: 0 };
  try {
    web = await screenWebItems();
  } catch (error) {
    warn("opportunity web screen failed", { err: logError(error) });
  }
  let details = { extracted: 0, failed: 0 };
  try {
    details = await extractDetails();
  } catch (error) {
    warn("opportunity details failed", { err: logError(error) });
  }
  // 还没推完的，或者有群明确失败、还能再试的。
  const due = await sql<{ id: string }[]>`
    SELECT id FROM opp_notices n
    WHERE screened AND NOT backfill AND discovered_at > now() - interval '48 hours'
      AND (pushed_at IS NULL OR EXISTS (SELECT 1 FROM opp_pushes p JOIN opp_push_groups g ON p.key = 'g' || g.id || ':notice:' || n.id
        WHERE p.status = 'failed' AND p.attempts < ${MAX_PUSH_ATTEMPTS}))
      AND EXISTS (SELECT 1 FROM opp_items i WHERE i.notice_id = n.id AND (i.verdict = 'relevant' OR (i.verdict = 'maybe' AND n.source <> 'web')))
      AND (details IS NOT NULL OR doc_text = '' OR details_failures >= ${MAX_DETAIL_FAILURES} OR fetched_at < now() - interval '6 hours')
    ORDER BY discovered_at LIMIT 20`;
  for (const { id } of due) {
    try {
      if ((await pushNotice(id)) === "sent") pushed += 1;
    } catch (error) {
      warn("opportunity push failed", { noticeId: id, err: logError(error) });
    }
  }
  return { tracked, screened, webScreened: web.screened, webRelevant: web.relevant, webDeferred: web.deferred, ...details, pushed };
}

async function once<T>(work: () => Promise<T>): Promise<T | { skipped: string }> {
  if (running) return { skipped: "another run is in progress" };
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}

/** 定时（每 20 分钟）：看国网列表发现新公告，再处理一批。 */
export async function discoverCycle() {
  if (!fetcherUrl()) return { skipped: "fetcher not configured" };
  return once(async () => {
    if (!(await collectionOn())) return { ...(await screenAndPush()), skipped: "collection paused" };
    return { ...(await discoverAll()), ...(await fetchPending()), ...(await screenAndPush()) };
  });
}

/**
 * 定时（每 5 分钟）：取下一批国网附件，登记其他招采平台的新资料，筛选、抽要素、推送。
 * 后台要求过“立即采集一轮”的先看一遍国网列表。没配采集服务时只处理其他平台的资料。
 */
export async function processCycle() {
  return once(async () => {
    if (!fetcherUrl() || !(await collectionOn())) {
      return { ...(await screenAndPush()), skipped: fetcherUrl() ? "collection paused" : "fetcher not configured" };
    }
    const [asked] = await sql`DELETE FROM settings WHERE key = ${RUN_KEY} RETURNING key`;
    return { ...(asked ? await discoverAll() : {}), ...(await fetchPending()), ...(await screenAndPush()) };
  });
}

/** 后台“立即采集一轮”：记下请求，worker 在 5 分钟内的下一次处理时先看列表（采集只在 worker 里跑）。 */
export async function requestRun(reason: string, actor: string): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${RUN_KEY}, ${sql.json({ at: new Date().toISOString() } as never)}, ${actor})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await audit(actor, "opportunities.run", "opportunities:run", reason || null, null, null);
}
