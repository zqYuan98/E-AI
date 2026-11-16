// 资格初审：有相关或待确认项目的公告，把每个项目的资质、业绩、人员要求（requirements.ts）逐条和各投标主体的条件对比
// （集团下各公司分开：资质从宜搭同步，人员、业绩和其他后台手填，见 company.ts）。模型对每条要求说出哪些主体满足、哪些不满足，
// 没说到的算需核实；程序据此挑出最合适的主体、算匹配度。等公告要素抽完再比（公告通用要求要算进去）。
// 条件变了（同步到新资质、资质过期、手填改了）以后，还没截止的项目重新比；已截止的不再比。什么条件都没有时不比，也清掉旧结果。
// 一份公告一次调用（项目多时每 20 个一批）。模型漏答的项目这次不记，公告记一次失败，到 3 次不再自动试。
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@aihot/backend/providers/receipts";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import { REQUIREMENT_GROUP_LABELS, type NoticeDetails } from "../types.ts";
import { entitiesKey, loadEntities, type Entity } from "./company.ts";
import { itemRequirements, requirementsHash, type StoredMatch } from "./requirements.ts";
import { deadlineOf, detailsSettled, isExpired, type ItemRow } from "./store.ts";

/** 每轮最多调用几次模型，一次最多几个项目，每条要求最多给模型多少字。 */
const PER_RUN = 4;
const CHUNK = 20;
const REQ_CHARS = 400;
export const MAX_MATCH_FAILURES = 3;

const Answer = z.object({
  items: z.array(z.object({
    n: z.number().int(),
    checks: z.array(z.object({
      r: z.number().int(),
      met: z.array(z.number().int()).max(100).catch([]),
      unmet: z.array(z.number().int()).max(100).catch([]),
      note: z.string().max(100).catch(""),
    }).nullable().catch(null)).max(100).catch([]),
  }).nullable().catch(null)).max(CHUNK * 2).catch([]),
});

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function entitiesText(entities: Entity[]): string {
  const part = (label: string, lines: string[]) => `${label}：${lines.length ? `\n${lines.map((l) => `- ${l}`).join("\n")}` : "（未填写）"}`;
  return ["【我司资质】", ...entities.map((e, k) => [
    `主体${k + 1}：${e.company}`, part("资质证书", e.qualifications), part("人员证书", e.personnel), part("业绩", e.performance), part("其他", e.other),
  ].join("\n"))].join("\n\n");
}

type Todo = { item: ItemRow; reqs: ReturnType<typeof itemRequirements> };

function itemsText(chunk: Todo[]): string {
  return chunk.map(({ item, reqs }, k) => [
    `#${k + 1} 项目：${item.project_name}${item.package ? `（${item.package}）` : ""}`,
    ...reqs.map((r, j) => `${j + 1}. [${REQUIREMENT_GROUP_LABELS[r.group]}] ${short(r.text, REQ_CHARS)}`),
  ].join("\n")).join("\n\n");
}

/** 一批项目问一次；返回每个答到的项目的对比结果（没说到的主体按需核实，主体编号转成下标）。 */
async function ask(subject: string, key: string, entities: Entity[], chunk: Todo[], model: string): Promise<Map<string, StoredMatch>> {
  const user = `${entitiesText(entities)}\n\n【项目】\n${itemsText(chunk)}`;
  const res = await chatJson({
    model,
    purpose: "opportunity_match",
    subject,
    attemptTag: createHash("sha256").update(`${key}\n${user}`).digest("hex").slice(0, 16),
    promptVersion: promptVersion("opportunity-match"),
    system: promptText("opportunity-match"),
    user,
    schema: Answer,
    temperature: 0.1,
    maxTokens: 8000,
  });
  const index = (ns: number[]) => [...new Set(ns.map((n) => n - 1).filter((k) => k >= 0 && k < entities.length))];
  const out = new Map<string, StoredMatch>();
  for (const a of res.data.items) {
    const todo = a && chunk[a.n - 1];
    if (!todo || out.has(todo.item.id)) continue;
    const byR = new Map(a.checks.filter((c) => c !== null).map((c) => [c.r, c]));
    out.set(todo.item.id, {
      reqs: requirementsHash(todo.reqs),
      companies: entities.map((e) => e.company),
      checks: todo.reqs.map((_, j) => {
        const c = byR.get(j + 1);
        const unmet = c ? index(c.unmet) : [];
        return { met: c ? index(c.met).filter((k) => !unmet.includes(k)) : [], unmet, note: c ? short(c.note, 40) : "" };
      }),
    });
  }
  return out;
}

