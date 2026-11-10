// 一轮工作：发现新公告 → 取附件并解析 → 筛选 → 推送。定时任务和后台“立即采集一轮”都走这里；
// worker 是单进程，同一时间只跑一轮，后到的这一轮直接跳过（下一个点会再来）。
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { logError } from "@aihot/backend/lib/log-error";
import { collectionOn } from "@aihot/backend/operations/switches";
import type { SourceKey } from "../types.ts";
import { discover, fetcherUrl, fetchNotice, FetcherError } from "./fetcher.ts";
import { pushNotice } from "./push.ts";
import { screenNotice } from "./screen.ts";
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

/** 筛完的公告推送；之前推送明确失败、还在新鲜期的也再试（防重复记录挡住已发出和结果不明的）。 */
async function screenAndPush(): Promise<{ screened: number; pushed: number }> {
  let screened = 0;
  let pushed = 0;
  for (const id of await unscreenedNotices(10)) {
    try {
      if (!("deferred" in (await screenNotice(id)))) screened += 1;
    } catch (error) {
      warn("opportunity screen failed", { noticeId: id, err: logError(error) });
    }
  }
  const due = await sql<{ id: string }[]>`
    SELECT id FROM opp_notices WHERE screened AND NOT backfill AND pushed_at IS NULL AND discovered_at > now() - interval '48 hours'
    ORDER BY discovered_at LIMIT 20`;
  for (const { id } of due) {
    try {
      if ((await pushNotice(id)) === "sent") pushed += 1;
    } catch (error) {
      warn("opportunity push failed", { noticeId: id, err: logError(error) });
    }
  }
  return { screened, pushed };
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

/** 定时（每 20 分钟）：看列表发现新公告，再处理一批。 */
export async function discoverCycle() {
  if (!fetcherUrl()) return { skipped: "fetcher not configured" };
  return once(async () => {
    if (!(await collectionOn())) return { ...(await screenAndPush()), skipped: "collection paused" };
    return { ...(await discoverAll()), ...(await fetchPending()), ...(await screenAndPush()) };
  });
}

/** 定时（每 5 分钟）：取下一批附件、筛选、推送；后台要求过“立即采集一轮”的先看一遍列表。 */
export async function processCycle() {
  if (!fetcherUrl()) return { skipped: "fetcher not configured" };
  return once(async () => {
    if (!(await collectionOn())) return { ...(await screenAndPush()), skipped: "collection paused" };
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