interface Candidate { id: string; details: NoticeDetails | null; file_deadline: string }

export async function matchRequirements(now = new Date()): Promise<{ matched: number; matchFailed: number }> {
  const result = { matched: 0, matchFailed: 0 };
  const entities = await loadEntities(now);
  const key = entitiesKey(entities);
  if (!key) {
    await sql`UPDATE opp_items SET match = NULL, match_key = '' WHERE match_key <> ''`;
    return result;
  }
  if (!(await modelCallsOn())) return result;
  const notices = await sql<Candidate[]>`
    SELECT id, details, file_deadline FROM opp_notices n
    WHERE screened AND match_failures < ${MAX_MATCH_FAILURES} AND discovered_at > now() - interval '30 days' AND ${detailsSettled()}
      AND EXISTS (SELECT 1 FROM opp_items i WHERE i.notice_id = n.id AND i.verdict IN ('relevant', 'maybe') AND i.match_key <> ${key})
    ORDER BY discovered_at DESC LIMIT 20`;
  let model: string | null = null;
  let calls = 0;
  for (const n of notices) {
    if (calls >= PER_RUN) break;
    const items = await sql<ItemRow[]>`SELECT *, id::text AS id FROM opp_items
      WHERE notice_id = ${n.id} AND verdict IN ('relevant', 'maybe') AND match_key <> ${key} ORDER BY ordinal`;
    // 已截止的不再比（留着旧结果）；没有要求可比的直接记下（没有匹配度）。
    const expired = isExpired(deadlineOf(n), now);
    const todo = expired ? [] : items.map((item) => ({ item, reqs: itemRequirements(item, n.details) })).filter((t) => t.reqs.length > 0);
    const skip = items.filter((i) => !todo.some((t) => t.item.id === i.id)).map((i) => i.id);
    if (skip.length) {
      await sql`UPDATE opp_items SET match = CASE WHEN ${expired} THEN match END, match_key = ${key} WHERE id = ANY(${skip}::bigint[])`;
    }
    if (!todo.length) continue;
    calls += 1;
    model ??= await modelFor("opportunities");
    try {
      let missed = false;
      for (let start = 0, index = 0; start < todo.length; start += CHUNK, index += 1) {
        const chunk = todo.slice(start, start + CHUNK);
        const answers = await ask(`opportunity:${n.id}:match:${index}`, key, entities, chunk, model);
        for (const t of chunk) {
          const m = answers.get(t.item.id);
          if (!m) { missed = true; continue; }
          await sql`UPDATE opp_items SET match = ${sql.json(m as never)}, match_key = ${key} WHERE id = ${t.item.id}::bigint`;
          result.matched += 1;
        }
      }
      if (missed) await sql`UPDATE opp_notices SET match_failures = match_failures + 1 WHERE id = ${n.id}`;
    } catch (error) {
      console.error(JSON.stringify({ level: "warn", msg: "opportunity match failed", noticeId: n.id, err: logError(error) }));
      // 服务拒绝（余额、限流）、预算熔断、回执占用：不是这份公告的问题，整批停下，下一轮再来，不计失败次数。
      if (error instanceof ProviderRejectedError || error instanceof BudgetExceededError || error instanceof ReceiptBusyError) break;
      await sql`UPDATE opp_notices SET match_failures = match_failures + 1 WHERE id = ${n.id}`;
      result.matchFailed += 1;
    }
  }
  return result;
}
